// Browser side of synchronization: one TandemConnection for the session,
// one Y.Doc per open file, persisted in IndexedDB so that edits survive a
// reload, a browser restart and network loss.
//
// Durability of local changes: every change of the Y.Doc is written to
// IndexedDB by y-indexeddb. Separately, the snapshot (state vector + delete
// set) that the server last confirmed is stored with it. When a document is
// opened, the restored replica is compared with that snapshot: anything
// beyond it is a local change the server may not have, shown as unsaved and
// sent by the next handshake. Nothing is ever discarded on the client.
import { TandemConnection, type DocHandle, type WebSocketLike } from "@tandem/protocol/client";
import { IndexeddbPersistence } from "y-indexeddb";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

let connection: TandemConnection | undefined;

export function getConnection(): TandemConnection {
  if (!connection) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    connection = new TandemConnection({
      url: `${proto}//${location.host}/ws`,
      createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
      log: (msg, fields) => console.debug("[tandem]", msg, fields ?? ""),
    });
    window.addEventListener("online", () => connection?.reconnectNow());
    // Don't wait for the ping timeout when the browser knows it is offline.
    window.addEventListener("offline", () => connection?.dropConnection());
  }
  return connection;
}

export function resetConnection() {
  connection?.destroy();
  connection = undefined;
}

export interface OpenDoc {
  doc: Y.Doc;
  awareness: Awareness;
  handle: DocHandle;
  local: IndexeddbPersistence;
  /** Resolves once the local replica is loaded; true if it holds changes
   *  the server has not confirmed. */
  restored: Promise<boolean>;
  close(): void;
}

const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46a0b0", "#f032e6", "#9a6324", "#808000", "#000075"];

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

const snapshotOf = (doc: Y.Doc) => Y.encodeSnapshot(Y.snapshot(doc));

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function openDoc(userId: string, docId: string, userName: string): OpenDoc {
  const doc = new Y.Doc({ gc: true });
  const local = new IndexeddbPersistence(`tandem:${userId}:${docId}`, doc);
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", { name: userName, color: colorFor(userId) });
  const handle = getConnection().open(docId, doc, awareness, { restoredOrigin: local });
  let closed = false;
  // Remember what the server has confirmed (written after the change itself,
  // so a crash in between only makes the next comparison conservative).
  handle.on("confirmed", () => {
    if (!closed) void local.set("confirmed", snapshotOf(doc).slice().buffer as ArrayBuffer);
  });
  const restored = local.whenSynced.then(async () => {
    if (closed) return false;
    const confirmed = (await local.get("confirmed")) as ArrayBuffer | undefined;
    const empty = Y.encodeStateVector(doc).length <= 1;
    const pending = !empty && (!confirmed || !sameBytes(new Uint8Array(confirmed), snapshotOf(doc)));
    if (pending && !handle.joined) handle.markDirty();
    return pending;
  });
  return {
    doc,
    awareness,
    handle,
    local,
    restored,
    close: () => {
      closed = true;
      getConnection().close(handle);
      awareness.destroy();
      void local.destroy();
      doc.destroy();
    },
  };
}
