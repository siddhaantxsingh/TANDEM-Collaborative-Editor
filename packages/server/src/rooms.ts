// Document rooms: the in-memory replica of each open document, its
// connected clients, presence, and the path from an incoming edit to the
// database and to every other replica.
//
// Invariants (see docs/ARCHITECTURE.md):
//  * An update from a client is applied only if the client's server-side
//    role allows editing; the client never states its own role.
//  * An Ack for a client update is sent only after that update (or, if it
//    added nothing new, everything before it) is committed to PostgreSQL.
//  * Nothing is ever dropped silently: a failed write stays queued and is
//    retried; an overloaded connection is closed and resynchronizes.
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { canEdit, ErrorCode, LIMITS, type Message, MsgType, parseRole, Role } from "@tandem/protocol";
import { applyUpdateHealing } from "@tandem/protocol/client";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";

import type { SessionUser } from "./auth.js";
import { BusKind, type Bus, type BusMessage } from "./bus.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import { appendUpdates, compactDoc, loadDocState, roleForDoc } from "./store.js";

export interface Peer {
  readonly id: string;
  readonly user: SessionUser;
  /** Queue a message (fragmented if large, flow-controlled; see ws.ts). */
  send(msg: Message): void;
  close(code: number, reason: string): void;
}

interface Member {
  ch: number;
  role: Role;
  awarenessIds: Set<number>;
  // Value of RoomManager.accessEpoch when the role was last set (join or
  // membership event); revalidation does not overwrite newer information.
  roleEpoch: number;
}

interface PersistItem {
  update: Uint8Array | null; // null = barrier (ack only)
  userId: string | null;
  acks: { peer: Peer; ch: number; seq: number; at: number }[]; // at: performance.now() on receipt
}

const REMOTE = Symbol("remote");

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class Room {
  readonly doc = new Y.Doc({ gc: true });
  readonly awareness: awarenessProtocol.Awareness;
  readonly members = new Map<Peer, Member>();
  private queue: PersistItem[] = [];
  private persisting = false;
  private storedSinceCompact = 0;
  private compacting = false;
  private idleTimer: NodeJS.Timeout | undefined;
  private retryDelay = 100;
  private captured: Uint8Array[] = []; // "update" events of the current apply
  approxBytes = 0;
  closed = false;

  constructor(
    readonly docId: string,
    readonly workspaceId: string,
    private readonly mgr: RoomManager,
  ) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no presence of its own
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.captured.push(update);
      // Fan out to local clients (except the sender) and to other nodes.
      for (const [peer, m] of this.members) {
        if (peer === origin) continue;
        this.mgr.send(peer, { type: MsgType.Update, ch: m.ch, seq: 0, update });
      }
      if (origin !== REMOTE) this.mgr.bus.publish(this.docId, BusKind.Update, update);
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      const payload = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      for (const [peer, m] of this.members) {
        if (peer === origin) continue;
        this.mgr.send(peer, { type: MsgType.Awareness, ch: m.ch, payload });
      }
      if (origin !== REMOTE) this.mgr.bus.publish(this.docId, BusKind.Awareness, payload);
    });
  }

  get pendingPersist(): number {
    return this.queue.length;
  }

  // Apply an update from a client. Returns an error code, or undefined.
  applyClientUpdate(peer: Peer, update: Uint8Array, ack: { ch: number; seq: number } | null): ErrorCode | undefined {
    const m = this.members.get(peer);
    if (!m) return ErrorCode.Forbidden;
    // Structural validation before touching the document.
    try {
      Y.decodeUpdate(update);
    } catch {
      this.mgr.metrics.updatesRejected.inc({ reason: "malformed" });
      return ErrorCode.BadMessage;
    }
    if (!canEdit(m.role)) {
      // A viewer may send a sync reply that contains nothing new (e.g. its
      // replica is just behind); anything else is a write attempt.
      if (this.isNoop(update)) {
        if (ack) this.ackAfterDurable(peer, ack.ch, ack.seq);
        return undefined;
      }
      this.mgr.metrics.updatesRejected.inc({ reason: "forbidden" });
      return ErrorCode.Forbidden;
    }
    if (this.approxBytes + update.length > this.mgr.config.maxDocumentBytes) {
      this.mgr.metrics.updatesRejected.inc({ reason: "too_large" });
      return ErrorCode.TooLarge;
    }
    this.captured = [];
    const store = this.doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
    const pendingBefore = [store.pendingStructs, store.pendingDs];
    try {
      applyUpdateHealing(this.doc, update, peer);
    } catch (err) {
      this.mgr.metrics.updatesRejected.inc({ reason: "apply_failed" });
      this.mgr.log.warn("update rejected", { docId: this.docId, err: (err as Error).message });
      return ErrorCode.BadMessage;
    }
    const parts = this.captured; // set by the "update" handler
    this.captured = [];
    const integrated = parts.length === 0 ? null : parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
    // Parts of an update whose causal dependencies this replica lacks are
    // held by Yjs as *pending* and produce no "update" event. They are still
    // information the client was promised is stored, so the raw update (a
    // superset; Yjs updates are idempotent) is persisted instead.
    const stashed = store.pendingStructs !== pendingBefore[0] || store.pendingDs !== pendingBefore[1];
    if (stashed) this.mgr.metrics.updatesPending.inc();
    const effective = stashed ? update : integrated;
    if (effective) {
      this.approxBytes += effective.length;
      this.mgr.metrics.updatesApplied.inc();
      this.queue.push({ update: effective, userId: peer.user.id, acks: ack ? [{ peer, ch: ack.ch, seq: ack.seq, at: performance.now() }] : [] });
      void this.flush();
    } else if (ack) {
      this.ackAfterDurable(peer, ack.ch, ack.seq);
    }
    return undefined;
  }

  private isNoop(update: Uint8Array): boolean {
    const diff = Y.diffUpdate(update, Y.encodeStateVector(this.doc));
    const d = Y.decodeUpdate(diff);
    return d.structs.length === 0 && d.ds.clients.size === 0;
  }

  // Ack once everything currently queued is durable (or right away).
  private ackAfterDurable(peer: Peer, ch: number, seq: number) {
    const last = this.queue[this.queue.length - 1];
    if (last) last.acks.push({ peer, ch, seq, at: performance.now() });
    else {
      this.mgr.metrics.ackLatency.observe(0);
      this.mgr.send(peer, { type: MsgType.Ack, ch, seq });
    }
  }

  applyRemote(m: BusMessage) {
    this.mgr.metrics.pubsubIn.inc({ kind: String(m.kind) });
    try {
      switch (m.kind) {
        case BusKind.Update:
          applyUpdateHealing(this.doc, m.payload, REMOTE);
          break;
        case BusKind.SyncReply: {
          const before = Y.encodeStateVector(this.doc);
          applyUpdateHealing(this.doc, m.payload, REMOTE);
          if (!sameBytes(before, Y.encodeStateVector(this.doc))) this.mgr.metrics.antiEntropyRepairs.inc({ source: "node" });
          break;
        }
        case BusKind.Awareness:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, m.payload, REMOTE);
          break;
        case BusKind.SyncRequest: {
          const diff = Y.encodeStateAsUpdate(this.doc, m.payload);
          // Reply only with content the requester lacks (every diff carries
          // the full delete set; persisted deletions reach it via the sweep).
          if (Y.decodeUpdate(diff).structs.length > 0) this.mgr.bus.publish(this.docId, BusKind.SyncReply, diff, m.from);
          break;
        }
      }
    } catch (err) {
      this.mgr.log.warn("bad message from another node", { docId: this.docId, err: (err as Error).message });
    }
  }

  // Validate and rewrite an awareness update from a client: it may only set
  // states for client ids it owns, and the user identity in the state is
  // replaced by the authenticated one (no impersonation).
  applyClientAwareness(peer: Peer, payload: Uint8Array): ErrorCode | undefined {
    const m = this.members.get(peer);
    if (!m) return ErrorCode.Forbidden;
    let entries: { id: number; clock: number; state: Record<string, unknown> | null }[];
    try {
      const d = decoding.createDecoder(payload);
      const n = decoding.readVarUint(d);
      if (n > 4) return ErrorCode.BadMessage;
      entries = [];
      for (let i = 0; i < n; i++) {
        const id = decoding.readVarUint(d);
        const clock = decoding.readVarUint(d);
        const raw = JSON.parse(decoding.readVarString(d)) as unknown;
        if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return ErrorCode.BadMessage;
        entries.push({ id, clock, state: raw as Record<string, unknown> | null });
      }
      if (decoding.hasContent(d)) return ErrorCode.BadMessage;
    } catch {
      return ErrorCode.BadMessage;
    }
    for (const e of entries) {
      if (!m.awarenessIds.has(e.id)) {
        for (const [other, om] of this.members) {
          if (other === peer || !om.awarenessIds.has(e.id)) continue;
          // The same replica (Yjs client id) of the same user on a new
          // connection: the old socket is stale (half-open after a network
          // change) and is closed now instead of at the next heartbeat.
          if (other.user.id !== peer.user.id) return ErrorCode.Forbidden;
          om.awarenessIds.delete(e.id);
          this.mgr.metrics.staleConnections.inc({ reason: "replica_reconnected" });
          other.close(4010, "superseded by a newer connection");
        }
        if (m.awarenessIds.size >= 4) return ErrorCode.Forbidden;
        m.awarenessIds.add(e.id);
      }
      if (e.state) {
        const user = (e.state.user ?? {}) as Record<string, unknown>;
        const color = typeof user.color === "string" && /^#[0-9a-fA-F]{6}$/.test(user.color) ? user.color : "#888888";
        e.state.user = { id: peer.user.id, name: peer.user.name, color, role: m.role };
      }
    }
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, entries.length);
    for (const e of entries) {
      encoding.writeVarUint(enc, e.id);
      encoding.writeVarUint(enc, e.clock);
      encoding.writeVarString(enc, JSON.stringify(e.state));
    }
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(enc), peer);
    return undefined;
  }

  removeMember(peer: Peer) {
    const m = this.members.get(peer);
    if (!m) return;
    this.members.delete(peer);
    if (m.awarenessIds.size > 0) awarenessProtocol.removeAwarenessStates(this.awareness, [...m.awarenessIds], "leave");
    if (this.members.size === 0) this.scheduleUnload();
  }

  cancelUnload() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleUnload() {
    this.cancelUnload();
    this.idleTimer = setTimeout(() => void this.mgr.unload(this), this.mgr.config.roomIdleMs);
    this.idleTimer.unref();
  }

  async flush(): Promise<void> {
    if (this.persisting) return;
    this.persisting = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, 200);
        const updates = batch.filter((b) => b.update).map((b) => ({ update: b.update!, userId: b.userId }));
        const t0 = process.hrtime.bigint();
        try {
          await appendUpdates(this.mgr.db, this.docId, updates, this.mgr.bus.nodeId);
        } catch (err) {
          if ((err as { code?: string }).code === "23503") {
            // Foreign key violation: the document was deleted. Its pending
            // updates have nowhere to go; this is the deletion, not a loss.
            this.mgr.log.warn("document deleted with pending updates", { docId: this.docId, pending: this.queue.length });
            this.queue = [];
            break;
          }
          this.mgr.metrics.persistFailures.inc();
          this.mgr.log.error("persisting updates failed; will retry", { docId: this.docId, err: (err as Error).message, delayMs: this.retryDelay });
          await new Promise((r) => setTimeout(r, this.retryDelay));
          this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
          continue; // the batch is still at the head of the queue
        }
        this.retryDelay = 100;
        this.mgr.metrics.persistLatency.observe(Number(process.hrtime.bigint() - t0) / 1e9);
        this.mgr.metrics.updatesPersisted.inc({}, updates.length);
        this.queue.splice(0, batch.length);
        this.storedSinceCompact += updates.length;
        const now = performance.now();
        for (const b of batch)
          for (const a of b.acks) {
            this.mgr.metrics.ackLatency.observe((now - a.at) / 1000);
            this.mgr.send(a.peer, { type: MsgType.Ack, ch: a.ch, seq: a.seq });
          }
      }
    } finally {
      this.persisting = false;
    }
    if (this.storedSinceCompact >= this.mgr.config.compactEvery) void this.compact();
  }

  // Durability sweep: updates received from other nodes are persisted by the
  // node that received them from a client. If that node crashed before
  // writing and the client never comes back, the content would exist only in
  // memory here. Periodically (and before unloading) write whatever this
  // replica has that the database lacks. Duplicates are harmless.
  //
  // The sweep is also anti-entropy in the other direction: pub/sub is
  // at-most-once, so an update published by another node can be lost without
  // a Redis disconnect. Whatever the database has that this replica lacks is
  // merged in (and reaches this node's clients through the "update" event);
  // other nodes are asked for anything they hold but have not stored yet.
  async sweep(): Promise<void> {
    if (this.queue.length > 0 || this.closed) return;
    const t0 = performance.now();
    // What this replica held when the sweep started. Updates that arrive
    // while the database is read are still being persisted normally; they
    // must not be counted as missing (that race showed up under load as
    // spurious repair writes).
    const mine = Y.encodeStateAsUpdate(this.doc);
    const { state } = await loadDocState(this.mgr.db, this.docId);
    if (this.closed) return;
    this.mgr.metrics.sweepDuration.observe((performance.now() - t0) / 1000);
    const before = Y.encodeStateVector(this.doc);
    applyUpdateHealing(this.doc, state, REMOTE);
    if (!sameBytes(before, Y.encodeStateVector(this.doc))) {
      this.mgr.metrics.antiEntropyRepairs.inc({ source: "database" });
      this.mgr.log.warn("replica was missing updates present in the database", { docId: this.docId });
    }
    this.mgr.bus.publish(this.docId, BusKind.SyncRequest, Y.encodeStateVector(this.doc));
    // Does our replica contain anything (insertions or deletions) that the
    // stored state lacks? Applying ours onto a copy of the stored state
    // emits an update event exactly in that case.
    const dbDoc = new Y.Doc();
    Y.applyUpdate(dbDoc, state);
    let changed = false;
    dbDoc.on("update", () => (changed = true));
    Y.applyUpdate(dbDoc, mine);
    dbDoc.destroy();
    if (!changed) return;
    // Missing structs plus the full delete set (of the replica as it was).
    const repair = Y.diffUpdate(mine, Y.encodeStateVectorFromUpdate(state));
    this.mgr.metrics.sweepRepairs.inc();
    this.mgr.log.warn("durability sweep wrote updates missing from the database", { docId: this.docId, bytes: repair.length });
    this.queue.push({ update: repair, userId: null, acks: [] });
    await this.flush();
  }

  async compact(): Promise<void> {
    if (this.compacting) return;
    this.compacting = true;
    const t0 = performance.now();
    try {
      const r = await compactDoc(this.mgr.db, this.docId);
      this.mgr.metrics.compactionDuration.observe((performance.now() - t0) / 1000);
      this.storedSinceCompact = 0;
      if (r && r.merged > 0) {
        this.mgr.metrics.compactions.inc();
        this.approxBytes = Y.encodeStateAsUpdate(this.doc).length;
      }
    } catch (err) {
      this.mgr.log.error("compaction failed", { docId: this.docId, err: (err as Error).message });
    } finally {
      this.compacting = false;
    }
  }

  destroy() {
    this.cancelUnload();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private loading = new Map<string, Promise<Room>>();
  // peer -> channel -> docId
  private channels = new Map<Peer, Map<number, string>>();
  private sweepTimer: NodeJS.Timeout | undefined;
  // Incremented on every role assignment to a live member.
  private accessEpoch = 0;

  constructor(
    readonly db: Db,
    readonly bus: Bus,
    readonly config: Config,
    readonly log: Logger,
    readonly metrics: Metrics,
  ) {
    metrics.activeRooms.set(() => this.rooms.size);
    metrics.pendingPersist.set(() => [...this.rooms.values()].reduce((n, r) => n + r.pendingPersist, 0));
    if (config.durabilitySweepMs > 0) {
      const t = setInterval(() => {
        for (const r of this.rooms.values())
          void r.sweep().catch((err) => this.log.error("sweep failed", { docId: r.docId, err: (err as Error).message }));
      }, config.durabilitySweepMs);
      t.unref();
      this.sweepTimer = t;
    }
    bus.onControl((e) => {
      if (e.type === "membership") this.membershipChanged(e.workspaceId, e.userId, e.role);
      else if (e.type === "document-deleted") void this.documentDeleted(e.docId);
    });
  }

  get roomCount() {
    return this.rooms.size;
  }

  room(docId: string): Room | undefined {
    return this.rooms.get(docId);
  }

  // Peer.send enforces backpressure (see ws.ts).
  send(peer: Peer, msg: Message) {
    peer.send(msg);
  }

  // ref: the seq of the client Update the error refers to (0 = none / Sync2).
  private error(peer: Peer, ch: number, code: ErrorCode, message: string, ref = 0) {
    peer.send({ type: MsgType.Error, ch, code, ref, message });
  }

  private async loadRoom(docId: string, workspaceId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) return existing;
    const pending = this.loading.get(docId);
    if (pending) return pending;
    const p = (async () => {
      const room = new Room(docId, workspaceId, this);
      // Subscribe before loading so that no update published by another
      // node after our database read is missed; then ask other holders for
      // anything not yet persisted.
      await this.bus.subscribe(docId, (m) => this.rooms.get(docId)?.applyRemote(m));
      const loaded = await loadDocState(this.db, docId);
      applyUpdateHealing(room.doc, loaded.state, "load");
      room.approxBytes = loaded.state.length;
      this.rooms.set(docId, room);
      this.bus.publish(docId, BusKind.SyncRequest, Y.encodeStateVector(room.doc));
      if (loaded.logRows >= this.config.compactEvery) void room.compact();
      return room;
    })();
    this.loading.set(docId, p);
    try {
      return await p;
    } catch (err) {
      await this.bus.unsubscribe(docId);
      throw err;
    } finally {
      this.loading.delete(docId);
    }
  }

  async unload(room: Room) {
    if (room.members.size > 0 || room.closed) return;
    await room.flush();
    await room.sweep().catch((err) => this.log.error("sweep failed", { docId: room.docId, err: (err as Error).message }));
    if (room.members.size > 0) return; // someone joined meanwhile
    room.closed = true;
    this.rooms.delete(room.docId);
    await this.bus.unsubscribe(room.docId);
    await room.compact();
    room.destroy();
  }

  async join(peer: Peer, ch: number, docId: string) {
    let chans = this.channels.get(peer);
    if (!chans) this.channels.set(peer, (chans = new Map()));
    if (chans.has(ch)) return this.error(peer, ch, ErrorCode.ChannelInUse, "channel already in use");
    if (chans.size >= LIMITS.maxChannelsPerConnection) return this.error(peer, ch, ErrorCode.TooLarge, "too many open documents");
    chans.set(ch, docId); // reserve while loading
    try {
      const access = await roleForDoc(this.db, docId, peer.user.id);
      if (!access) {
        chans.delete(ch);
        // Same answer for "does not exist" and "no access": no probing.
        return this.error(peer, ch, ErrorCode.NotFound, "document not found");
      }
      const room = await this.loadRoom(docId, access.meta.workspaceId);
      if (room.members.size >= this.config.maxConnectionsPerDoc) {
        chans.delete(ch);
        return this.error(peer, ch, ErrorCode.Overloaded, "too many clients on this document");
      }
      if (!this.channels.get(peer)?.has(ch)) return; // connection closed while loading
      room.cancelUnload();
      room.members.set(peer, { ch, role: access.role, awarenessIds: new Set(), roleEpoch: ++this.accessEpoch });
      peer.send({ type: MsgType.Joined, ch, docId, role: access.role });
      // Server state vector: the client answers with what we are missing
      // (offline edits); then send current presence.
      peer.send({ type: MsgType.Sync1, ch, stateVector: Y.encodeStateVector(room.doc) });
      const states = [...room.awareness.getStates().keys()];
      if (states.length > 0)
        peer.send({ type: MsgType.Awareness, ch, payload: awarenessProtocol.encodeAwarenessUpdate(room.awareness, states) });
    } catch (err) {
      chans.delete(ch);
      this.log.error("join failed", { docId, err: (err as Error).message });
      this.error(peer, ch, ErrorCode.Internal, "could not open document");
    }
  }

  private roomFor(peer: Peer, ch: number): Room | undefined {
    const docId = this.channels.get(peer)?.get(ch);
    if (!docId) return undefined;
    const room = this.rooms.get(docId);
    return room && room.members.get(peer)?.ch === ch ? room : undefined;
  }

  leave(peer: Peer, ch: number) {
    const room = this.roomFor(peer, ch);
    this.channels.get(peer)?.delete(ch);
    room?.removeMember(peer);
  }

  peerClosed(peer: Peer) {
    const chans = this.channels.get(peer);
    if (!chans) return;
    for (const docId of chans.values()) this.rooms.get(docId)?.removeMember(peer);
    this.channels.delete(peer);
  }

  sync1(peer: Peer, ch: number, stateVector: Uint8Array) {
    const room = this.roomFor(peer, ch);
    if (!room) return this.error(peer, ch, ErrorCode.Forbidden, "channel not open");
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(room.doc, stateVector);
    } catch {
      return this.error(peer, ch, ErrorCode.BadMessage, "invalid state vector");
    }
    peer.send({ type: MsgType.Sync2, ch, update });
  }

  // A client's Sync2 (its offline edits) is acknowledged with seq 0.
  update(peer: Peer, ch: number, update: Uint8Array, seq: number | null): void {
    const room = this.roomFor(peer, ch);
    if (!room) return this.error(peer, ch, ErrorCode.Forbidden, "channel not open");
    const code = room.applyClientUpdate(peer, update, { ch, seq: seq ?? 0 });
    const ref = seq ?? 0;
    if (code === ErrorCode.Forbidden) this.error(peer, ch, code, "you do not have permission to edit this document", ref);
    else if (code === ErrorCode.TooLarge) this.error(peer, ch, code, "document size limit reached; this change was not saved", ref);
    else if (code === ErrorCode.BadMessage) this.error(peer, ch, code, "malformed update", ref);
  }

  awareness(peer: Peer, ch: number, payload: Uint8Array) {
    const room = this.roomFor(peer, ch);
    if (!room) return;
    const code = room.applyClientAwareness(peer, payload);
    if (code !== undefined) this.error(peer, ch, code, "invalid presence update");
  }

  // Apply a membership change to live connections on every document of the
  // workspace (called locally and, through the bus, on every node).
  membershipChanged(workspaceId: string, userId: string, roleName: string | null) {
    const role = roleName === "OWNER" ? Role.Owner : roleName === "EDITOR" ? Role.Editor : roleName === "VIEWER" ? Role.Viewer : undefined;
    for (const room of this.rooms.values()) {
      if (room.workspaceId !== workspaceId) continue;
      for (const [peer, m] of [...room.members]) {
        if (peer.user.id !== userId) continue;
        if (role === undefined) {
          this.error(peer, m.ch, ErrorCode.Forbidden, "your access to this workspace was removed");
          this.leave(peer, m.ch);
        } else {
          m.roleEpoch = ++this.accessEpoch;
          if (role !== m.role) {
            m.role = role;
            peer.send({ type: MsgType.RoleChanged, ch: m.ch, role });
          }
        }
      }
    }
  }

  // Re-check every live member against the database: document still
  // exists, membership still exists, role unchanged. Membership changes are
  // normally applied at once through bus events; Redis pub/sub is
  // at-most-once, so a lost event (or a change made directly in the
  // database) would otherwise leave a removed user able to read and write
  // until they reconnect. A member whose role was set after the query began
  // (newer bus event or join) is left alone.
  async revalidateMembers(): Promise<void> {
    if (this.rooms.size === 0) return;
    const epoch = this.accessEpoch;
    const docIds = [...this.rooms.keys()];
    const existing = new Set(
      (await this.db.query("SELECT id FROM documents WHERE id = ANY($1::text[])", [docIds])).rows.map((r) => r.id as string),
    );
    for (const docId of docIds) {
      if (existing.has(docId) || !this.rooms.has(docId)) continue;
      this.metrics.accessRevalidated.inc({ change: "deleted" });
      this.log.warn("document deleted without a bus event; closing it", { docId });
      await this.documentDeleted(docId);
    }
    const pairs = new Map<string, [string, string]>();
    for (const room of this.rooms.values())
      for (const peer of room.members.keys()) pairs.set(`${room.workspaceId}:${peer.user.id}`, [room.workspaceId, peer.user.id]);
    if (pairs.size === 0) return;
    const list = [...pairs.values()];
    const r = await this.db.query(
      "SELECT m.workspace_id, m.user_id, m.role FROM memberships m JOIN unnest($1::uuid[], $2::uuid[]) AS p(w, u) ON m.workspace_id = p.w AND m.user_id = p.u",
      [list.map((p) => p[0]), list.map((p) => p[1])],
    );
    const roles = new Map<string, Role | undefined>();
    for (const row of r.rows) roles.set(`${row.workspace_id}:${row.user_id}`, parseRole(row.role as string));
    for (const room of [...this.rooms.values()]) {
      for (const [peer, m] of [...room.members]) {
        if (m.roleEpoch > epoch) continue;
        const role = roles.get(`${room.workspaceId}:${peer.user.id}`);
        if (role === undefined) {
          this.metrics.accessRevalidated.inc({ change: "removed" });
          this.error(peer, m.ch, ErrorCode.Forbidden, "your access to this workspace was removed");
          this.leave(peer, m.ch);
        } else if (role !== m.role) {
          this.metrics.accessRevalidated.inc({ change: "role" });
          m.role = role;
          peer.send({ type: MsgType.RoleChanged, ch: m.ch, role });
        }
      }
    }
  }

  // The document was deleted: disconnect its clients and drop the replica.
  async documentDeleted(docId: string) {
    const room = this.rooms.get(docId);
    if (!room) return;
    for (const [peer, m] of [...room.members]) {
      this.error(peer, m.ch, ErrorCode.NotFound, "this document was deleted");
      this.channels.get(peer)?.delete(m.ch);
      room.members.delete(peer);
    }
    room.closed = true;
    this.rooms.delete(docId);
    await this.bus.unsubscribe(docId);
    room.destroy();
  }

  // After a bus reconnect we may have missed updates: ask again.
  resyncAll() {
    for (const room of this.rooms.values()) this.bus.publish(room.docId, BusKind.SyncRequest, Y.encodeStateVector(room.doc));
  }

  async shutdown() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.all([...this.rooms.values()].map((r) => r.flush()));
    await Promise.all([...this.rooms.values()].map((r) => r.compact()));
    for (const r of this.rooms.values()) r.destroy();
    this.rooms.clear();
  }

  pendingTotal(): number {
    return [...this.rooms.values()].reduce((n, r) => n + r.pendingPersist, 0);
  }
}
