import { useEffect, useState, type FormEvent } from "react";

import { api, type WorkspaceSummary } from "./api";

export function WorkspaceList() {
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = () => api.workspaces().then((r) => setItems(r.workspaces), (e) => setError(e.message));
  useEffect(() => void load(), []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.createWorkspace(name);
      setName("");
      location.hash = `#/w/${r.workspace.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="page">
      <h2>Workspaces</h2>
      {error && <div className="error">{error}</div>}
      <ul className="list">
        {items.map((w) => (
          <li key={w.id}>
            <a href={`#/w/${w.id}`}>{w.name}</a> <span className={`badge ${w.role.toLowerCase()}`}>{w.role}</span>
          </li>
        ))}
        {items.length === 0 && <li className="muted">No workspaces yet.</li>}
      </ul>
      <form onSubmit={create} className="row">
        <input placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <button type="submit">Create</button>
      </form>
    </main>
  );
}
