export const backendBase = process.env.NEXT_PUBLIC_BACKEND_API_URL ?? 'http://localhost:4000/api';

function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('mini-erm-token');
}

/* ═══════════════ In-memory GET cache (stale-while-revalidate) ═══════════════ */

type CacheEntry = { data: unknown; ts: number };
const cache = new Map<string, CacheEntry>();
const refreshing = new Set<string>();

// Default TTL: 60s — data stays fresh for 1 minute
const DEFAULT_TTL = 60_000;

// Stale window: serve stale data up to 5 min while refreshing in background
const STALE_WINDOW = 300_000;

// Paths that should never be cached (always fresh)
const NO_CACHE_PATHS = ['/auth/'];

function shouldCache(path: string): boolean {
  return !NO_CACHE_PATHS.some((p) => path.includes(p));
}

function getCached<T>(key: string, ttl: number): { data: T; stale: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age > ttl + STALE_WINDOW) {
    cache.delete(key);
    return null;
  }
  return { data: entry.data as T, stale: age > ttl };
}

/** Invalidate all cache entries whose key starts with the given path prefix */
export function invalidateCache(pathPrefix?: string) {
  if (!pathPrefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(pathPrefix)) cache.delete(key);
  }
}

/* ═══════════════ Main API request ═══════════════ */

export async function apiRequest<T>(
  path: string,
  options?: RequestInit & { cacheTtl?: number },
): Promise<T> {
  const method = (options?.method || 'GET').toUpperCase();
  const isGet = method === 'GET';
  const ttl = options?.cacheTtl ?? DEFAULT_TTL;

  // Stale-while-revalidate for GET requests
  if (isGet && shouldCache(path)) {
    const hit = getCached<T>(path, ttl);
    if (hit) {
      if (!hit.stale) return hit.data;
      // Data is stale — return it immediately and refresh in the background
      if (!refreshing.has(path)) {
        refreshing.add(path);
        fetchFresh<T>(path, options).then((fresh) => {
          cache.set(path, { data: fresh, ts: Date.now() });
        }).finally(() => refreshing.delete(path));
      }
      return hit.data;
    }
  }

  const data = await fetchFresh<T>(path, options);

  // Cache GET responses
  if (isGet && shouldCache(path)) {
    cache.set(path, { data, ts: Date.now() });
  }

  // Invalidate related cache on mutations (POST/PUT/DELETE)
  if (!isGet) {
    const base = '/' + path.split('/').filter(Boolean)[0];
    invalidateCache(base);
  }

  return data;
}

async function fetchFresh<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const token = getAuthToken();
  const response = await fetch(`${backendBase}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;

  return await response.json() as T;
}
