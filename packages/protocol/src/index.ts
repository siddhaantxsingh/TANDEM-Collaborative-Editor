// Tandem wire protocol, version 2. See docs/PROTOCOL.md.
//
// Every WebSocket message is one binary frame:
//   [u8 protocol version = 2][u8 message type][payload]
// Integers are lib0 varUints, strings are lib0 varStrings (length-prefixed
// UTF-8), byte arrays are lib0 varUint8Arrays. One connection multiplexes
// several documents through client-chosen channel numbers.
//
// The same codec is used by the browser and the server. decode() validates
// every field and size and throws ProtocolError on anything malformed; it
// never returns a partially valid message.
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export const PROTOCOL_VERSION = 2;

export enum MsgType {
  Join = 1, // C->S: open a document on a channel
  Joined = 2, // S->C: document opened, with the caller's role
  Leave = 3, // C->S: close a channel
  Sync1 = 4, // both: my state vector (send me what I am missing)
  Sync2 = 5, // both: the update you are missing
  Update = 6, // both: incremental document update
  Ack = 7, // S->C: client update `seq` is durably stored
  Awareness = 8, // both: presence (cursor, selection, user info)
  Error = 9, // S->C: error on a channel (0 = whole connection)
  Ping = 10, // both
  Pong = 11, // both
  RoleChanged = 12, // S->C: caller's role on a channel changed
  Hello = 13, // C->S: first message of a connection (protocol handshake)
  Welcome = 14, // S->C: answer to Hello: connection id and server limits
  Fragment = 15, // both: one part of a message larger than one frame
}

export enum Role {
  Viewer = 1,
  Editor = 2,
  Owner = 3,
}

export const roleName = (r: Role): "VIEWER" | "EDITOR" | "OWNER" =>
  r === Role.Owner ? "OWNER" : r === Role.Editor ? "EDITOR" : "VIEWER";

export const parseRole = (s: string): Role | undefined =>
  s === "OWNER" ? Role.Owner : s === "EDITOR" ? Role.Editor : s === "VIEWER" ? Role.Viewer : undefined;

export const canEdit = (r: Role): boolean => r >= Role.Editor;

export enum ErrorCode {
  BadMessage = 1, // malformed frame; the connection is closed
  Unauthorized = 2, // not logged in / session expired
  Forbidden = 3, // no access to the document or not allowed to edit
  NotFound = 4, // unknown document
  RateLimited = 5, // too many messages or bytes
  TooLarge = 6, // message or document exceeds a limit
  Internal = 7, // server error; retry
  ChannelInUse = 8, // channel number already open
  Overloaded = 9, // server refused new work (backpressure); reconnect later
  UnsupportedVersion = 10, // the client speaks another protocol version; reload the app
}

export const LIMITS = {
  maxFrameBytes: 1024 * 1024, // one WebSocket frame, either direction
  fragmentBytes: 256 * 1024, // payload of one Fragment
  maxClientMessageBytes: 64 * 1024 * 1024, // largest reassembled message a client accepts
  maxSessionIdLength: 64,
  maxAwarenessBytes: 16 * 1024,
  maxDocIdLength: 64,
  maxErrorMessageLength: 512,
  maxChannel: 0xffff,
  maxChannelsPerConnection: 64,
} as const;

export type Message =
  | { type: MsgType.Join; ch: number; docId: string }
  | { type: MsgType.Joined; ch: number; docId: string; role: Role }
  | { type: MsgType.Leave; ch: number }
  | { type: MsgType.Sync1; ch: number; stateVector: Uint8Array }
  | { type: MsgType.Sync2; ch: number; update: Uint8Array }
  | { type: MsgType.Update; ch: number; seq: number; update: Uint8Array }
  | { type: MsgType.Ack; ch: number; seq: number }
  | { type: MsgType.Awareness; ch: number; payload: Uint8Array }
  // ref: the `seq` of the Update this error refers to (0 = none / Sync2)
  | { type: MsgType.Error; ch: number; code: ErrorCode; ref: number; message: string }
  | { type: MsgType.Ping; nonce: number }
  | { type: MsgType.Pong; nonce: number }
  | { type: MsgType.RoleChanged; ch: number; role: Role }
  // sessionId: random per client instance (browser tab), stable across its
  // reconnects; a new connection with the same user and sessionId replaces
  // the old one. resume: reconnect attempt number (0 = first connection).
  | { type: MsgType.Hello; sessionId: string; resume: number }
  | { type: MsgType.Welcome; connectionId: string; heartbeatMs: number; maxMessageBytes: number; msgRatePerSec: number; byteRatePerSec: number; byteBurst: number }
  // A message larger than one frame is sent as `count` consecutive Fragments
  // with the same id, index 0..count-1, each carrying part of the encoded
  // inner message. Only Sync2 and Update may be fragmented.
  | { type: MsgType.Fragment; id: number; index: number; count: number; bytes: Uint8Array };

export class ProtocolError extends Error {
  constructor(message: string, readonly version?: number) {
    super(message);
    this.name = "ProtocolError";
  }
}

const DOC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidDocId(s: string): boolean {
  return DOC_ID_RE.test(s);
}

export function encode(m: Message): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, PROTOCOL_VERSION);
  encoding.writeUint8(e, m.type);
  switch (m.type) {
    case MsgType.Join:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarString(e, m.docId);
      break;
    case MsgType.Joined:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarString(e, m.docId);
      encoding.writeUint8(e, m.role);
      break;
    case MsgType.Leave:
      encoding.writeVarUint(e, m.ch);
      break;
    case MsgType.Sync1:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint8Array(e, m.stateVector);
      break;
    case MsgType.Sync2:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint8Array(e, m.update);
      break;
    case MsgType.Update:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint(e, m.seq);
      encoding.writeVarUint8Array(e, m.update);
      break;
    case MsgType.Ack:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint(e, m.seq);
      break;
    case MsgType.Awareness:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint8Array(e, m.payload);
      break;
    case MsgType.Error:
      encoding.writeVarUint(e, m.ch);
      encoding.writeVarUint(e, m.code);
      encoding.writeVarUint(e, m.ref);
      encoding.writeVarString(e, m.message.slice(0, LIMITS.maxErrorMessageLength));
      break;
    case MsgType.Ping:
    case MsgType.Pong:
      encoding.writeVarUint(e, m.nonce);
      break;
    case MsgType.RoleChanged:
      encoding.writeVarUint(e, m.ch);
      encoding.writeUint8(e, m.role);
      break;
    case MsgType.Hello:
      encoding.writeVarString(e, m.sessionId);
      encoding.writeVarUint(e, m.resume);
      break;
    case MsgType.Welcome:
      encoding.writeVarString(e, m.connectionId);
      encoding.writeVarUint(e, m.heartbeatMs);
      encoding.writeVarUint(e, m.maxMessageBytes);
      encoding.writeVarUint(e, m.msgRatePerSec);
      encoding.writeVarUint(e, m.byteRatePerSec);
      encoding.writeVarUint(e, m.byteBurst);
      break;
    case MsgType.Fragment:
      encoding.writeVarUint(e, m.id);
      encoding.writeVarUint(e, m.index);
      encoding.writeVarUint(e, m.count);
      encoding.writeVarUint8Array(e, m.bytes);
      break;
  }
  return encoding.toUint8Array(e);
}

function readUint(d: decoding.Decoder, what: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!decoding.hasContent(d)) throw new ProtocolError(`truncated ${what}`);
  let v: number;
  try {
    v = decoding.readVarUint(d);
  } catch {
    throw new ProtocolError(`invalid ${what}`);
  }
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new ProtocolError(`${what} out of range`);
  return v;
}

function readBytes(d: decoding.Decoder, what: string, max: number): Uint8Array {
  const len = readUint(d, `${what} length`);
  if (len > max) throw new ProtocolError(`${what} too large (${len} > ${max})`);
  if (d.pos + len > d.arr.length) throw new ProtocolError(`truncated ${what}`);
  const out = d.arr.slice(d.pos, d.pos + len);
  d.pos += len;
  return out;
}

function readString(d: decoding.Decoder, what: string, maxBytes: number): string {
  const bytes = readBytes(d, what, maxBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProtocolError(`${what} is not valid UTF-8`);
  }
}

function readU8(d: decoding.Decoder, what: string): number {
  if (!decoding.hasContent(d)) throw new ProtocolError(`truncated ${what}`);
  return decoding.readUint8(d);
}

function readRole(d: decoding.Decoder): Role {
  const r = readU8(d, "role");
  if (r !== Role.Viewer && r !== Role.Editor && r !== Role.Owner) throw new ProtocolError("invalid role");
  return r;
}

function readDocId(d: decoding.Decoder): string {
  const s = readString(d, "document id", LIMITS.maxDocIdLength);
  if (!isValidDocId(s)) throw new ProtocolError("invalid document id");
  return s;
}

// maxBytes bounds the frame and the Sync2/Update payload: LIMITS.maxFrameBytes
// for a frame read from the socket, larger for a reassembled message.
export function decode(frame: Uint8Array, maxBytes: number = LIMITS.maxFrameBytes): Message {
  if (frame.length > maxBytes) throw new ProtocolError("frame too large");
  if (frame.length < 2) throw new ProtocolError("frame too short");
  const d = decoding.createDecoder(frame);
  const version = decoding.readUint8(d);
  if (version !== PROTOCOL_VERSION) throw new ProtocolError(`unsupported protocol version ${version}`, version);
  const type = decoding.readUint8(d);
  const ch = () => readUint(d, "channel", LIMITS.maxChannel);
  let m: Message;
  switch (type) {
    case MsgType.Join:
      m = { type, ch: ch(), docId: readDocId(d) };
      break;
    case MsgType.Joined:
      m = { type, ch: ch(), docId: readDocId(d), role: readRole(d) };
      break;
    case MsgType.Leave:
      m = { type, ch: ch() };
      break;
    case MsgType.Sync1:
      m = { type, ch: ch(), stateVector: readBytes(d, "state vector", LIMITS.maxFrameBytes) };
      break;
    case MsgType.Sync2:
      m = { type, ch: ch(), update: readBytes(d, "update", maxBytes) };
      break;
    case MsgType.Update: {
      const c = ch();
      const seq = readUint(d, "sequence number");
      m = { type, ch: c, seq, update: readBytes(d, "update", maxBytes) };
      break;
    }
    case MsgType.Ack: {
      const c = ch();
      m = { type, ch: c, seq: readUint(d, "sequence number") };
      break;
    }
    case MsgType.Awareness:
      m = { type, ch: ch(), payload: readBytes(d, "awareness", LIMITS.maxAwarenessBytes) };
      break;
    case MsgType.Error: {
      const c = ch();
      const code = readUint(d, "error code", 1000);
      const ref = readUint(d, "error reference");
      m = { type, ch: c, code, ref, message: readString(d, "error message", LIMITS.maxErrorMessageLength * 4) };
      break;
    }
    case MsgType.Ping:
    case MsgType.Pong:
      m = { type, nonce: readUint(d, "nonce") };
      break;
    case MsgType.RoleChanged:
      m = { type, ch: ch(), role: readRole(d) };
      break;
    case MsgType.Hello: {
      const sessionId = readString(d, "session id", LIMITS.maxSessionIdLength);
      if (!SESSION_ID_RE.test(sessionId)) throw new ProtocolError("invalid session id");
      m = { type, sessionId, resume: readUint(d, "resume counter") };
      break;
    }
    case MsgType.Welcome:
      m = {
        type,
        connectionId: readString(d, "connection id", 64),
        heartbeatMs: readUint(d, "heartbeat interval"),
        maxMessageBytes: readUint(d, "message size limit"),
        msgRatePerSec: readUint(d, "message rate"),
        byteRatePerSec: readUint(d, "byte rate"),
        byteBurst: readUint(d, "byte burst"),
      };
      break;
    case MsgType.Fragment: {
      const id = readUint(d, "fragment id");
      const index = readUint(d, "fragment index");
      const count = readUint(d, "fragment count", 1 + Math.floor(LIMITS.maxClientMessageBytes / LIMITS.fragmentBytes));
      if (count < 2 || index >= count) throw new ProtocolError("invalid fragment index");
      m = { type, id, index, count, bytes: readBytes(d, "fragment", LIMITS.fragmentBytes) };
      break;
    }
    default:
      throw new ProtocolError(`unknown message type ${type}`);
  }
  if (decoding.hasContent(d)) throw new ProtocolError("trailing bytes after message");
  return m;
}

// ------------------------------------------------------------ fragmentation

// Encode a message, splitting it into Fragments if it does not fit in one
// frame. Only Sync2 and Update can be that large.
export function encodeFrames(m: Message, nextId: () => number): Uint8Array[] {
  const whole = encode(m);
  if (whole.length <= LIMITS.maxFrameBytes) return [whole];
  if (m.type !== MsgType.Sync2 && m.type !== MsgType.Update) throw new ProtocolError("message too large to send");
  const id = nextId();
  const count = Math.ceil(whole.length / LIMITS.fragmentBytes);
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++)
    out.push(encode({ type: MsgType.Fragment, id, index: i, count, bytes: whole.subarray(i * LIMITS.fragmentBytes, (i + 1) * LIMITS.fragmentBytes) }));
  return out;
}

// Reassembles fragmented messages arriving on one ordered connection. At
// most one fragmented message is in progress (a sender writes all fragments
// of a message consecutively); its total size is bounded by maxBytes, so a
// peer cannot make the receiver buffer more than that.
export class Reassembler {
  private id = -1;
  private count = 0;
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly maxBytes: number) {}

  get bufferedBytes(): number {
    return this.size;
  }

  /** Returns the decoded inner message once the last fragment arrives. */
  add(f: Extract<Message, { type: MsgType.Fragment }>): Message | undefined {
    if (f.index === 0) {
      if (this.parts.length > 0) throw new ProtocolError("fragmented message interrupted");
      if (f.count * LIMITS.fragmentBytes > this.maxBytes + LIMITS.fragmentBytes) throw new ProtocolError("fragmented message too large");
      this.id = f.id;
      this.count = f.count;
    } else if (f.id !== this.id || f.count !== this.count || f.index !== this.parts.length) {
      throw new ProtocolError("fragment out of sequence");
    }
    if (f.index < f.count - 1 && f.bytes.length !== LIMITS.fragmentBytes) throw new ProtocolError("short fragment");
    this.size += f.bytes.length;
    if (this.size > this.maxBytes) throw new ProtocolError("fragmented message too large");
    this.parts.push(f.bytes);
    if (this.parts.length < this.count) return undefined;
    const whole = new Uint8Array(this.size);
    let off = 0;
    for (const p of this.parts) {
      whole.set(p, off);
      off += p.length;
    }
    this.parts = [];
    this.size = 0;
    this.id = -1;
    const inner = decode(whole, this.maxBytes);
    if (inner.type !== MsgType.Sync2 && inner.type !== MsgType.Update) throw new ProtocolError("only Sync2 and Update may be fragmented");
    return inner;
  }
}

// An Error frame in protocol version 1 layout, so that a client running an
// older build (an open tab during a deployment) can show why it is refused.
export function encodeVersion1Error(code: ErrorCode, message: string): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeUint8(e, 1);
  encoding.writeUint8(e, MsgType.Error);
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, code);
  encoding.writeVarString(e, message);
  return encoding.toUint8Array(e);
}
