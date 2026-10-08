import { z } from "zod";
import { Fault, page } from "@agenvo/protocol";
import { accepted } from "@agenvo/connector/adapters/adapter";
import {
  AgentManagement,
  mapped,
  pagination,
  reference,
} from "@agenvo/connector/adapters/management";
import { AgentPermissionResponseSchema } from "@getpaseo/protocol/messages";
import {
  createInput,
  listInput,
  sendInput,
  type PaseoAdapter,
} from "./paseo.js";

export class PaseoManagement extends AgentManagement {
  constructor(private adapter: PaseoAdapter) {
    super((name, p) => adapter.call(name, p));
    const service = { serviceRef: reference },
      thread = { threadRef: reference };
    const native = this.native;
    this.define(
      "services.list",
      z.strictObject({}),
      true,
      "Return the attached Paseo daemon.",
      async () =>
        accepted({
          items: [
            {
              serviceId: "default",
              serviceRef: this.serviceRef(),
              availability: adapter.available ? "reachable" : "unreachable",
              native: {
                serverId: adapter.config.serverId,
                version: adapter.version,
              },
            },
          ],
        }),
    );
    this.define(
      "threads.list",
      z.strictObject({
        ...service,
        ...pagination,
        providerOptions: listInput.omit({ page: true }).default({}),
      }),
      true,
      "Discover agents across the daemon without subscribing.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(
          await native("paseo.agents.list", {
            ...p.providerOptions,
            page: { limit: p.limit, cursor: p.cursor },
          }),
          (r) => ({
            items: r.entries.map((e: any) => this.thread(e.agent)),
            nextCursor: r.pageInfo.nextCursor,
            discovery: "native_agent_directory",
          }),
        );
      },
    );
    this.define(
      "threads.create",
      z.strictObject({ ...service, providerOptions: createInput }),
      false,
      "Create a full-access agent without an initial prompt.",
      async (p) => {
        this.refs.read(p.serviceRef, "service");
        return mapped(
          await native("paseo.agents.create", p.providerOptions),
          (r) => ({
            thread: this.thread(r.agent),
            native: { idempotencyKey: r.idempotencyKey },
          }),
        );
      },
    );
    this.define(
      "threads.get",
      z.strictObject(thread),
      true,
      "Read current agent metadata; idle is not success.",
      async (p) =>
        mapped(
          await native("paseo.agents.get", { agentId: this.id(p.threadRef) }),
          (r) => ({ thread: this.thread(r) }),
        ),
    );
    this.define(
      "threads.send",
      z.strictObject({
        ...thread,
        text: sendInput.shape.text,
        providerOptions: sendInput
          .pick({ activeTurnBehavior: true, messageId: true })
          .default({ activeTurnBehavior: "interrupt" }),
      }),
      false,
      "Send in full access. Default interrupt replaces active work; steer can also replace or start a turn. May load/unarchive and clear pending permissions.",
      async (p) =>
        native("paseo.agents.send", {
          ...p.providerOptions,
          agentId: this.id(p.threadRef),
          text: p.text,
        }),
    );
    this.define(
      "threads.observe",
      z.strictObject({ ...thread, ...pagination }),
      false,
      "Establish a live timeline subscription, then sample current state, events and pending interactions. No historical replay.",
      async (p) => {
        const id = this.id(p.threadRef);
        this.observations.list(id, p.cursor, p.limit);
        await adapter.observe(id);
        const agent = await adapter.get(id);
        return accepted({
          thread: this.thread(agent),
          ...this.observations.list(id, p.cursor, p.limit),
          interactions: this.interactions(agent),
          coverage: {
            source: "subscribed_live_events",
            replay: false,
            stateAndEventsAtomic: false,
          },
        });
      },
    );
    this.define(
      "threads.read",
      z.strictObject({ ...thread, ...pagination }),
      true,
      "Read projected native timeline history independently of observation cursors.",
      async (p) => {
        const id = this.id(p.threadRef);
        const cursor = p.cursor
          ? this.refs.read<{ agentId: string; epoch: string; seq: number }>(
              p.cursor,
              "history",
            )
          : undefined;
        if (cursor && cursor.agentId !== id) throw new Fault("invalid_cursor");
        return mapped(
          await native("paseo.agents.history", {
            agentId: id,
            limit: p.limit,
            ...(cursor
              ? { cursor: { epoch: cursor.epoch, seq: cursor.seq } }
              : {}),
          }),
          (r) => {
            if (r.staleCursor)
              throw new Fault(
                "invalid_cursor",
                "Native timeline epoch changed; restart history pagination",
              );
            return {
              kind: "conversation_items",
              source: "native_history",
              items: r.entries,
              native: {
                epoch: r.epoch,
                startCursor: r.startCursor,
                endCursor: r.endCursor,
                hasOlder: r.hasOlder,
                hasNewer: r.hasNewer,
                reset: r.reset,
                gap: r.gap,
              },
              nextCursor:
                r.hasOlder && r.startCursor
                  ? this.refs.issue("history", {
                      agentId: id,
                      ...r.startCursor,
                    })
                  : undefined,
            };
          },
        );
      },
    );
    this.define(
      "interactions.list",
      z.strictObject({ ...thread, ...pagination }),
      true,
      "List current pending native requests for this agent.",
      async (p) =>
        accepted(
          page(
            this.interactions(await adapter.get(this.id(p.threadRef))),
            p.cursor,
            p.limit,
          ),
        ),
    );
    this.define(
      "interactions.read",
      z.strictObject({ interactionRef: reference }),
      true,
      "Read a still-pending native request and its response schema.",
      async (p) => accepted(await this.interaction(p.interactionRef)),
    );
    this.define(
      "interactions.respond",
      z.strictObject({
        interactionRef: reference,
        response: AgentPermissionResponseSchema,
      }),
      false,
      "Submit a pending interaction response; no native acknowledgement is provided.",
      async (p) => {
        const target = this.refs.read<{ agentId: string; requestId: string }>(
          p.interactionRef,
          "interaction",
        );
        return native("paseo.interactions.respond", {
          ...target,
          response: p.response,
        });
      },
    );
  }
  serviceRef() {
    return this.refs.issue("service", {
      serverId: this.adapter.config.serverId,
    });
  }
  private id(ref: string) {
    return this.refs.read<{ agentId: string }>(ref, "thread").agentId;
  }
  private thread(agent: any) {
    if (typeof agent?.id !== "string") throw new Fault("invalid_native_result");
    return {
      serviceId: "default",
      serviceRef: this.serviceRef(),
      threadId: agent.id,
      threadRef: this.refs.issue("thread", { agentId: agent.id }),
      activity: agent.pendingPermissions?.length
        ? "blocked"
        : ((
            {
              idle: "idle",
              running: "working",
              initializing: "starting",
            } as Record<string, string>
          )[agent.status] ?? "unknown"),
      observedAt: Date.now(),
      evidence: "native_agent_status",
      native: agent,
    };
  }
  private interactions(agent: any) {
    return (agent.pendingPermissions ?? []).map((request: any) => ({
      interactionRef: this.refs.issue("interaction", {
        agentId: agent.id,
        requestId: request.id,
      }),
      native: request,
      responseSchema: z.toJSONSchema(AgentPermissionResponseSchema),
    }));
  }
  private async interaction(ref: string) {
    const target = this.refs.read<{ agentId: string; requestId: string }>(
      ref,
      "interaction",
    );
    const agent = await this.adapter.get(target.agentId);
    const found = this.interactions(agent).find(
      (item: any) => item.native.id === target.requestId,
    );
    if (!found) throw new Fault("stale_interaction");
    return found;
  }
  capabilities() {
    return {
      discovery: "whole_daemon",
      executionProviders: ["codex", "claude"],
      send: { busyBehavior: "interrupt_or_steer", queue: false },
      observations: {
        source: "native_timeline",
        subscriptionLimit: 128,
        replay: "connector_memory_only",
      },
      events: {
        directoryCoverage: "native_subscription_window_200",
        timelineCoverage: "observed_threads",
        replay: false,
      },
      interrupt: false,
      archive: false,
      resume: false,
      interactions: true,
    };
  }
}
