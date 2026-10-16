// Minimal Prometheus text-format metrics (counters, gauges, histograms).
import { monitorEventLoopDelay } from "node:perf_hooks";

type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`)
    .join(",");

class Counter {
  private values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) {}
  inc(labels: Labels = {}, by = 1) {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}) {
    return this.values.get(key(labels)) ?? 0;
  }
  /** Sum over all label combinations. */
  total() {
    let n = 0;
    for (const v of this.values.values()) n += v;
    return n;
  }
  render(): string {
    let s = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n`;
    if (this.values.size === 0) s += `${this.name} 0\n`;
    for (const [k, v] of this.values) s += `${this.name}${k ? `{${k}}` : ""} ${v}\n`;
    return s;
  }
}

class Gauge {
  private fn: () => number = () => 0;
  constructor(readonly name: string, readonly help: string) {}
  set(fn: () => number) {
    this.fn = fn;
  }
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.fn()}\n`;
  }
}

class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) {}
  observe(v: number, labels: Labels = {}) {
    const k = key(labels);
    let h = this.series.get(k);
    if (!h) this.series.set(k, (h = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    h.sum += v;
    h.count++;
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) h.counts[i]!++;
  }
  /** Observations so far (all label combinations). */
  get count() {
    let n = 0;
    for (const h of this.series.values()) n += h.count;
    return n;
  }
  render(): string {
    let s = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    for (const [k, h] of this.series) {
      const l = (extra: string) => `{${[k, extra].filter(Boolean).join(",")}}`;
      this.buckets.forEach((b, i) => (s += `${this.name}_bucket${l(`le="${b}"`)} ${h.counts[i]}\n`));
      s += `${this.name}_bucket${l('le="+Inf"')} ${h.count}\n${this.name}_sum${k ? `{${k}}` : ""} ${h.sum}\n${this.name}_count${k ? `{${k}}` : ""} ${h.count}\n`;
    }
    return s;
  }
}

const LATENCY = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  readonly httpRequests = new Counter("tandem_http_requests_total", "HTTP requests by route and status");
  readonly wsConnections = new Counter("tandem_ws_connections_total", "WebSocket connections accepted");
  readonly wsRejected = new Counter("tandem_ws_rejected_total", "WebSocket upgrades rejected by reason");
  readonly messagesIn = new Counter("tandem_messages_in_total", "Protocol messages received by type");
  readonly updatesApplied = new Counter("tandem_updates_applied_total", "Document updates applied");
  readonly updatesRejected = new Counter("tandem_updates_rejected_total", "Document updates rejected by reason");
  readonly updatesPending = new Counter("tandem_updates_pending_total", "Client updates with missing causal dependencies (stored raw, integrated later)");
  readonly updatesPersisted = new Counter("tandem_updates_persisted_total", "Document updates written to PostgreSQL");
  readonly persistFailures = new Counter("tandem_persist_failures_total", "Failed persistence attempts (retried)");
  readonly compactions = new Counter("tandem_compactions_total", "Document compactions");
  readonly rateLimited = new Counter("tandem_rate_limited_total", "Connections closed for exceeding rate limits, by kind (messages, operations)");
  readonly backpressureDrops = new Counter("tandem_backpressure_disconnects_total", "Connections closed by backpressure, by reason (slow_consumer, server_budget, inbound_queue)");
  readonly protocolErrors = new Counter("tandem_protocol_errors_total", "Connections closed for protocol errors, by reason");
  readonly reconnects = new Counter("tandem_reconnects_total", "Connections that were reconnects of an earlier one (Hello resume > 0)");
  readonly pubsubIn = new Counter("tandem_pubsub_messages_in_total", "Messages received from other nodes");
  readonly sweepRepairs = new Counter("tandem_durability_sweep_repairs_total", "Updates found in memory but not in the database and written by the sweep");
  readonly antiEntropyRepairs = new Counter("tandem_anti_entropy_repairs_total", "Replicas found missing updates (from the database or another node) and repaired");
  readonly staleConnections = new Counter("tandem_stale_connections_closed_total", "Connections closed as stale (heartbeat timeout, superseded by a reconnect)");
  readonly loginFailures = new Counter("tandem_login_failures_total", "Failed login attempts");
  readonly activeConnections = new Gauge("tandem_active_connections", "Open WebSocket connections");
  readonly activeUsers = new Gauge("tandem_active_users", "Distinct users with an open WebSocket connection");
  readonly sendQueueBytes = new Gauge("tandem_send_queue_bytes", "Bytes queued for sending on all connections (outside the socket buffers)");
  readonly reassemblyBytes = new Gauge("tandem_reassembly_bytes", "Bytes of partially received fragmented messages on all connections");
  readonly inboundQueueBytes = new Gauge("tandem_inbound_queue_bytes", "Bytes received but not yet handled on all connections");
  readonly activeRooms = new Gauge("tandem_active_documents", "Documents loaded in memory");
  readonly pendingPersist = new Gauge("tandem_pending_persist_updates", "Updates applied but not yet durable");
  readonly persistLatency = new Histogram("tandem_persist_seconds", "Time to write a batch of updates", LATENCY);
  readonly ackLatency = new Histogram("tandem_ack_latency_seconds", "Time from receiving a client update to acknowledging it (durable)", LATENCY);
  readonly httpLatency = new Histogram("tandem_http_request_seconds", "HTTP API request duration by route", LATENCY);
  readonly dbLatency = new Histogram("tandem_db_query_seconds", "PostgreSQL query duration (pool queries)", LATENCY);
  readonly redisLatency = new Histogram("tandem_redis_seconds", "Redis command duration by operation", LATENCY);
  readonly compactionDuration = new Histogram("tandem_compaction_seconds", "Duration of a document compaction (snapshot write)", LATENCY);
  readonly sweepDuration = new Histogram("tandem_sweep_seconds", "Duration of a durability / anti-entropy sweep of one document", LATENCY);
  readonly messagesOut = new Counter("tandem_messages_out_total", "Protocol messages sent by type");
  readonly errors = new Counter("tandem_errors_total", "Internal errors by component");
  readonly logLines = new Counter("tandem_log_lines_total", "Log lines by level (warn and error)");
  readonly sessionsClosed = new Counter("tandem_ws_session_closed_total", "Live connections closed because their session ended, by reason (logout, logout_all, revalidation, expiry)");
  readonly accessRevalidated = new Counter("tandem_access_revalidation_changes_total", "Live document access changed by periodic revalidation (removed, role, deleted)");
  readonly sessionsExpired = new Counter("tandem_sessions_expired_deleted_total", "Expired sessions deleted");
  readonly processCpu = new Gauge("tandem_process_cpu_seconds", "Process CPU time (user + system)");
  readonly processRss = new Gauge("tandem_process_resident_memory_bytes", "Resident set size");
  readonly processHeap = new Gauge("tandem_process_heap_used_bytes", "V8 heap in use");
  readonly eventLoopLagP99 = new Gauge("tandem_event_loop_lag_p99_seconds", "99th percentile event-loop delay since the last scrape");

  constructor() {
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable();
    this.processCpu.set(() => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1e6;
    });
    this.processRss.set(() => process.memoryUsage().rss);
    this.processHeap.set(() => process.memoryUsage().heapUsed);
    this.eventLoopLagP99.set(() => {
      const v = lag.percentile(99) / 1e9;
      lag.reset();
      return v;
    });
  }

  render(): string {
    return Object.values(this)
      .map((m) => (m as { render(): string }).render())
      .join("");
  }
}
