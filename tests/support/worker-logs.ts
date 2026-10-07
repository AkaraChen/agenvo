// Loaded before the production Worker so Pino binds these test console methods.
// Capture arguments as objects: text matching cannot prove Workers Logs indexing.
export const logs: Array<{ method: string; args: unknown[] }> = [];
for (const method of ["info", "warn", "error"] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    logs.push({ method, args });
    if (logs.length > 100) logs.shift();
    original(...args);
  };
}
