import { logger } from "@agenvo/logging";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { subscribeInput, unsubscribeInput } from "@agenvo/protocol/events";
import { Fault } from "@agenvo/protocol";
import { z } from "zod";
import {
  callSchema,
  identifier,
  VERSION,
  asOutcome,
  type Outcome,
  type Call,
} from "@agenvo/protocol";

const log = logger.child({ component: "relay.mcp" });

export interface McpRelay {
  instances(
    grant: string,
    options: { deviceId?: string; cursor?: string; limit?: number },
  ): Outcome | Promise<Outcome>;
  call(grant: string, input: Call): Promise<Outcome>;
  eventsList(grant: string): unknown;
  eventsSubscribe(grant: string, input: unknown): Promise<unknown>;
  eventsUnsubscribe(grant: string, input: unknown): Promise<unknown>;
}
export async function mcp(request: Request, relay: McpRelay, grantId: string) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const wrap = async (
    tool: string,
    action: () => Outcome | Promise<Outcome>,
    target?: Pick<Call, "deviceId" | "instanceId" | "method">,
  ) => {
    const started = Date.now();
    let outcome: Outcome;
    let error: unknown;
    try {
      outcome = await action();
    } catch (e) {
      outcome = asOutcome(e);
      if (outcome.error?.code === "internal_error") error = e;
    }
    outcome.requestId ??= crypto.randomUUID();
    const fields = {
      event: "mcp.tool.completed",
      tool,
      ...target,
      requestId: outcome.requestId,
      execution: outcome.execution,
      errorCode: outcome.error?.code,
      durationMs: Date.now() - started,
      ...(error === undefined ? {} : { err: error }),
    };
    if (outcome.error) {
      const level = outcome.error.code === "internal_error" ? "error" : "warn";
      log[level](fields, "MCP tool %s failed: %s", tool, outcome.error.code);
    } else {
      log.info(fields, "MCP tool %s completed", tool);
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      isError: Boolean(outcome.error),
    };
  };
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "agenvo", version: VERSION });
      server.registerTool(
        "instances_list",
        {
          annotations: { readOnlyHint: true },
          description:
            "List approved runtime instances, including offline Connectors. deviceId identifies one Connector, not a physical computer; use it with instanceId for subsequent calls.",
          inputSchema: z.strictObject({
            deviceId: identifier.optional(),
            cursor: z.string().optional(),
            limit: z.number().int().min(1).max(50).optional(),
          }),
        },
        (input) =>
          wrap("instances_list", () => relay.instances(grantId, input)),
      );
      server.registerTool(
        "instance_describe",
        {
          annotations: { readOnlyHint: true },
          description:
            "Read management capabilities, method schemas and execution behavior before calling an instance. Paginate using cursor or select method.",
          inputSchema: z.strictObject({
            deviceId: identifier,
            instanceId: identifier,
            method: z.string().optional(),
            cursor: z.string().optional(),
          }),
        },
        ({ deviceId, instanceId, ...params }) =>
          wrap(
            "instance_describe",
            () =>
              relay.call(grantId, {
                deviceId,
                instanceId,
                method: "siyin.describe",
                params,
              }),
            { deviceId, instanceId, method: "siyin.describe" },
          ),
      );
      server.registerTool(
        "runtime_call",
        {
          description:
            "Call an advertised management.* or native method on one approved instance. accepted means backend confirmation, not task completion. starting has a native query key. After unknown or transport failure, inspect native state; never blindly repeat a write. Use instance_describe to discover capabilities. Prefer management.services.list, then management.threads.*. Subscribe to runtime.changed for native changes, then read management.threads.observe with threadRef for current state, output and pending interactions. Poll when events are unavailable; inspect gaps. Permission approvals are automatic; user questions remain explicit interactions.",
          inputSchema: callSchema,
        },
        (input) =>
          wrap("runtime_call", () => relay.call(grantId, input), {
            deviceId: input.deviceId,
            instanceId: input.instanceId,
            method: input.method,
          }),
      );
      const capabilities = { tools: {}, events: {} };
      server.server.registerCapabilities(capabilities);
      const eventCall = async (action: () => unknown) => {
        try {
          return await action();
        } catch (error) {
          throw new ProtocolError(
            (error instanceof Fault
              ? error.code
              : error instanceof Error
                ? error.message
                : "") === "callback_endpoint_error"
              ? -32015
              : -32602,
            error instanceof Fault
              ? error.code
              : error instanceof Error &&
                  [
                    "permission_denied",
                    "callback_endpoint_error",
                    "resource_exhausted",
                  ].includes(error.message)
                ? error.message
                : "invalid_params",
          );
        }
      };
      server.server.setRequestHandler(
        "events/list",
        {
          params: z.object({ cursor: z.string().optional() }),
          result: z.any(),
        },
        () => eventCall(() => relay.eventsList(grantId)),
      );
      server.server.setRequestHandler(
        "events/subscribe",
        { params: subscribeInput, result: z.any() },
        (p) => eventCall(() => relay.eventsSubscribe(grantId, p)),
      );
      server.server.setRequestHandler(
        "events/unsubscribe",
        { params: unsubscribeInput, result: z.any() },
        (p) => eventCall(() => relay.eventsUnsubscribe(grantId, p)),
      );
      return server;
    },
    { responseMode: "auto", maxRequestBodySize: 65536 },
  );
  return handler.fetch(request);
}
