import { useEffect, useRef, useState } from "react";
import { MonacoBinding } from "y-monaco";

import { Role } from "@tandem/protocol";

import { languageFor, monaco } from "./monaco";
import { getConnection, openDoc, type OpenDoc } from "./sync";

interface Props {
  docId: string;
  path: string;
  userId: string;
  userName: string;
  onClosed: (reason: string) => void;
}

interface Presence { clientId: number; name: string; color: string }

const ROLE_LABEL: Record<number, string> = { [Role.Viewer]: "VIEWER (read-only)", [Role.Editor]: "EDITOR", [Role.Owner]: "OWNER" };

export function Editor({ docId, path, userId, userName, onClosed }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(getConnection().status);
  const [unsaved, setUnsaved] = useState(0);
  const [role, setRole] = useState<Role | undefined>();
  const [synced, setSynced] = useState(false);
  const [people, setPeople] = useState<Presence[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const el = host.current!;
    const od: OpenDoc = openDoc(userId, docId, userName);
    const model = monaco.editor.createModel("", languageFor(path));
    const editor = monaco.editor.create(el, {
      model,
      automaticLayout: true,
      minimap: { enabled: false },
      readOnly: true, // until the server tells us our role
      fontSize: 14,
      theme: "vs",
    });
    const binding = new MonacoBinding(od.doc.getText("content"), model, new Set([editor]), od.awareness);
    const style = document.createElement("style");
    document.head.appendChild(style);

    const refreshPeople = () => {
      const list: Presence[] = [];
      let css = "";
      od.awareness.getStates().forEach((st, clientId) => {
        const u = (st as { user?: { name?: string; color?: string } }).user;
        if (!u || clientId === od.doc.clientID) return;
        const color = /^#[0-9a-fA-F]{6}$/.test(u.color ?? "") ? u.color! : "#888888";
        list.push({ clientId, name: String(u.name ?? "?"), color });
        css += `.yRemoteSelection-${clientId}{background-color:${color}40}.yRemoteSelectionHead-${clientId}{border-left:2px solid ${color}}`;
      });
      style.textContent = css;
      setPeople(list);
    };
    od.awareness.on("change", refreshPeople);
    const onStatus = (s: typeof status) => setStatus(s);
    getConnection().onStatus(onStatus);
    od.handle.on("saved", setUnsaved);
    od.handle.on("synced", () => setSynced(true));
    od.handle.on("role", (r) => {
      setRole(r);
      editor.updateOptions({ readOnly: r === Role.Viewer });
    });
    od.handle.on("error", (code, message) => {
      setError(od.handle.rejected ? `${message} Your copy keeps the change; others do not see it.` : message);
      if (od.handle.closed) onClosed(message);
    });
    const beforeUnload = (e: BeforeUnloadEvent) => {
      // Offline edits are kept in IndexedDB, but warn anyway so the user knows.
      if (od.handle.unsaved > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      binding.destroy();
      editor.dispose();
      model.dispose();
      style.remove();
      od.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const saveLabel =
    status === "outdated"
      ? "The app was updated — reload the page"
      : status !== "online"
        ? unsaved > 0
          ? "Offline — changes kept locally"
          : "Offline"
        : unsaved > 0
          ? "Saving…"
          : synced
            ? "All changes saved"
            : "Connecting…";

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="path">{path}</span>
        <span className="spacer" />
        <span className="presence" data-testid="presence">
          {people.map((p) => (
            <span key={p.clientId} className="avatar" style={{ background: p.color }} title={p.name}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </span>
        <button disabled title="Running code is disabled: the server has no safe sandbox for untrusted code (see docs/SECURITY.md)">
          ▶ Run (disabled)
        </button>
      </div>
      {error && (
        <div className="error banner" role="alert">
          {error}
        </div>
      )}
      <div ref={host} className="monaco-host" data-testid="editor" />
      <div className="statusbar" role="status" aria-live="polite">
        <span className={`dot ${status}`} /> <span data-testid="conn-status">{status}</span>
        <span data-testid="save-status">{saveLabel}</span>
        <span className="spacer" />
        <span data-testid="role">{role ? ROLE_LABEL[role] : ""}</span>
      </div>
    </div>
  );
}
