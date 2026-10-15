import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { decode, encode, encodeFrames, encodeVersion1Error, ErrorCode, LIMITS, type Message, MsgType, ProtocolError, Reassembler, Role } from "../src/index.js";

const bytes = (max = 64) => fc.uint8Array({ maxLength: max });
const ch = fc.integer({ min: 0, max: LIMITS.maxChannel });
const docId = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/);
const role = fc.constantFrom(Role.Viewer, Role.Editor, Role.Owner);

const message: fc.Arbitrary<Message> = fc.oneof(
  fc.record({ type: fc.constant(MsgType.Join as const), ch, docId }),
  fc.record({ type: fc.constant(MsgType.Joined as const), ch, docId, role }),
  fc.record({ type: fc.constant(MsgType.Leave as const), ch }),
  fc.record({ type: fc.constant(MsgType.Sync1 as const), ch, stateVector: bytes() }),
  fc.record({ type: fc.constant(MsgType.Sync2 as const), ch, update: bytes() }),
  fc.record({ type: fc.constant(MsgType.Update as const), ch, seq: fc.nat(), update: bytes() }),
  fc.record({ type: fc.constant(MsgType.Ack as const), ch, seq: fc.nat() }),
  fc.record({ type: fc.constant(MsgType.Awareness as const), ch, payload: bytes() }),
  fc.record({
    type: fc.constant(MsgType.Error as const),
    ch,
    code: fc.constantFrom(...(Object.values(ErrorCode).filter((v) => typeof v === "number") as ErrorCode[])),
    ref: fc.nat(),
    message: fc.string({ maxLength: 100 }),
  }),
  fc.record({ type: fc.constant(MsgType.Hello as const), sessionId: fc.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), resume: fc.nat() }),
  fc.record({
    type: fc.constant(MsgType.Welcome as const),
    connectionId: fc.stringMatching(/^[a-f0-9-]{1,36}$/),
    heartbeatMs: fc.nat(),
    maxMessageBytes: fc.nat(),
    msgRatePerSec: fc.nat(),
    byteRatePerSec: fc.nat(),
    byteBurst: fc.nat(),
  }),
  fc
    .record({ type: fc.constant(MsgType.Fragment as const), id: fc.nat(), count: fc.integer({ min: 2, max: 100 }), index: fc.nat(), bytes: bytes() })
    .map((f) => ({ ...f, index: f.index % f.count })),
  fc.record({ type: fc.constant(MsgType.Ping as const), nonce: fc.nat() }),
  fc.record({ type: fc.constant(MsgType.Pong as const), nonce: fc.nat() }),
  fc.record({ type: fc.constant(MsgType.RoleChanged as const), ch, role }),
);

describe("codec", () => {
  it("round-trips every message", () => {
    fc.assert(
      fc.property(message, (m) => {
        expect(decode(encode(m))).toEqual(m);
      }),
      { numRuns: 2000 },
    );
  });

  it("never throws anything but ProtocolError on arbitrary bytes (fuzz)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (b) => {
        try {
          decode(b);
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 20000 },
    );
  });

  it("rejects mutated valid frames cleanly (fuzz)", () => {
    fc.assert(
      fc.property(message, fc.nat(), fc.integer({ min: 0, max: 255 }), (m, pos, val) => {
        const f = encode(m);
        f[pos % f.length] = val;
        try {
          decode(f);
        } catch (e) {
          expect(e).toBeInstanceOf(ProtocolError);
        }
      }),
      { numRuns: 20000 },
    );
  });

  it("rejects truncation, trailing bytes, wrong version, bad ids and oversized payloads", () => {
    const f = encode({ type: MsgType.Update, ch: 1, seq: 5, update: new Uint8Array([1, 2, 3]) });
    for (let n = 0; n < f.length; n++) expect(() => decode(f.slice(0, n))).toThrow(ProtocolError);
    expect(() => decode(new Uint8Array([...f, 0]))).toThrow(/trailing/);
    const v = f.slice();
    v[0] = 1;
    expect(() => decode(v)).toThrow(/version/);
    try {
      decode(v);
    } catch (e) {
      expect((e as ProtocolError).version).toBe(1);
    }
    expect(() => decode(encode({ type: MsgType.Join, ch: 1, docId: "../etc" }))).toThrow(/document id/);
    const big = encode({ type: MsgType.Awareness, ch: 1, payload: new Uint8Array(LIMITS.maxAwarenessBytes + 1) });
    expect(() => decode(big)).toThrow(/too large/);
    expect(() => decode(new Uint8Array([2, 200]))).toThrow(/unknown message type/);
  });
});

describe("fragmentation", () => {
  const nextId = (() => {
    let i = 1;
    return () => i++;
  })();

  it("splits large Sync2/Update messages and reassembles them exactly", () => {
    for (const size of [LIMITS.maxFrameBytes - 100, LIMITS.maxFrameBytes + 1, 3 * LIMITS.maxFrameBytes + 12345]) {
      const update = new Uint8Array(size).map((_, i) => (i * 31) & 255);
      const m: Message = { type: MsgType.Update, ch: 3, seq: 9, update };
      const frames = encodeFrames(m, nextId);
      for (const f of frames) expect(f.length).toBeLessThanOrEqual(LIMITS.maxFrameBytes);
      if (frames.length === 1) {
        expect(decode(frames[0]!)).toEqual(m);
        continue;
      }
      const r = new Reassembler(4 * LIMITS.maxFrameBytes);
      let out: Message | undefined;
      frames.forEach((f, i) => {
        const d = decode(f);
        expect(d.type).toBe(MsgType.Fragment);
        out = r.add(d as Extract<Message, { type: MsgType.Fragment }>);
        if (i < frames.length - 1) expect(out).toBeUndefined();
      });
      // Compare the payload with Buffer.equals: a deep toEqual over a
      // multi-megabyte Uint8Array takes over a minute on a busy machine.
      const got = out as Extract<Message, { type: MsgType.Update }>;
      expect({ ...got, update: undefined }).toEqual({ ...m, update: undefined });
      expect(Buffer.from(got.update).equals(Buffer.from(update))).toBe(true);
      expect(r.bufferedBytes).toBe(0);
    }
  });

  it("refuses oversized, interleaved, reordered and non-document fragmented messages", () => {
    const big: Message = { type: MsgType.Sync2, ch: 1, update: new Uint8Array(2 * LIMITS.maxFrameBytes) };
    const frames = encodeFrames(big, nextId).map((f) => decode(f) as Extract<Message, { type: MsgType.Fragment }>);
    // Too large for the receiver's limit: refused at the first fragment.
    expect(() => new Reassembler(LIMITS.maxFrameBytes).add(frames[0]!)).toThrow(/too large/);
    // Out of order.
    const r1 = new Reassembler(4 * LIMITS.maxFrameBytes);
    r1.add(frames[0]!);
    expect(() => r1.add(frames[2]!)).toThrow(/out of sequence/);
    // A second message starting before the first one finished.
    const r2 = new Reassembler(4 * LIMITS.maxFrameBytes);
    r2.add(frames[0]!);
    expect(() => r2.add({ ...frames[0]!, id: 999 })).toThrow(/interrupted/);
    // Only document messages may be fragmented.
    expect(() => encodeFrames({ type: MsgType.Awareness, ch: 1, payload: new Uint8Array(2 * LIMITS.maxFrameBytes) }, nextId)).toThrow(ProtocolError);
    const r3 = new Reassembler(4 * LIMITS.maxFrameBytes);
    const inner = encode({ type: MsgType.Ping, nonce: 1 });
    const padded = new Uint8Array(LIMITS.fragmentBytes + inner.length);
    padded.set(inner);
    // A fragmented Ping (with trailing bytes) is rejected either way.
    r3.add({ type: MsgType.Fragment, id: 1, index: 0, count: 2, bytes: padded.subarray(0, LIMITS.fragmentBytes) });
    expect(() => r3.add({ type: MsgType.Fragment, id: 1, index: 1, count: 2, bytes: padded.subarray(LIMITS.fragmentBytes) })).toThrow(ProtocolError);
  });

  it("encodes a version-1 error for outdated clients", () => {
    const f = encodeVersion1Error(ErrorCode.UnsupportedVersion, "reload");
    expect(f[0]).toBe(1);
    expect(f[1]).toBe(MsgType.Error);
    expect(() => decode(f)).toThrow(/version/);
  });
});
