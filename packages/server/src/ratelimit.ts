// Token bucket: `capacity` tokens, refilled continuously at `ratePerSec`.
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private readonly ratePerSec: number, private readonly capacity: number, private readonly now: () => number = Date.now) {
    this.tokens = capacity;
    this.last = now();
  }
  take(n = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

// Keyed buckets with bounded memory (oldest keys evicted), for per-IP and
// per-account limits.
export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(private readonly ratePerSec: number, private readonly capacity: number, private readonly maxKeys = 100_000, private readonly now: () => number = Date.now) {}
  take(key: string, n = 1): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      b = new TokenBucket(this.ratePerSec, this.capacity, this.now);
      this.buckets.set(key, b);
    }
    return b.take(n);
  }
}

// Limiter used for login and registration. With several nodes the limits
// must be shared, otherwise an attacker gets N times the attempts by
// spreading requests over the nodes: RedisLimiter counts in fixed windows in
// Redis; if Redis is unreachable it falls back to the local limiter.
export interface AsyncLimiter {
  take(key: string): Promise<boolean>;
}

export class LocalLimiter implements AsyncLimiter {
  private inner: KeyedLimiter;
  constructor(perWindow: number, windowMs: number) {
    this.inner = new KeyedLimiter(perWindow / (windowMs / 1000), Math.max(1, perWindow));
  }
  async take(key: string): Promise<boolean> {
    return this.inner.take(key);
  }
}

interface RedisMulti {
  incr(k: string): RedisMulti;
  pexpire(k: string, ms: number, mode: "NX"): RedisMulti;
  exec(): Promise<[Error | null, unknown][] | null>;
}
export interface RedisLike {
  multi(): RedisMulti;
}

export class RedisLimiter implements AsyncLimiter {
  constructor(
    private readonly redis: RedisLike,
    private readonly name: string,
    private readonly perWindow: number,
    private readonly windowMs: number,
    private readonly fallback: AsyncLimiter,
    private readonly onError: (err: Error) => void,
  ) {}
  async take(key: string): Promise<boolean> {
    const k = `tandem:rl:${this.name}:${Math.floor(Date.now() / this.windowMs)}:${key}`;
    try {
      const res = await this.redis.multi().incr(k).pexpire(k, this.windowMs, "NX").exec();
      const count = Number(res?.[0]?.[1]);
      if (!Number.isFinite(count)) throw new Error("unexpected Redis reply");
      return count <= this.perWindow;
    } catch (err) {
      this.onError(err as Error);
      return this.fallback.take(key);
    }
  }
}
