import type { PluginAPI } from "@ampcode/plugin";
import { randomUUID } from "node:crypto";
import attach from "../../apps/amp/src/plugin.js";

// A deterministic native-contract fixture, not an emulation of Amp inference.
// External threads exist before the connector sends anything.
export function ampHost(settings: { bridgeDir: string; binary: string }) {
  const threads = new Map<string, any>();
  const handlers = new Map<string, Set<(e: any) => unknown>>();
  const disposers: Array<() => void> = [];
  const emit = (type: string, event: any) => {
    for (const handler of handlers.get(type) ?? []) handler(event);
  };
  let cancelCount = 0;
  let blockedSend: (() => void) | undefined;
  let holdSend = false;
  let sends = 0;
  function make(id: string) {
    let state = "idle";
    const listeners = new Set<(value: string) => void>();
    const items: any[] = [
      {
        id: "message-initial",
        role: "assistant",
        content: [{ type: "text", text: "EXTERNAL_THREAD_HISTORY" }],
      },
    ];
    const t = {
      id,
      title: { get: async () => "Fixture thread" },
      state: {
        get: async () => state,
        subscribe: (fn: (value: string) => void) => {
          listeners.add(fn);
          return { unsubscribe: () => listeners.delete(fn) };
        },
      },
      messages: async (p: any) => {
        if (!p.full || p.from !== "start")
          throw new Error("Expected full chronological history");
        return items.slice(p.offset, p.offset + p.limit);
      },
      appendUserMessage: async (message: any, options: any) => {
        sends++;
        items.push({
          id: randomUUID(),
          role: "user",
          content: [{ type: "text", text: message.content }],
          steer: options.steer,
        });
        t.change("running");
        emit("agent.start", { thread: { id }, id: "user-message" });
        if (holdSend)
          await new Promise<void>((resolve) => {
            blockedSend = resolve;
          });
      },
      cancel: async () => {
        cancelCount++;
        t.finish("cancelled");
      },
      change: (next: string) => {
        state = next;
        for (const fn of listeners) fn(next);
      },
      finish: (status = "done") => {
        items.push({
          id: randomUUID(),
          role: "assistant",
          content: [{ type: "text", text: "ISOLATED_AMP_RESULT" }],
        });
        t.change(status === "error" ? "error" : "idle");
        emit("agent.end", { thread: { id }, id: "user-message", status });
      },
      get listeners() {
        return listeners.size;
      },
    };
    threads.set(id, t);
    return t;
  }
  make("T-external");
  const api = {
    system: { user: { id: "fixture-user" } },
    threads: {
      get: (id: string) => {
        const t = threads.get(id);
        if (!t) throw new Error("Thread not found");
        return t;
      },
    },
    getBuiltinAgent: () => ({
      createThread: async (p: any) => {
        if (p.executor !== "local" || p.visibility !== "private")
          throw new Error("Invalid creation scope");
        return make("T-" + randomUUID());
      },
    }),
    on: (name: string, handler: (e: any) => unknown) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(handler);
      return { unsubscribe: () => handlers.get(name)!.delete(handler) };
    },
    onDispose: (fn: () => void) => {
      disposers.push(fn);
      return { unsubscribe() {} };
    },
  } as unknown as PluginAPI;
  const stop = attach(api, settings);
  return {
    threads,
    api,
    stop,
    reconnect: () => attach(api, settings),
    get cancelCount() {
      return cancelCount;
    },
    get sends() {
      return sends;
    },
    holdSend() {
      holdSend = true;
    },
    releaseSend() {
      holdSend = false;
      blockedSend?.();
    },
    approve: () => [...handlers.get("tool.call")!][0]({}),
  };
}
