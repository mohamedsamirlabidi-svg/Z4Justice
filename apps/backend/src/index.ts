import 'dotenv/config';
import { app } from './app';
import { prisma } from './prisma';
import { startScheduler } from './scheduler';

const port = Number(process.env.PORT ?? 4000);
const maxDbConnectAttempts = Number(process.env.DB_CONNECT_RETRIES ?? 10);
const dbRetryDelayMs = Number(process.env.DB_CONNECT_RETRY_DELAY_MS ?? 3000);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDnsOrNetworkError(err: unknown) {
  const text = String(err ?? '').toLowerCase();
  return (
    text.includes('dns resolution') ||
    text.includes('socket operation was attempted to an unreachable network') ||
    text.includes('os error 10051')
  );
}

async function connectWithRetry() {
  for (let attempt = 1; attempt <= maxDbConnectAttempts; attempt += 1) {
    try {
      await prisma.$connect();
      console.log('Database connected');
      return;
    } catch (err) {
      const remaining = maxDbConnectAttempts - attempt;
      console.error(
        `Database connect attempt ${attempt}/${maxDbConnectAttempts} failed:`,
        err
      );

      if (isDnsOrNetworkError(err)) {
        console.error(
          'Detected DNS/network issue while resolving MongoDB Atlas SRV records. ' +
            'If this persists, try setting DNS to 1.1.1.1 or 8.8.8.8, or use a direct mongodb:// host list URI.'
        );
      }

      if (remaining <= 0) {
        throw err;
      }

      await sleep(dbRetryDelayMs);
    }
  }
}

async function start() {
  // Warm up the database connection before accepting requests
  await connectWithRetry();

  startScheduler();

  app.listen(port, () => {
    console.log(`Backend running on http://localhost:${port}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
