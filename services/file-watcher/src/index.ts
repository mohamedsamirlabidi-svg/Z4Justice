import 'dotenv/config';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import chokidar from 'chokidar';

const watchFolder = process.env.WATCH_FOLDER;
const watchFoldersRaw = process.env.WATCH_FOLDERS;
const ingestUrl = process.env.BACKEND_INGEST_URL;
const ingestKey = process.env.INGEST_API_KEY;

if ((!watchFolder && !watchFoldersRaw) || !ingestUrl) {
  throw new Error('WATCH_FOLDERS (or WATCH_FOLDER) and BACKEND_INGEST_URL are required in environment variables.');
}

const watchFolders = (watchFoldersRaw ?? watchFolder ?? '')
  .split(';')
  .map((folder) => folder.trim())
  .filter((folder) => folder.length > 0);

if (watchFolders.length === 0) {
  throw new Error('No valid watch folder found. Provide WATCH_FOLDERS or WATCH_FOLDER.');
}

function normalizeIngestEndpoint(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete('processNow');
    return url.toString();
  } catch {
    // Fallback for non-standard URL formats
    return rawUrl.replace(/[?&]processNow=true/gi, '').replace(/[?&]$/, '');
  }
}

const ingestEndpoint = normalizeIngestEndpoint(ingestUrl);
const shouldBackfillOnStart = (process.env.BACKFILL_ON_START ?? 'true').toLowerCase() !== 'false';
const backendReadyTimeoutMs = Number(process.env.BACKEND_READY_TIMEOUT_MS ?? 120000);
const syncRetryDelayMs = Number(process.env.SYNC_RETRY_DELAY_MS ?? 5000);
const syncRequestTimeoutMs = Number(process.env.SYNC_REQUEST_TIMEOUT_MS ?? 120000);

const acceptedExtensions = new Set(['.pdf', '.xls', '.xlsx', '.csv']);
const syncedPaths = new Set<string>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backendHealthUrlFromIngestUrl(url: string): string {
  return url.replace(/\/api\/files\/ingest\/?$/i, '/health');
}

async function waitForBackendReady(): Promise<boolean> {
  const healthUrl = backendHealthUrlFromIngestUrl(ingestEndpoint);
  const start = Date.now();

  while (Date.now() - start < backendReadyTimeoutMs) {
    try {
      const response = await axios.get(healthUrl, { timeout: 3000 });
      if (response.status >= 200 && response.status < 300) {
        return true;
      }
    } catch {
      // keep retrying until timeout
    }

    await sleep(1500);
  }

  return false;
}

const watcher = chokidar.watch(watchFolders, {
  persistent: true,
  // Initial files are handled by runStartupBackfill to avoid duplicate ingestion storms.
  ignoreInitial: true,
  depth: 5
});

function shouldSkipFile(fullPath: string): boolean {
  const base = path.basename(fullPath);

  // Skip Office temporary/lock files and hidden artifacts.
  if (base.startsWith('~$') || base.startsWith('._')) {
    return true;
  }

  return false;
}

async function sendToBackend(fullPath: string, attempt = 0) {
  const normalizedPath = path.normalize(fullPath).toLowerCase();
  if (syncedPaths.has(normalizedPath)) {
    return;
  }

  const extension = path.extname(fullPath).toLowerCase();
  if (!acceptedExtensions.has(extension)) {
    return;
  }

  if (shouldSkipFile(fullPath)) {
    return;
  }

  try {
    await axios.post(
      ingestEndpoint,
      { fullPath },
      {
        headers: ingestKey ? { 'x-ingest-key': ingestKey } : undefined,
        timeout: syncRequestTimeoutMs
      }
    );
    syncedPaths.add(normalizedPath);
    console.log(`[SYNC] queued: ${fullPath}`);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code ?? 'UNKNOWN')
        : 'UNKNOWN';
    const message = error instanceof Error ? error.message : 'sync error';

    console.error(`[SYNC] failed: ${fullPath} (code=${code}) ${message}`);

    if ((code === 'ECONNREFUSED' || code === 'ECONNABORTED' || code === 'ETIMEDOUT') && attempt < 3) {
      await sleep(syncRetryDelayMs);
      await sendToBackend(fullPath, attempt + 1);
    }
  }
}

async function collectFilesRecursively(folder: string, maxDepth = 10): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string, depth: number) {
    if (depth > maxDepth) {
      return;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(folder, 0);
  return results;
}

async function runStartupBackfill() {
  if (!shouldBackfillOnStart) {
    console.log('[WATCHER] startup backfill disabled (BACKFILL_ON_START=false).');
    return;
  }

  let scanned = 0;
  let matched = 0;

  for (const folder of watchFolders) {
    const files = await collectFilesRecursively(folder);
    scanned += files.length;

    for (const filePath of files) {
      const extension = path.extname(filePath).toLowerCase();
      if (!acceptedExtensions.has(extension)) {
        continue;
      }

      if (shouldSkipFile(filePath)) {
        continue;
      }

      matched += 1;
      await sendToBackend(filePath);
    }
  }

  console.log(`[WATCHER] startup backfill finished. scanned=${scanned}, matched=${matched}`);
}

watcher.on('add', (filePath) => {
  void sendToBackend(filePath);
});
watcher.on('change', (filePath) => {
  void sendToBackend(filePath);
});
watcher.on('ready', async () => {
  console.log(`[WATCHER] listening on: ${watchFolders.join(' ; ')}`);
  console.log(`[WATCHER] ingest endpoint: ${ingestEndpoint}`);
  console.log(`[WATCHER] sync request timeout: ${syncRequestTimeoutMs}ms`);
  const backendReady = await waitForBackendReady();
  if (!backendReady) {
    console.error(`[WATCHER] backend is not reachable after ${backendReadyTimeoutMs}ms. Startup backfill skipped.`);
    return;
  }

  console.log('[WATCHER] backend reachable. Starting startup backfill...');
  await runStartupBackfill();
});
