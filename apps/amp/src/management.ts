import { z } from "zod";
import { Fault } from "@agenvo/protocol";
import { accepted } from "@agenvo/connector/adapters/adapter";
import {
  AgentManagement,
  mapped,
  reference,
  pagination,
  type NativeCall,
} from "@agenvo/connector/adapters/management";
import { threadId } from "./methods.js";

type Service = { serviceId: string; cwd: string; userId: string | null };
type Target = { serviceId: string; threadId: string };
const thread = { threadRef: reference };
const offset = (cursor?: string) => {
  if (cursor !== undefined && !/^(0|[1-9][0-9]{0,8})$/.test(cursor))
    throw new Fault("invalid_cursor");
  return Number(cursor ?? 0);
};

export class AmpManagement extends AgentManagement {
  constructor(
    native: NativeCall,
    private services: () => Service[],
  ) {
    super(native);
    this.define(
      "services.list",
      z.strictObject({}),
      true,
      "Discover all Amp hosts attached through this approved plugin installation.",
      async () =>
        accepted({
          items: services().map((s) => ({
            ...s,
            serviceRef: this.refs.issue("service", { serviceId: s.serviceId }),
            availability: "reachable",
          })),
        }),
    );
    this.define(
      "threads.list",
      z.strictObject({
        serviceRef: reference,
        ...pagination,
        includeArchived: z.boolean().default(false),
      }),
      true,
      "Discover the native Amp user's threads, including other clients' threads. Listing does not subscribe.",
      async (p) => {
        const serviceId = this.service(p.serviceRef);
        const start = offset(p.cursor);
        return mapped(
          await native("amp.threads.list", {
            serviceId,
            offset: start,
            limit: p.limit,
            includeArchived: p.includeArchived,
          }),
          (r) => {
            const items = z
              .array(z.object({ id: threadId }).passthrough())
              .parse(r);
            return {
              items: items.map((t) =>
                this.thread({ serviceId, threadId: t.id }, t),
              ),
              nextCursor:
                items.length === p.limit
                  ? String(start + items.length)
                  : undefined,
              discovery: "native_amp_user_threads",
              pagination: "offset_not_snapshot",
            };
          },
        );
      },
    );
    this.define(
      "threads.create",
      z.strictObject({
        serviceRef: reference,
        providerOptions: z
          .strictObject({
            mode: z.enum(["low", "medium", "high", "ultra"]).default("medium"),
          })
          .default({ mode: "medium" }),
      }),
      false,
      "Create a private thread in the selected Amp host without sending input.",
      async (p) => {
        const serviceId = this.service(p.serviceRef);
        return mapped(
          await native("amp.threads.create", {
            serviceId,
            ...p.providerOptions,
          }),
          (r) => ({
            thread: this.thread(
              { serviceId, threadId: threadId.parse(r.threadId) },
              r,
            ),
          }),
        );
      },
    );
    this.define(
      "threads.get",
      z.strictObject(thread),
      true,
      "Read native activity; idle is not proof of business success.",
      async (p) => {
        const target = this.target(p.threadRef);
        return mapped(await native("amp.threads.get", target), (r) => ({
          thread: this.thread(target, r),
        }));
      },
    );
    this.define(
      "threads.send",
      z.strictObject({
        ...thread,
        text: z.string().min(1).max(48000),
        providerOptions: z
          .strictObject({ steer: z.boolean().default(false) })
          .default({ steer: false }),
      }),
      false,
      "Append native input once. Busy input and steering use Amp's queue; no turn identity precondition.",
      async (p) =>
        native("amp.threads.send", {
          ...this.target(p.threadRef),
          text: p.text,
          ...p.providerOptions,
        }),
    );
    this.define(
      "threads.interrupt",
      z.strictObject(thread),
      false,
      "Cancel the current native turn once. A concurrent next turn may be targeted; observe native state/results to confirm.",
      async (p) => native("amp.threads.cancel", this.target(p.threadRef)),
    );
    this.define(
      "threads.read",
      z.strictObject({
        ...thread,
        cursor: pagination.cursor,
        limit: z.number().int().min(1).max(20).default(20),
      }),
      true,
      "Read full native conversation history, including compacted messages. Offset pagination is not a snapshot.",
      async (p) => {
        const target = this.target(p.threadRef);
        const start = this.historyOffset(target.threadId, p.cursor);
        return mapped(
          await native("amp.threads.read", {
            ...target,
            offset: start,
            limit: p.limit,
          }),
          (r) => ({
            kind: "conversation_items",
            source: "native_history",
            observedAt: Date.now(),
            items: r.items,
            nextCursor:
              r.items.length === p.limit
                ? this.refs.issue("history", {
                    threadId: target.threadId,
                    offset: start + r.items.length,
                  })
                : undefined,
            truncated: r.items.length === p.limit,
          }),
        );
      },
    );
    this.define(
      "threads.observe",
      z.strictObject({ ...thread, ...pagination }),
      false,
      "Subscribe to native state and read bounded observations. Subscriptions do not replay missed events; reconnect requires rediscovery.",
      async (p) => {
        const target = this.target(p.threadRef);
        this.observations.list(target.threadId, p.cursor, p.limit);
        const subscribed = await native("amp.threads.subscribe", target);
        if (subscribed.error || subscribed.execution !== "accepted")
          return subscribed;
        return mapped(await native("amp.threads.get", target), (r) => ({
          thread: this.thread(target, r),
          ...this.observations.list(target.threadId, p.cursor, p.limit),
          interactions: {
            items: [],
            coverage: "not_supported_use_native_amp_ui",
          },
          coverage: {
            source: "native_state_and_host_lifecycle_events",
            replay: "connector_memory_only",
            history: "use_threads_read",
            lifecycle: "events_from_attached_host_only",
          },
        }));
      },
    );
  }
  capabilities() {
    return {
      discovery: "native_amp_user_threads",
      inputTypes: ["text"],
      execution: "full_access_in_attached_host",
      approvals: "automatic_tool_call_hook",
      otherExecutors: "native_permissions_unchanged",
      busyInput: "native_queue_with_optional_steer",
      identityPrecondition: "none_for_current_turn_cancel",
      history: "native_full_messages",
      lifecycle: "disconnect_only",
      interactions: "native_amp_ui_only",
      events: {
        name: "runtime.changed",
        source: "plugin_state_and_lifecycle",
        replay: false,
      },
    };
  }
  private service(ref: string) {
    const { serviceId } = this.refs.read<{ serviceId: string }>(ref, "service");
    this.requireService(serviceId);
    return serviceId;
  }
  private requireService(id: string) {
    if (!this.services().some((s) => s.serviceId === id))
      throw new Fault("stale_reference", "Rediscover the connected Amp host.");
  }
  private target(ref: string): Target {
    const target = this.refs.read<Target>(ref, "thread");
    this.requireService(target.serviceId);
    return target;
  }
  private historyOffset(id: string, cursor?: string) {
    if (!cursor) return 0;
    const value = this.refs.read<{ threadId: string; offset: number }>(
      cursor,
      "history",
    );
    if (value.threadId !== id) throw new Fault("invalid_cursor");
    return value.offset;
  }
  private thread(target: Target, native: Record<string, unknown>) {
    return {
      ...target,
      threadRef: this.refs.issue("thread", target),
      serviceRef: this.refs.issue("service", { serviceId: target.serviceId }),
      native,
      activity:
        native.state === "idle"
          ? "idle"
          : native.state === "running"
            ? "working"
            : native.state === "awaiting-approval"
              ? "blocked"
              : "unknown",
      observedAt: Date.now(),
      evidence: native.state ? "native_thread_state" : "native_thread_metadata",
      operations: {
        send: { available: true, reason: "native_access_checked_on_dispatch" },
        interrupt: {
          available: true,
          reason: "native_current_turn_no_identity_precondition",
        },
      },
    };
  }
  record(
    serviceId: string,
    threadId: string,
    type: string,
    native: Record<string, unknown>,
  ) {
    this.observations.append(
      threadId,
      type,
      { serviceId, threadId, native },
      {
        serviceId,
        threadId,
        native: {
          status: native.status,
          messageId: native.messageId,
          state: native.state,
        },
      },
    );
  }
}
