import { createApp } from './app.js';

// Load local .env file if present in route-builder (Node 20.12+)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  }
} catch (err: unknown) {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code !== 'ENOENT') {
    console.warn('[Server] Notice loading .env file:', err);
  }
}

const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

const app = createApp({ logger: true });

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`🚀 Route Builder Backend running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
};

start();
