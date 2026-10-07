import { readBody } from "../protocol/index.js";
import type { WebhookTransport } from "./events.js";

// The authenticated MCP client supplies its callback. Both deployment hosts use
// the platform HTTP client, including its DNS resolution and TLS verification.
export const sendWebhook: WebhookTransport = async (url, body, headers) => {
  const response = await fetch(url, {
    method: "POST",
    body,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await readBody(response, 16384) };
};
