type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const store = new Map<string, CacheEntry<unknown>>();

// Periodic cleanup of expired entries (every 2 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}, 120_000);

export function cacheClear() {
  store.clear();
}

export function cacheDeleteByPrefix(prefix: string) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): T {
  store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
  return value;
}

export async function cacheGetOrSet<T>(key: string, ttlMs: number, factory: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = await factory();
  return cacheSet(key, value, ttlMs);
}
