/**
 * Shared capacity. Everyone uses the same Claude API key and the same PubMed allowance, so the server rations
 * them: a queue in front of Claude, and per-visitor quotas so one visitor cannot use up what the others need.
 */

/** Runs at most `n` tasks at a time; the rest wait their turn (first come, first served). */
export function queue(n: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (running >= n) await new Promise<void>(resolve => waiting.push(resolve));
    running += 1;
    try {
      return await task();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** Claude calls in flight across all visitors (reading files, planning searches, writing reports). */
export const claude = queue(Math.max(1, Number(process.env.CLAUDE_CONCURRENCY) || 4));

const windows: Map<string, number[]>[] = [];

/**
 * A quota of `limit` events per `ms` for each key (a visitor's IP). `take(key)` records one and says whether it was
 * allowed. A limit of 0 means no limit.
 */
export function quota(limit: number, ms: number) {
  const hits = new Map<string, number[]>();
  windows.push(hits);
  return {
    take(key: string) {
      if (!limit) return true;
      const now = Date.now();
      const list = (hits.get(key) ?? []).filter(t => now - t < ms);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    ms,
  };
}

/** Forgets visitors whose events have all aged out (run now and then, so the maps do not grow forever). */
export function sweepQuotas(maxAge = 24 * 3600_000) {
  const now = Date.now();
  for (const hits of windows) for (const [k, list] of hits) if (!list.some(t => now - t < maxAge)) hits.delete(k);
}
