import type { PluginAPI, Subscription, ThreadID } from "@ampcode/plugin";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa as exec } from "execa";
import { z } from "zod";
import { nativeSchemas, readOnly, type NativeMethod } from "./methods.js";

const connection = z.strictObject({
  port: z.number().int().min(1).max(65535),
  token: z.string().length(64),
});
const request = z.strictObject({
  id: z.string().uuid(),
  method: z.enum(
    Object.keys(nativeSchemas) as [NativeMethod, ...NativeMethod[]],
  ),
  params: z.record(z.string(), z.unknown()),
});
const maxFrame = 64 * 1024;

// The native host owns execution. Losing this bridge only drops subscriptions;
// it never cancels, archives, or resubmits work.
export default function attach(
  amp: PluginAPI,
  settings: { bridgeDir: string; binary: string },
) {
  let stopped = false;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active = 0;
  const subscriptions = new Map<string, Subscription>();
  const hooks: Subscription[] = [];
  const clear = () => {
    for (const subscription of subscriptions.values())
      subscription.unsubscribe();
    subscriptions.clear();
  };
  function send(packet: unknown, current = socket) {
    if (!current || current.readyState !== WebSocket.OPEN) return;
    const value = JSON.stringify(packet);
    if (
      Buffer.byteLength(value) > maxFrame ||
      current.bufferedAmount > maxFrame * 16
    ) {
      current.close(1009, "bridge_capacity");
      return;
    }
    current.send(value);
  }
  const event = (
    threadId: string,
    type: string,
    native: Record<string, unknown>,
  ) => send({ type: "event", threadId, nativeType: type, native });
  hooks.push(amp.on("tool.call", () => ({ action: "allow" })));
  hooks.push(
    amp.on("agent.start", (e) => {
      event(e.thread.id, "agent.start", { messageId: e.id });
      return {};
    }),
  );
  hooks.push(
    amp.on("agent.end", (e) => {
      event(e.thread.id, "agent.end", { messageId: e.id, status: e.status });
    }),
  );
  async function dispatch(
    method: NativeMethod,
    input: Record<string, unknown>,
  ) {
    const p = nativeSchemas[method].parse(input) as any;
    if (method === "amp.threads.list") {
      const { stdout } = await exec(
        settings.binary,
        [
          "threads",
          "list",
          "--json",
          "--limit",
          String(p.limit),
          "--offset",
          String(p.offset),
          ...(p.includeArchived ? ["--include-archived"] : []),
        ],
        { timeout: 7000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout);
    }
    if (method === "amp.threads.create") {
      const thread = await amp
        .getBuiltinAgent(p.mode)
        .createThread({ visibility: "private", executor: "local" });
      return { threadId: thread.id };
    }
    const thread = amp.threads.get(p.threadId as ThreadID);
    switch (method) {
      case "amp.threads.get":
        return {
          threadId: thread.id,
          title: await thread.title.get(),
          state: await thread.state.get(),
        };
      case "amp.threads.subscribe":
        if (!subscriptions.has(thread.id)) {
          if (subscriptions.size >= 128)
            throw new Error("Native subscription capacity reached (128)");
          subscriptions.set(
            thread.id,
            thread.state.subscribe((state) =>
              event(thread.id, "thread.state", { state }),
            ),
          );
        }
        return { threadId: thread.id, subscribed: true };
      case "amp.threads.read":
        return {
          items: await thread.messages({
            from: "start",
            full: true,
            offset: p.offset,
            limit: p.limit,
          }),
        };
      case "amp.threads.send":
        await thread.appendUserMessage(
          { type: "user-message", content: p.text },
          { steer: p.steer },
        );
        return { threadId: thread.id, confirmation: "native_input_accepted" };
      case "amp.threads.cancel":
        await thread.cancel();
        return { threadId: thread.id, interruption: "requested" };
    }
  }
  async function connect() {
    if (stopped) return;
    try {
      const endpoint = connection.parse(
        JSON.parse(
          await readFile(join(settings.bridgeDir, "connection.json"), "utf8"),
        ),
      );
      if (stopped) return;
      const current = (socket = new WebSocket(
        `ws://127.0.0.1:${endpoint.port}`,
      ));
      const timeout = setTimeout(() => current.close(), 5000);
      current.onopen = () => {
        clearTimeout(timeout);
        send(
          {
            type: "hello",
            token: endpoint.token,
            cwd: amp.system.workspaceRoot
              ? amp.helpers.filePathFromURI(amp.system.workspaceRoot)
              : process.cwd(),
            userId: amp.system.user?.id ?? null,
          },
          current,
        );
      };
      current.onmessage = async (message) => {
        let id: string | undefined;
        let method: NativeMethod | undefined;
        try {
          if (
            typeof message.data !== "string" ||
            Buffer.byteLength(message.data) > maxFrame
          )
            throw new Error("Invalid bridge frame");
          const packet = request.parse(JSON.parse(message.data));
          id = packet.id;
          method = packet.method;
          const parsed = nativeSchemas[method].safeParse(packet.params);
          if (!parsed.success || active >= 16) {
            send(
              {
                type: "response",
                id,
                outcome: {
                  execution: "not_started",
                  error: {
                    code: parsed.success
                      ? "resource_exhausted"
                      : "invalid_params",
                    message: "Request was not dispatched",
                  },
                },
              },
              current,
            );
            return;
          }
          active++;
          try {
            const result = await dispatch(method, parsed.data);
            const outcome = {
              execution: "accepted",
              result,
              ...(typeof result?.threadId === "string"
                ? { nativeIds: { threadId: result.threadId } }
                : {}),
            };
            if (Buffer.byteLength(JSON.stringify(outcome)) > maxFrame - 1024) {
              send(
                {
                  type: "response",
                  id,
                  outcome: {
                    execution: "accepted",
                    nativeIds: outcome.nativeIds,
                    error: {
                      code: "result_too_large",
                      message: "Use a smaller page or native Amp history",
                    },
                  },
                },
                current,
              );
            } else send({ type: "response", id, outcome }, current);
          } finally {
            active--;
          }
        } catch (error) {
          if (!id || !method) {
            current.close(1008, "invalid_request");
            return;
          }
          send(
            {
              type: "response",
              id,
              outcome: {
                execution: readOnly(method) ? "rejected" : "unknown",
                error: {
                  code: "amp_error",
                  message: String(error).slice(0, 4000),
                },
              },
            },
            current,
          );
        }
      };
      current.onerror = () => current.close();
      current.onclose = () => {
        clearTimeout(timeout);
        if (socket !== current) return;
        clear();
        socket = undefined;
        if (!stopped) retry = setTimeout(connect, 1000);
      };
    } catch {
      if (!stopped) retry = setTimeout(connect, 1000);
    }
  }
  void connect();
  const dispose = () => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
    clear();
    for (const hook of hooks) hook.unsubscribe();
  };
  amp.onDispose(dispose);
  return dispose;
}
