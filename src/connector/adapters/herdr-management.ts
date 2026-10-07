import { z } from "zod";
import { canonical, Fault, page } from "../../protocol/index.js";
import { accepted, type Method } from "./adapter.js";
import {
  AgentManagement,
  mapped,
  nativeOptions,
  optionsSchema,
  pagination,
  reference,
  type NativeCall,
} from "./management.js";

type Service = { session: string; backendGeneration: string };
type Thread = Service & {
  name: string;
  terminalId?: string;
  agentSession?: unknown;
  kind?: string;
  expectedPaneId?: string;
  pending?: boolean;
};
const unwrap = (result: any) => result?.result ?? result;

export class HerdrManagement extends AgentManagement {
  constructor(native: NativeCall, nativeMethods: () => Method[]) {
    super(native);
    const method = (name: string) =>
      nativeMethods().find((m) => m.name === name)!;
    this.define(
      "services.list",
      z.strictObject({ cursor: z.string().optional() }),
      true,
      "Discover independent Herdr sessions. An endpoint on disk does not prove reachability.",
      async (p) =>
        mapped(await native("session.list", p), (r) => ({
          ...r,
          items: r.items.map((s: any) => ({
            native: s,
            availability: s.endpointPresent ? "unprobed" : "unavailable",
            ...(s.backendGeneration
              ? {
                  serviceRef: this.refs.issue("service", {
                    session: s.session,
                    backendGeneration: s.backendGeneration,
                  }),
                }
              : {}),
          })),
        })),
    );
    this.define(
      "threads.list",
      z.strictObject({ serviceRef: reference, ...pagination }),
      true,
      "Discover live native agents, including agents created outside Agenvo.",
      async (p) => {
        const service = this.refs.read<Service>(p.serviceRef, "service");
        return mapped(await native("agent.list", service), (r) => ({
          ...page(
            unwrap(r).agents.map((a: any) => this.thread(service, a)),
            p.cursor,
            p.limit,
          ),
          discovery: "live_only",
        }));
      },
    );
    const create = z.strictObject({
      serviceRef: reference,
      providerOptions: z.record(z.string(), z.unknown()),
    });
    this.define(
      "threads.create",
      create,
      false,
      "Start an agent in an explicit existing pane. Poll the returned query; do not resend after uncertain delivery.",
      async (p) => {
        const service = this.refs.read<Service>(p.serviceRef, "service");
        const options = nativeOptions(p.providerOptions, [
          "session",
          "backendGeneration",
        ]);
        const outcome = await native("agent.start", { ...options, ...service });
        if (outcome.execution !== "starting" || outcome.error) return outcome;
        const threadRef = this.refs.issue("thread", {
          ...service,
          name: options.name,
          kind: options.kind,
          expectedPaneId: options.paneId,
          pending: true,
        });
        return {
          ...outcome,
          result: {
            threadRef,
            query: { method: "management.threads.get", params: { threadRef } },
            native: outcome.result,
          },
        };
      },
      optionsSchema(create, method("agent.start"), [
        "session",
        "backendGeneration",
      ]),
    );
    this.define(
      "threads.get",
      z.strictObject({ threadRef: reference }),
      true,
      "Read live agent state or an asynchronous startup. Done is not task success.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        const outcome = await native("agent.get", this.target(target));
        return mapped(outcome, (r) => {
          const info = unwrap(r).agent;
          if (target.pending && (!info || r.startup?.outcome?.error))
            return {
              threadRef: p.threadRef,
              activity:
                r.startup?.state === "starting" ? "starting" : "unknown",
              startup: r.startup,
              nativeError: r.startup?.outcome?.error
                ? r.startup.outcome
                : r.nativeError,
              observedAt: Date.now(),
              evidence: "connector_startup_tracking",
            };
          this.check(target, info);
          const thread = this.thread(target, info);
          return { thread, startup: r.startup };
        });
      },
    );
    this.define(
      "threads.send",
      z.strictObject({
        threadRef: reference,
        text: z.string().min(1).max(48000),
      }),
      false,
      "Submit terminal input to a live agent after checking its identity. No atomic turn or dialog precondition is available.",
      async (p) => {
        const target = await this.live(p.threadRef);
        return mapped(
          await native("agent.prompt", {
            ...this.target(target),
            text: p.text,
          }),
          (r) => ({ confirmation: "terminal_input_delivered", native: r }),
        );
      },
    );
    this.define(
      "threads.read",
      z.strictObject({
        threadRef: reference,
        lines: z.number().int().min(1).max(500).default(80),
      }),
      true,
      "Read a bounded terminal snapshot. It is not a durable conversation log.",
      async (p) => {
        const target = await this.live(p.threadRef);
        return mapped(
          await native("agent.read", {
            ...this.target(target),
            lines: p.lines,
          }),
          (r) => ({
            kind: "terminal_snapshot",
            source: "native_terminal",
            observedAt: Date.now(),
            coverage: {
              requestedLines: p.lines,
              completeness: "bounded_snapshot",
            },
            native: r,
          }),
        );
      },
    );
    this.define(
      "threads.observe",
      z.strictObject({
        threadRef: reference,
        ...pagination,
        lines: z.number().int().min(1).max(500).default(80),
      }),
      true,
      "Refresh this live thread and its terminal snapshot on every poll. Intermediate terminal transitions may be missed; no background subscription or durable history is available.",
      async (p) => {
        const target = this.refs.read<Thread>(p.threadRef, "thread");
        const scope = canonical(target);
        this.observations.list(scope, p.cursor, p.limit);
        const state = await this.call("management.threads.get", {
          threadRef: p.threadRef,
        });
        if (state.error || state.execution !== "accepted") return state;
        const result = state.result as any;
        const thread = result.thread ?? result;
        this.observations.append(scope, "thread.observed", thread, {
          threadRef: thread.threadRef,
          activity: thread.activity,
          evidence: thread.evidence,
        });
        if (result.thread) {
          const output = await this.call("management.threads.read", {
            threadRef: thread.threadRef,
            lines: p.lines,
          });
          if (output.error || output.execution !== "accepted") return output;
          this.observations.append(scope, "terminal.observed", output.result, {
            threadRef: thread.threadRef,
            kind: "terminal_snapshot",
            coverage: "bounded_snapshot",
          });
        }
        return accepted({
          thread,
          ...this.observations.list(scope, p.cursor, p.limit),
          interactions: { supported: false },
          coverage: this.capabilities().observations,
        });
      },
    );
  }
  capabilities() {
    return {
      discovery: "live_agents_in_selected_session",
      inputTypes: ["text"],
      busyInput: "native_terminal_submission",
      identityPrecondition: "best_effort_live_identity_check_with_race_window",
      history: "bounded_terminal_snapshot",
      permissions: "agent_owned_existing_agents_retain_their_settings",
      lifecycle: "independent_service",
      observations: {
        source: "polling_native_state_and_terminal",
        replay: "connector_memory_only",
        backgroundSubscription: false,
        intermediateTransitions: "may_be_missed",
      },
    };
  }
  private target(a: Thread) {
    return {
      session: a.session,
      backendGeneration: a.backendGeneration,
      name: a.name,
    };
  }
  private check(target: Thread, info: any) {
    if (!info || typeof info.terminal_id !== "string")
      throw new Fault(
        "invalid_native_result",
        "No live agent identity",
        "unknown",
      );
    if (
      target.pending &&
      (target.expectedPaneId !== info.pane_id || target.kind !== info.agent)
    )
      throw new Fault(
        "stale_reference",
        "The startup name now identifies a different agent.",
      );
    if (
      !target.pending &&
      (target.terminalId !== info.terminal_id ||
        target.kind !== info.agent ||
        (target.agentSession !== undefined &&
          canonical(target.agentSession) !== canonical(info.agent_session)))
    )
      throw new Fault(
        "stale_reference",
        "The native pane occupant changed; rediscover the agent.",
      );
  }
  private async live(token: string) {
    const target = this.refs.read<Thread>(token, "thread");
    if (target.pending)
      throw new Fault(
        "agent_not_ready",
        "Poll startup and use the live threadRef returned by threads.get.",
      );
    const outcome = await this.native("agent.get", this.target(target));
    if (outcome.error || outcome.execution !== "accepted")
      throw new Fault(
        "reference_unverified",
        "Live identity could not be checked; no input was sent.",
      );
    this.check(target, unwrap(outcome.result).agent);
    return target;
  }
  private thread(service: Service, a: any) {
    if (typeof a?.terminal_id !== "string" || typeof a?.pane_id !== "string")
      throw new Fault(
        "invalid_native_result",
        "No live agent identity",
        "unknown",
      );
    const ref = {
      session: service.session,
      backendGeneration: service.backendGeneration,
    };
    const activity = a.launch_pending
      ? "starting"
      : a.agent_status === "done"
        ? "idle"
        : ["idle", "working", "blocked"].includes(a.agent_status)
          ? a.agent_status
          : "unknown";
    return {
      serviceRef: this.refs.issue("service", ref),
      threadRef: this.refs.issue("thread", {
        ...ref,
        name: a.pane_id,
        terminalId: a.terminal_id,
        kind: a.agent,
        ...(a.agent_session ? { agentSession: a.agent_session } : {}),
      }),
      native: a,
      activity,
      observedAt: Date.now(),
      evidence: "native_terminal_detection",
      operations: {
        send: {
          available:
            Boolean(a.interactive_ready) &&
            activity !== "blocked" &&
            activity !== "starting",
          reason: "native_state_checked_again_on_call",
        },
        steer: { available: false, reason: "no_native_turn_precondition" },
        interrupt: { available: false, reason: "no_native_interrupt" },
      },
    };
  }
}
