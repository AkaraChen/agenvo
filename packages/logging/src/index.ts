import pino from "pino";

// Error messages and causes can contain native output, URLs or credentials.
// Retain the error type and call sites without copying those payloads into logs.
function serializeError(error: unknown) {
  if (!(error instanceof Error)) return { type: typeof error };
  const header = `${error.name}: ${error.message}`;
  const stack = error.stack?.startsWith(header + "\n")
    ? error.stack.slice(header.length + 1)
    : undefined;
  return { type: error.name, stack };
}

const formatters = { level: (level: string) => ({ level }) };

// Wrangler resolves Pino's browser entry: each console call receives one object
// and the Node destination is ignored. Node writes JSON Lines to stderr so CLI
// results on stdout remain machine-readable.
export const logger = pino(
  {
    level: "info",
    base: null,
    messageKey: "message",
    formatters,
    serializers: { err: serializeError },
    browser: { asObject: true, serialize: ["err"], formatters },
  },
  { write: (line) => process.stderr.write(line) },
).child({ service: "agenvo" });
