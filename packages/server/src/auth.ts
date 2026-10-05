// Password hashing (scrypt), sessions (random tokens stored as SHA-256
// hashes) and cookie handling.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { Db } from "./db.js";

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

// N=2^15, r=8, p=1: ~32 MiB and ~50-100 ms per hash on a server core.
const PARAMS = { N: 1 << 15, r: 8, p: 1 };
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { ...PARAMS, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, "base64");
  const expected = Buffer.from(parts[5]!, "base64");
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A fixed hash used to spend the same time when the email is unknown, so
// response timing does not reveal which accounts exist.
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("not-a-real-password-" + randomBytes(8).toString("hex"));
  return dummyHash;
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest();

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function createSession(db: Db, userId: string, ttlHours: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))", [
    tokenHash(token),
    userId,
    ttlHours,
  ]);
  return token;
}

export async function sessionUser(db: Db, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token || token.length > 100) return undefined;
  const r = await db.query(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
    [tokenHash(token)],
  );
  return r.rows[0] as SessionUser | undefined;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
}

export const SESSION_COOKIE = "tandem_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}
