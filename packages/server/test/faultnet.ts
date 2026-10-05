// A fault-injecting network for tests: wraps the real WebSocket used by
// TandemConnection and, driven by a seeded PRNG (reproducible runs), can
//   * delay frames (per direction, preserving order like TCP),
//   * duplicate document frames (Update, Sync2, Ack),
//   * reorder adjacent Update frames,
//   * drop document frames without closing the connection (a lossy
//     middlebox; recovery must come from ack timeouts and anti-entropy),
//   * kill the connection at random,
//   * cut the network completely (offline) and restore it.
// Control frames (Hello, Join, ...) are only delayed: corrupting them would
// test the handshake, not the synchronization invariants.
import { decode, MsgType } from "@tandem/protocol";
import type { WebSocketLike } from "@tandem/protocol/client";
import { WebSocket } from "ws";

export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Faults {
  maxDelayMs: number;
  duplicate: number; // probability per document frame
  reorder: number; // probability that an Update is held back behind the next one
  drop: number; // probability per document frame
  kill: number; // probability per frame that the connection is killed
}

export const NO_FAULTS: Faults = { maxDelayMs: 0, duplicate: 0, reorder: 0, drop: 0, kill: 0 };

export class FaultStats {
  delayed = 0;
  duplicated = 0;
  reordered = 0;
  dropped = 0;
  killed = 0;
}

const DOC_TYPES = new Set([MsgType.Update, MsgType.Sync2, MsgType.Ack]);

function typeOf(frame: Uint8Array): MsgType | undefined {
  try {
    return decode(frame).type;
  } catch {
    return undefined; // a fragment of a large message, etc.
  }
}

export class FaultyNetwork {
  online = true;
  readonly stats = new FaultStats();
  private sockets = new Set<FaultySocket>();
  constructor(
    readonly rand: () => number,
    public faults: Faults,
    private readonly headers: Record<string, string>,
  ) {}

  factory = (url: string): WebSocketLike => {
    const s = new FaultySocket(url, this);
    this.sockets.add(s);
    return s;
  };

  setOnline(on: boolean) {
    this.online = on;
    if (!on) for (const s of this.sockets) s.kill();
  }

  /** @internal */
  wsHeaders() {
    return this.headers;
  }
  /** @internal */
  forget(s: FaultySocket) {
    this.sockets.delete(s);
  }
}

class Direction {
  private nextAt = 0;
  private held: Uint8Array | undefined;
  constructor(
    private readonly net: FaultyNetwork,
    private readonly deliver: (f: Uint8Array) => void,
    private readonly alive: () => boolean,
  ) {}

  push(frame: Uint8Array) {
    const f = this.net.faults;
    const r = this.net.rand;
    const type = typeOf(frame);
    const isDoc = type !== undefined && DOC_TYPES.has(type);
    if (isDoc && r() < f.drop) {
      this.net.stats.dropped++;
      return;
    }
    if (type === MsgType.Update && !this.held && r() < f.reorder) {
      this.held = frame; // goes out after the next frame
      this.net.stats.reordered++;
      return;
    }
    this.schedule(frame);
    if (isDoc && r() < f.duplicate) {
      this.net.stats.duplicated++;
      this.schedule(frame);
    }
    if (this.held) {
      const h = this.held;
      this.held = undefined;
      this.schedule(h);
    }
  }

  private schedule(frame: Uint8Array) {
    const delay = this.net.faults.maxDelayMs > 0 ? this.net.rand() * this.net.faults.maxDelayMs : 0;
    if (delay > 0) this.net.stats.delayed++;
    const now = Date.now();
    this.nextAt = Math.max(this.nextAt, now + delay);
    const at = this.nextAt - now;
    if (at <= 0) this.deliver(frame);
    else
      setTimeout(() => {
        if (this.alive()) this.deliver(frame);
      }, at);
  }

  flushHeld() {
    if (this.held) this.schedule(this.held);
    this.held = undefined;
  }
}

export class FaultySocket implements WebSocketLike {
  binaryType = "arraybuffer";
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  private ws: WebSocket | undefined;
  private closed = false;
  private up: Direction;
  private down: Direction;

  constructor(url: string, private readonly net: FaultyNetwork) {
    const alive = () => !this.closed;
    this.up = new Direction(net, (f) => this.ws?.readyState === WebSocket.OPEN && this.ws.send(f), alive);
    this.down = new Direction(net, (f) => this.onmessage?.({ data: f }), alive);
    if (!net.online) {
      setTimeout(() => this.finish(1006, "network down"), 5);
      return;
    }
    const ws = new WebSocket(url, { headers: net.wsHeaders() });
    this.ws = ws;
    ws.binaryType = "nodebuffer";
    ws.on("open", () => !this.closed && this.onopen?.({}));
    ws.on("message", (d: Buffer) => {
      if (this.closed) return;
      if (this.net.rand() < this.net.faults.kill) {
        this.net.stats.killed++;
        return this.kill();
      }
      this.down.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice());
    });
    ws.on("close", (code, reason) => this.finish(code, reason.toString()));
    ws.on("error", () => {
      /* followed by close */
    });
  }

  get readyState(): number {
    return this.closed ? 3 : (this.ws?.readyState ?? 0);
  }

  send(data: Uint8Array) {
    if (this.closed) return;
    if (this.net.rand() < this.net.faults.kill) {
      this.net.stats.killed++;
      return this.kill();
    }
    this.up.push(data);
  }

  close(code?: number, reason?: string) {
    this.up.flushHeld();
    this.ws?.close(code, reason);
    this.finish(code ?? 1000, reason ?? "");
  }

  /** Abrupt loss: the server notices via TCP reset (not a close handshake). */
  kill() {
    this.ws?.terminate();
    this.finish(1006, "killed");
  }

  private finish(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.net.forget(this);
    this.onclose?.({ code, reason });
  }
}
