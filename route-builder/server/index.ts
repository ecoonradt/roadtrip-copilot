import { createApp } from './app.js';

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
