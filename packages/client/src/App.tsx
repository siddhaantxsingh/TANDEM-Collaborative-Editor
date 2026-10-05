import { useEffect, useState } from "react";

import { api, clearCache, servedFromCache, type User } from "./api";
import { Login } from "./Login";
import { resetConnection } from "./sync";
import { WorkspaceList } from "./WorkspaceList";
import { WorkspaceView } from "./WorkspaceView";

// Minimal hash routing: #/ (workspaces) and #/w/<id>.
function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [offlineStart, setOfflineStart] = useState(false);
  const hash = useHash();

  useEffect(() => {
    api.me().then(
      (r) => {
        setUser(r.user);
        setOfflineStart(servedFromCache); // started without the server
      },
      () => setUser(null),
    );
  }, []);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (user === null) return <Login onLogin={setUser} />;

  const logout = async () => {
    await api.logout().catch(() => {});
    resetConnection();
    clearCache();
    setUser(null);
    location.hash = "";
  };

  const m = /^#\/w\/([0-9a-f-]{36})/.exec(hash);
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">Tandem</a>
        <span className="spacer" />
        <span className="muted" data-testid="current-user">{user.name}</span>
        <button className="link" onClick={logout}>Log out</button>
      </header>
      {offlineStart && (
        <div className="banner info" role="status">
          Started offline: showing the last known workspaces and files. Edits are kept on this device and saved when the server is reachable.
        </div>
      )}
      {m ? <WorkspaceView key={m[1]} workspaceId={m[1]!} user={user} /> : <WorkspaceList />}
    </div>
  );
}
