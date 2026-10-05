import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { api, type DocumentInfo, type Member, type RoleName, type User, type WorkspaceDetail } from "./api";
import { Editor } from "./Editor";

interface TreeNode { name: string; path: string; children: Map<string, TreeNode>; doc?: DocumentInfo }

function buildTree(docs: DocumentInfo[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const d of docs) {
    const parts = d.path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join("/");
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = { name: part, path: p, children: new Map() }));
      if (i === parts.length - 1) child.doc = d;
      node = child;
    });
  }
  return root;
}

function Tree({ node, depth, open, onOpen }: { node: TreeNode; depth: number; open: string | null; onOpen: (d: DocumentInfo) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const entries = [...node.children.values()].sort((a, b) => Number(!!a.doc) - Number(!!b.doc) || a.name.localeCompare(b.name));
  return (
    <ul className="tree">
      {entries.map((c) =>
        c.doc && c.children.size === 0 ? (
          <li key={c.path} style={{ paddingLeft: depth * 12 }}>
            <button className={`file ${open === c.doc.id ? "active" : ""}`} onClick={() => onOpen(c.doc!)} data-testid={`file-${c.path}`}>
              {c.name}
            </button>
          </li>
        ) : (
          <li key={c.path}>
            <button className="folder" style={{ paddingLeft: depth * 12 }} onClick={() => setCollapsed(!collapsed)}>
              {collapsed ? "▸" : "▾"} {c.name}
            </button>
            {!collapsed && <Tree node={c} depth={depth + 1} open={open} onOpen={onOpen} />}
          </li>
        ),
      )}
    </ul>
  );
}

export function WorkspaceView({ workspaceId, user }: { workspaceId: string; user: User }) {
  const [data, setData] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState("");
  const [tabs, setTabs] = useState<DocumentInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [newPath, setNewPath] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<RoleName>("EDITOR");

  const load = useCallback(() => api.workspace(workspaceId).then(setData, (e) => setError(e.message)), [workspaceId]);
  useEffect(() => void load(), [load]);
  const tree = useMemo(() => buildTree(data?.documents ?? []), [data]);

  if (!data) return <main className="page">{error ? <div className="error">{error}</div> : "Loading…"}</main>;
  const role = data.workspace.role;
  const canEdit = role !== "VIEWER";
  const isOwner = role === "OWNER";

  const openTab = (d: DocumentInfo) => {
    setTabs((t) => (t.some((x) => x.id === d.id) ? t : [...t, d]));
    setActive(d.id);
  };
  const closeTab = (id: string) => {
    setTabs((t) => t.filter((x) => x.id !== id));
    setActive((a) => (a === id ? null : a));
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const createFile = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api.createDocument(workspaceId, newPath);
      setNewPath("");
      openTab(r.document);
    });
  };
  const activeDoc = tabs.find((t) => t.id === active);

  return (
    <div className="workspace">
      <aside className="sidebar">
        <h3>{data.workspace.name} <span className={`badge ${role.toLowerCase()}`}>{role}</span></h3>
        <Tree node={tree} depth={0} open={active} onOpen={openTab} />
        {canEdit && (
          <form onSubmit={createFile} className="row small">
            <input placeholder="src/new-file.ts" value={newPath} onChange={(e) => setNewPath(e.target.value)} required data-testid="new-file" />
            <button type="submit">+</button>
          </form>
        )}
        {activeDoc && canEdit && (
          <div className="row small">
            <button onClick={() => { const p = prompt("New path", activeDoc.path); if (p) void act(async () => { await api.renameDocument(activeDoc.id, p); setTabs((t) => t.map((x) => (x.id === activeDoc.id ? { ...x, path: p } : x))); }); }}>Rename</button>
            <button onClick={() => { if (confirm(`Delete ${activeDoc.path}?`)) void act(async () => { await api.deleteDocument(activeDoc.id); closeTab(activeDoc.id); }); }}>Delete</button>
          </div>
        )}
        <h4>Members</h4>
        <ul className="members">
          {data.members.map((m: Member) => (
            <li key={m.id}>
              <span title={m.email}>{m.name}{m.id === user.id ? " (you)" : ""}</span>
              {isOwner && m.id !== user.id ? (
                <>
                  <select value={m.role} onChange={(e) => void act(() => api.setRole(workspaceId, m.id, e.target.value as RoleName))}>
                    <option>OWNER</option><option>EDITOR</option><option>VIEWER</option>
                  </select>
                  <button className="link" onClick={() => void act(() => api.removeMember(workspaceId, m.id))}>remove</button>
                </>
              ) : (
                <span className={`badge ${m.role.toLowerCase()}`}>{m.role}</span>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form className="row small" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.addMember(workspaceId, inviteEmail, inviteRole); setInviteEmail(""); }); }}>
            <input type="email" placeholder="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as RoleName)}>
              <option>EDITOR</option><option>VIEWER</option><option>OWNER</option>
            </select>
            <button type="submit">Add</button>
          </form>
        )}
        {error && <div className="error">{error}</div>}
      </aside>
      <section className="main">
        <nav className="tabs">
          {tabs.map((t) => (
            <span key={t.id} className={`tab ${t.id === active ? "active" : ""}`}>
              <button onClick={() => setActive(t.id)}>{t.path.split("/").pop()}</button>
              <button className="close" onClick={() => closeTab(t.id)} aria-label="close">×</button>
            </span>
          ))}
        </nav>
        {activeDoc ? (
          <Editor key={activeDoc.id} docId={activeDoc.id} path={activeDoc.path} userId={user.id} userName={user.name} onClosed={(r) => { setError(r); closeTab(activeDoc.id); void load(); }} />
        ) : (
          <div className="center muted">Open a file from the tree.</div>
        )}
      </section>
    </div>
  );
}
