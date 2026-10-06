import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  callSchema,
  identifier,
  VERSION,
  asOutcome,
  type Outcome,
  type Call,
} from "../protocol/index.js";

export interface McpRelay {
  instances(
    grant: string,
    options: { deviceId?: string; cursor?: string; limit?: number },
  ): Outcome | Promise<Outcome>;
  call(grant: string, input: Call): Promise<Outcome>;
}
export async function mcp(request: Request, relay: McpRelay, grantId: string) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const wrap = async (action: () => Outcome | Promise<Outcome>) => {
    let outcome: Outcome;
    try {
      outcome = await action();
    } catch (e) {
      outcome = asOutcome(e);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      isError: Boolean(outcome.error),
    };
  };
  const server = new McpServer({ name: "siyin", version: VERSION });
  server.registerTool(
    "instances_list",
    {
      description:
        "List approved runtime instances, including offline devices. Use immutable deviceId and instanceId for subsequent calls.",
      inputSchema: z.strictObject({
        deviceId: identifier.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    (input) => wrap(() => relay.instances(grantId, input)),
  );
  server.registerTool(
    "instance_describe",
    {
      description:
        "Read native method schemas and local policy before calling an instance. Paginate using cursor or select method.",
      inputSchema: z.strictObject({
        deviceId: identifier,
        instanceId: identifier,
        method: z.string().optional(),
        cursor: z.string().optional(),
      }),
    },
    ({ deviceId, instanceId, ...params }) =>
      wrap(() =>
        relay.call(grantId, {
          deviceId,
          instanceId,
          method: "siyin.describe",
          params,
        }),
      ),
  );
  server.registerTool(
    "runtime_call",
    {
      description:
        "Call a native method on one approved instance. accepted means backend confirmation, not task completion. starting has a native query key. After unknown or transport failure, inspect native state; never blindly repeat a write. Use instance_describe to discover supported input/approval methods. Poll requests.list only if that instance advertises it; Herdr uses agent state and terminal output instead. Never infer approval from silence.",
      inputSchema: callSchema,
    },
    (input) => wrap(() => relay.call(grantId, input)),
  );
  // v0.1 deliberately uses finite JSON responses. A per-request SSE stream would
  // hold the Worker open even when the device has already started the task.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
