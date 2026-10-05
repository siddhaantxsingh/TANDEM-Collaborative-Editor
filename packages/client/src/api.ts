// Typed wrapper over the HTTP API. The session lives in an httpOnly cookie,
// so the client never handles tokens.
export interface User { id: string; email: string; name: string }
export type RoleName = "OWNER" | "EDITOR" | "VIEWER";
export interface WorkspaceSummary { id: string; name: string; role: RoleName }
export interface Member { id: string; name: string; email: string; role: RoleName }
export interface DocumentInfo { id: string; path: string; updated_at?: string }
export interface WorkspaceDetail { workspace: WorkspaceSummary; members: Member[]; documents: DocumentInfo[] }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The server could not be reached (offline, or the server is down). */
export class OfflineError extends Error {
  constructor() {
    super("The server cannot be reached. Editing works offline; this action needs the server.");
  }
}

// GET responses are kept in localStorage so that the app can start and show
// workspaces and files while offline (documents themselves are in
// IndexedDB). Cleared on logout.
const CACHE_PREFIX = "tandem:get:";

function cacheGet<T>(path: string): T | undefined {
  try {
    const v = localStorage.getItem(CACHE_PREFIX + path);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function cachePut(path: string, data: unknown) {
  try {
    localStorage.setItem(CACHE_PREFIX + path, JSON.stringify(data));
  } catch {
    /* quota or disabled storage: the cache is optional */
  }
}

export function clearCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

/** Set when the last GET was answered from the offline cache. */
export let servedFromCache = false;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    if (method === "GET") {
      const cached = cacheGet<T>(path);
      if (cached !== undefined) {
        servedFromCache = true;
        return cached;
      }
    }
    throw new OfflineError();
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status >= 502 && res.status <= 504 && method === "GET") {
      const cached = cacheGet<T>(path); // server unreachable behind the proxy
      if (cached !== undefined) {
        servedFromCache = true;
        return cached;
      }
    }
    throw new ApiError(res.status, (data.error as string) ?? `request failed (${res.status})`);
  }
  if (method === "GET") {
    servedFromCache = false;
    cachePut(path, data);
  }
  // Logging in also tells us who we are, for a later offline start.
  if (path === "/api/auth/login" || path === "/api/auth/register") cachePut("/api/me", data);
  return data as T;
}

export const api = {
  me: () => call<{ user: User }>("GET", "/api/me"),
  login: (email: string, password: string) => call<{ user: User }>("POST", "/api/auth/login", { email, password }),
  register: (email: string, password: string, name: string) => call<{ user: User }>("POST", "/api/auth/register", { email, password, name }),
  logout: () => call<{ ok: boolean }>("POST", "/api/auth/logout", {}),
  workspaces: () => call<{ workspaces: WorkspaceSummary[] }>("GET", "/api/workspaces"),
  createWorkspace: (name: string) => call<{ workspace: WorkspaceSummary }>("POST", "/api/workspaces", { name }),
  workspace: (id: string) => call<WorkspaceDetail>("GET", `/api/workspaces/${id}`),
  addMember: (wid: string, email: string, role: RoleName) => call<{ member: Member }>("POST", `/api/workspaces/${wid}/members`, { email, role }),
  setRole: (wid: string, uid: string, role: RoleName) => call<{ ok: boolean }>("PATCH", `/api/workspaces/${wid}/members/${uid}`, { role }),
  removeMember: (wid: string, uid: string) => call<{ ok: boolean }>("DELETE", `/api/workspaces/${wid}/members/${uid}`),
  createDocument: (wid: string, path: string) => call<{ document: DocumentInfo }>("POST", `/api/workspaces/${wid}/documents`, { path }),
  renameDocument: (id: string, path: string) => call<{ document: DocumentInfo }>("PATCH", `/api/documents/${id}`, { path }),
  deleteDocument: (id: string) => call<{ ok: boolean }>("DELETE", `/api/documents/${id}`),
};
