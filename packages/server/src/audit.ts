// Audit log: security-relevant actions (authentication, membership and
// document changes). Written in the same transaction as the change where
// there is one; otherwise right after it (a failure is logged and counted,
// never hidden).
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface AuditEntry {
  actorId: string | null;
  action: string; // e.g. "auth.login", "member.add", "document.delete"
  workspaceId?: string | null;
  target?: string | null;
  details?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    "INSERT INTO audit_log (actor_id, action, workspace_id, target, details, request_id, ip) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [e.actorId, e.action, e.workspaceId ?? null, e.target ?? null, JSON.stringify(e.details ?? {}), e.requestId ?? null, e.ip ?? null],
  );
}

export async function auditBestEffort(q: Queryable, e: AuditEntry, log: Logger, metrics: Metrics): Promise<void> {
  try {
    await audit(q, e);
  } catch (err) {
    metrics.errors.inc({ component: "audit" });
    log.error("audit log write failed", { action: e.action, err: (err as Error).message });
  }
}
