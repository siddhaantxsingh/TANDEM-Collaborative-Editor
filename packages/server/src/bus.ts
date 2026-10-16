// Inter-node message bus. Single-node deployments use LocalBus (no-op);
// multi-node deployments use Redis pub/sub so that every node holding a
// document sees every update and presence change for it.
import { Redis } from "ioredis";

import type { Logger } from "./logger.js";

export enum BusKind {
  Update = 1, // a Yjs update applied on the sender
  Awareness = 2, // an awareness (presence) update
  SyncRequest = 3, // payload: sender's state vector; holders reply with SyncReply
  SyncReply = 4, // payload: update the target is missing
}

export interface BusMessage {
  from: string; // node id
  kind: BusKind;
  target: string; // node id, or "" for everyone
  payload: Uint8Array;
}

export type ControlEvent =
  | { type: "membership"; workspaceId: string; userId: string; role: string | null } // role null = removed
  | { type: "document-deleted"; docId: string }
  | { type: "session-revoked"; tokenHash: string } // hex SHA-256 of the session token
  | { type: "user-sessions-revoked"; userId: string };

export interface Bus {
  readonly nodeId: string;
  publish(docId: string, kind: BusKind, payload: Uint8Array, target?: string): void;
  subscribe(docId: string, handler: (m: BusMessage) => void): Promise<void>;
  unsubscribe(docId: string): Promise<void>;
  publishControl(e: ControlEvent): void;
  onControl(handler: (e: ControlEvent) => void): void;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export class LocalBus implements Bus {
  private control: ((e: ControlEvent) => void)[] = [];
  constructor(readonly nodeId: string) {}
  publish(): void {}
  async subscribe(): Promise<void> {}
  async unsubscribe(): Promise<void> {}
  publishControl(e: ControlEvent): void {
    for (const h of this.control) h(e);
  }
  onControl(handler: (e: ControlEvent) => void): void {
    this.control.push(handler);
  }
  async healthy(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
}

const DOC_PREFIX = "tandem:doc:";
const CONTROL_CHANNEL = "tandem:control";

export function encodeBusMessage(m: BusMessage): Buffer {
  const from = Buffer.from(m.from);
  const target = Buffer.from(m.target);
  return Buffer.concat([Buffer.from([from.length]), from, Buffer.from([m.kind, target.length]), target, Buffer.from(m.payload)]);
}

export function decodeBusMessage(b: Buffer): BusMessage | undefined {
  if (b.length < 3) return undefined;
  const fl = b[0]!;
  if (b.length < 1 + fl + 2) return undefined;
  const from = b.subarray(1, 1 + fl).toString();
  const kind = b[1 + fl]!;
  const tl = b[2 + fl]!;
  if (b.length < 3 + fl + tl || kind < 1 || kind > 4) return undefined;
  const target = b.subarray(3 + fl, 3 + fl + tl).toString();
  return { from, kind, target, payload: new Uint8Array(b.subarray(3 + fl + tl)) };
}

export class RedisBus implements Bus {
  /** Connection for commands (publish, rate limiting); `sub` only subscribes. */
  readonly pub: Redis;
  private sub: Redis;
  private handlers = new Map<string, (m: BusMessage) => void>();
  private control: ((e: ControlEvent) => void)[] = [];

  constructor(
    readonly nodeId: string,
    url: string,
    private readonly log: Logger,
    private readonly onLatency: (op: string, seconds: number) => void = () => {},
  ) {
    const opts = { lazyConnect: false, maxRetriesPerRequest: 2, enableOfflineQueue: true };
    this.pub = new Redis(url, opts);
    this.sub = new Redis(url, opts);
    for (const [name, c] of [["pub", this.pub], ["sub", this.sub]] as const) {
      c.on("error", (err: Error) => this.log.warn("redis error", { conn: name, err: err.message }));
    }
    // Re-subscribing after a reconnect is done by ioredis automatically
    // (autoResubscribe). After a reconnect we may have missed messages, so
    // the room manager is told to resynchronize all documents.
    this.sub.on("ready", () => this.onReconnect?.());
    void this.sub.subscribe(CONTROL_CHANNEL);
    this.sub.on("messageBuffer", (channel: Buffer, message: Buffer) => {
      const ch = channel.toString();
      if (ch === CONTROL_CHANNEL) {
        try {
          const e = JSON.parse(message.toString()) as ControlEvent;
          for (const h of this.control) h(e);
        } catch {
          this.log.warn("bad control message");
        }
        return;
      }
      if (!ch.startsWith(DOC_PREFIX)) return;
      const m = decodeBusMessage(message);
      if (!m || m.from === this.nodeId || (m.target !== "" && m.target !== this.nodeId)) return;
      this.handlers.get(ch.slice(DOC_PREFIX.length))?.(m);
    });
  }

  onReconnect?: () => void;

  publish(docId: string, kind: BusKind, payload: Uint8Array, target = ""): void {
    const t0 = performance.now();
    void this.pub
      .publish(DOC_PREFIX + docId, encodeBusMessage({ from: this.nodeId, kind, target, payload }))
      .then(() => this.onLatency("publish", (performance.now() - t0) / 1000))
      .catch((err: Error) => this.log.warn("redis publish failed", { docId, err: err.message }));
  }

  async subscribe(docId: string, handler: (m: BusMessage) => void): Promise<void> {
    this.handlers.set(docId, handler);
    await this.sub.subscribe(DOC_PREFIX + docId);
  }

  async unsubscribe(docId: string): Promise<void> {
    this.handlers.delete(docId);
    await this.sub.unsubscribe(DOC_PREFIX + docId).catch(() => {});
  }

  publishControl(e: ControlEvent): void {
    // Delivered to every node including this one (we are subscribed too), so
    // control handlers must be idempotent.
    void this.pub.publish(CONTROL_CHANNEL, JSON.stringify(e)).catch((err: Error) => this.log.warn("redis publish failed", { err: err.message }));
  }

  onControl(handler: (e: ControlEvent) => void): void {
    this.control.push(handler);
  }

  async healthy(): Promise<boolean> {
    try {
      const t0 = performance.now();
      const ok = (await this.pub.ping()) === "PONG";
      this.onLatency("ping", (performance.now() - t0) / 1000);
      return ok;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
