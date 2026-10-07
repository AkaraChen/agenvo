import { z } from "zod";
import type { CodexConfig } from "../config.js";
import { Fault } from "../../protocol/index.js";
import { accepted, type Method } from "./adapter.js";
import schemas from "./schema/codex.json";
import {
  AgentManagement,
  mapped,
  nativeOptions,
  optionsSchema,
  pagination,
  providerOptions,
  reference,
  type NativeCall,
} from "./management.js";

type Thread = { threadId: string };
const service = { serviceRef: reference };
const thread = { threadRef: reference };
const text = z.string().min(1).max(48000);

export class CodexManagement extends AgentManagement {
  private observedSubscriptions = new Set<string>();
  constructor(
    private config: CodexConfig,
    native: NativeCall,
    nativeMethods: () => Method[],
  ) {
    super(native);
    const method = (name: string) =>
      nativeMethods().find((m) => m.name === name)!;
    this.define(
      "services.list",
      z.strictObject({}),
      true,
      "Return the connected Codex management service.",
      async () =>
        accepted({
          items: [
            {
              serviceRef: this.serviceRef(),
              native: { instanceId: config.id },
              availability: "reachable",
            },
          ],
        }),
    );
    const list = z.strictObject({ ...service, ...pagination, providerOptions });
    this.define(
      "threads.list",
      list,
      true,
      "Discover native threads, including threads created by other clients. Listing does not subscribe to events.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(
          await native("thread/list", {
            modelProviders: [],
            sourceKinds:
              schemas.methods["thread/list"].definitions.ThreadSourceKind.enum,
            ...nativeOptions(p.providerOptions, ["cursor", "limit"]),
            cursor: p.cursor,
            limit: p.limit,
          }),
          (r) => ({
            items: r.data.map((t: any) => this.thread(t)),
            nextCursor: r.nextCursor,
            discovery: "native_thread_list",
          }),
        );
      },
      optionsSchema(list, method("thread/list"), ["cursor", "limit"]),
    );
    const create = z.strictObject({ ...service, providerOptions });
    this.define(
      "threads.create",
      create,
      false,
      "Create a full-access thread without sending a prompt.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(await native("thread/start", p.providerOptions), (r) => ({
          thread: this.thread(r.thread),
          executionSettings: {
            approvalPolicy: r.approvalPolicy,
            sandbox: r.sandbox,
          },
        }));
      },
      optionsSchema(create, method("thread/start"), []),
    );
    this.define(
      "threads.get",
      z.strictObject(thread),
      true,
      "Read native thread metadata. Idle is not task success.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        return mapped(
          await native("thread/read", { ...target, includeTurns: false }),
          (r) => ({ thread: this.thread(r.thread) }),
        );
      },
    );
    const read = z.strictObject({
      ...thread,
      ...pagination,
    });
    this.define(
      "threads.read",
      read,
      true,
      "Read native conversation history. Backend history failures are returned explicitly; observations are separate.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        return mapped(
          await native("thread/turns/list", {
            ...target,
            cursor: p.cursor,
            limit: p.limit,
          }),
          (r) => ({
            kind: "conversation_items",
            unit: "turn",
            source: "native_history",
            observedAt: Date.now(),
            items: r.data,
            nextCursor: r.nextCursor,
            truncated: Boolean(r.nextCursor),
          }),
        );
      },
    );
    const send = z.strictObject({ ...thread, text, providerOptions });
    this.define(
      "threads.send",
      send,
      false,
      "Submit text using native turn/start in full access. Busy-thread behavior remains native; no implicit next-turn queue.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        return mapped(
          await native("turn/start", {
            ...nativeOptions(p.providerOptions, ["threadId", "input"]),
            ...target,
            input: [{ type: "text", text: p.text }],
          }),
          (r) => ({
            confirmation: "native_input_accepted",
            threadRef: p.threadRef,
            native: r,
          }),
        );
      },
      optionsSchema(send, method("turn/start"), ["threadId", "input"]),
    );
    this.define(
      "threads.interrupt",
      z.strictObject(thread),
      false,
      "Resolve and interrupt the current native turn once. No retargeting or retries; observe completion to confirm interruption.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        const latest = await native("thread/turns/list", {
          ...target,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        });
        if (latest.error || latest.execution !== "accepted") return latest;
        const turn = (latest.result as any)?.data?.[0];
        if (turn?.status !== "inProgress")
          throw new Fault(
            "no_active_execution",
            "No active native turn was found; no interrupt was sent.",
          );
        if (typeof turn.id !== "string")
          throw new Fault("invalid_native_result");
        return mapped(
          await native("turn/interrupt", { ...target, turnId: turn.id }),
          () => ({
            threadRef: p.threadRef,
            native: { ...target, turnId: turn.id },
            interruption: "requested",
          }),
        );
      },
    );
    this.define(
      "threads.observe",
      z.strictObject({ ...thread, ...pagination }),
      false,
      "Subscribe by resuming if needed (full access, no prompt), then read current state, pending interactions and bounded events for this thread. State and events are not an atomic snapshot.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        // Validate a supplied cursor before any subscription side effect.
        this.observations.list(target.threadId, p.cursor, p.limit);
        if (!this.observedSubscriptions.has(target.threadId)) {
          const subscribed = await native("thread/resume", {
            ...target,
            excludeTurns: true,
          });
          if (subscribed.error || subscribed.execution !== "accepted")
            return subscribed;
        }
        const state = await native("thread/read", {
          ...target,
          includeTurns: false,
        });
        if (state.error || state.execution !== "accepted") return state;
        const pending = await native("requests.list", {
          ...target,
          summary: true,
        });
        if (pending.error || pending.execution !== "accepted") return pending;
        return accepted({
          thread: this.thread((state.result as any).thread),
          ...this.observations.list(target.threadId, p.cursor, p.limit),
          interactions: this.interactions(pending.result),
          coverage: {
            source: "received_native_events",
            subscribed: this.observedSubscriptions.has(target.threadId),
            replay: "connector_memory_only",
            history: "use_threads_read",
          },
        });
      },
    );
    for (const action of ["resume", "archive", "unarchive"] as const) {
      this.define(
        "threads." + action,
        z.strictObject(thread),
        false,
        action === "resume"
          ? "Reload and subscribe to a thread in full access without sending input."
          : `Request native thread ${action}; this is not task cancellation.`,
        async (p) => {
          const target = this.refs.read<Thread>(p.threadRef, "thread");
          return mapped(
            await native("thread/" + action, {
              ...target,
              ...(action === "resume" ? { excludeTurns: true } : {}),
            }),
            (r) => ({
              threadRef: p.threadRef,
              native: r,
              ...(r.thread ? { thread: this.thread(r.thread) } : {}),
            }),
          );
        },
      );
    }
    this.define(
      "interactions.list",
      z.strictObject({ ...thread, cursor: z.string().optional() }),
      true,
      "List pending user questions and tool calls for this thread. Permission approvals are automatic.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        return mapped(
          await native("requests.list", { ...target, cursor: p.cursor }),
          (r) => this.interactions(r),
        );
      },
    );
    for (const action of ["read", "respond"] as const) {
      this.define(
        "interactions." + action,
        z.strictObject({
          interactionRef: reference,
          ...(action === "respond"
            ? { result: z.record(z.string(), z.unknown()) }
            : {}),
        }),
        action === "read",
        action === "read"
          ? "Inspect one pending native interaction."
          : "Answer a pending native interaction using its response schema.",
        async (p) =>
          native("requests." + action, {
            ...this.refs.read<{ interactionId: string }>(
              p.interactionRef,
              "interaction",
            ),
            ...(action === "respond" ? { result: p.result } : {}),
          }),
      );
    }
  }
  capabilities() {
    return {
      discovery: "native_threads_in_approved_home",
      inputTypes: ["text"],
      execution: "full_access",
      approvals: "automatic",
      busyInput: "native_turn_start_semantics",
      identityPrecondition: "interrupt_resolves_native_turn_once",
      history: "native_history_may_be_unavailable",
      lifecycle:
        this.config.mode === "attach-unix"
          ? "disconnect_only"
          : "managed_child_process",
      observations: {
        source: "received_native_events",
        replay: "connector_memory_only",
        subscriptionTracking: "bounded_to_128_threads",
        subscribedThreadIds: [...this.observedSubscriptions],
      },
    };
  }
  serviceRef() {
    return this.refs.issue("service", { instanceId: this.config.id });
  }
  private thread(t: any) {
    if (typeof t?.id !== "string")
      throw new Fault(
        "invalid_native_result",
        "Codex returned no thread identity",
        "unknown",
      );
    const raw = t.status?.type;
    const activity =
      raw === "idle"
        ? "idle"
        : raw === "active"
          ? t.status.activeFlags?.length
            ? "blocked"
            : "working"
          : "unknown";
    return {
      threadRef: this.refs.issue("thread", { threadId: t.id }),
      serviceRef: this.serviceRef(),
      native: t,
      activity,
      observedAt: Date.now(),
      evidence: "native_thread_status",
      operations: {
        send: {
          available: t.canAcceptDirectInput === true,
          reason:
            t.canAcceptDirectInput === true
              ? "native_accepts_input"
              : "native_input_readiness_unconfirmed",
        },
        resume: { available: true },
        interrupt: { available: raw === "active" },
      },
    };
  }
  private interactions(r: any) {
    return {
      ...r,
      items: r.items.map((i: any) => ({
        ...i,
        interactionRef: this.refs.issue("interaction", {
          interactionId: i.interactionId,
        }),
      })),
      coverage: "pending_requests_received_on_this_connection",
    };
  }
  record(threadId: unknown, type: string, data: Record<string, unknown>) {
    if (typeof threadId !== "string") return;
    this.observations.append(threadId, type, data);
  }
  subscribed(threadId: string) {
    if (this.observedSubscriptions.size < 128)
      this.observedSubscriptions.add(threadId);
  }
  unsubscribed(threadId: string) {
    this.observedSubscriptions.delete(threadId);
  }
  notify(method: string, params: any) {
    const allowed = [
      "thread/started",
      "thread/status/changed",
      "thread/archived",
      "thread/unarchived",
      "thread/closed",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "serverRequest/resolved",
    ];
    if (!allowed.includes(method)) return;
    const threadId = params?.threadId ?? params?.thread?.id;
    if (typeof threadId !== "string") return;
    const threadRef = this.refs.issue("thread", { threadId });
    this.observations.append(
      threadId,
      method,
      { threadRef, native: params },
      {
        threadRef,
        native: {
          threadId,
          turnId: params?.turnId ?? params?.turn?.id,
          itemId: params?.itemId ?? params?.item?.id,
          status: params?.turn?.status ?? params?.status,
          error: params?.turn?.error,
        },
      },
    );
  }
  override reset() {
    super.reset();
    this.observedSubscriptions.clear();
  }
}
