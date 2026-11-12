// Load local .env file if present in route-builder via process.loadEnvFile
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
