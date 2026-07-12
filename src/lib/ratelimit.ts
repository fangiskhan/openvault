// Minimal in-memory sliding-window rate limiter. Per-process (each serverless
// instance counts separately) — the goal is stopping brute force and runaway
// agent loops, not precise global quotas. No dependencies, no external store.

const buckets = new Map<string, number[]>();
let lastSweep = Date.now();

function sweep(windowMs: number) {
  // Occasionally drop dead buckets so long-running servers don't accrete keys.
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  const cutoff = Date.now() - windowMs;
  for (const [key, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] < cutoff) buckets.delete(key);
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  sweep(windowMs);
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t >= cutoff);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

export function clientKey(req: Request): string {
  // Behind a proxy (Vercel), the left-most forwarded address is the client.
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "local";
}

export function tooMany(hint: string): Response {
  return Response.json({ error: "rate_limited", details: hint }, { status: 429 });
}
