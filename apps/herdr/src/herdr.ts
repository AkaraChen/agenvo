import { HerdrEvents } from "./herdr-events.js";
import type { RuntimeEvent } from "@agenvo/protocol/events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { z } from "zod";
import { type HerdrConfig } from "./config.js";
import {
  accepted,
  type Adapter,
  type Method,
} from "@agenvo/connector/adapters/adapter";
import { Fault, digest, page, type Outcome } from "@agenvo/protocol";

import { fullAccessArgs, managedAgentKinds } from "./herdr-execution.js";
const exec = promisify(execFile);
const session = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const ref = { session, backendGeneration: z.string().regex(/^[a-f0-9]{64}$/) };
const id = z
  .string()
  .min(1)
  .max(128)
  .refine((s) => !s.startsWith("-"));
const agentName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const target = {
  ...ref,
  name: id.describe(
    "Live agent name or pane ID from agent.list; scoped to this server lifetime.",
  ),
};
const pane = { ...ref, paneId: id };
const lines = z.number().int().min(1).max(500).default(80);
const readSource = z.enum([
  "visible",
  "recent",
  "recent-unwrapped",
  "detection",
]);
const keys = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(64)
  .describe(
    "Native logical keys, for example esc, ctrl+c, enter. Herdr validates the whole list before writing.",
  );
const snapshot =
  "Read a bounded terminal snapshot, not a durable or cursor-based task log. Inspect output and task evidence before declaring success.";
const inputKeys =
  "Send native logical keys to the explicitly selected target. Read the current UI before answering an approval or question and follow the caller's authorization. esc or ctrl+c may interrupt depending on the running program. accepted confirms input delivery only; re-read state/output to verify the effect. Never blindly retry lost confirmation.";
// Each method owns its schema, discovery contract and native argument mapping.
// Session discovery is handled locally; all other calls target an existing server.
type NativeMethod = {
  schema: z.ZodType;
  readOnly: boolean;
  description: string;
  argv?: (params: Record<string, any>, cwd: string) => string[];
};
const methods: Record<string, NativeMethod> = {
  "session.list": {
    schema: z.strictObject({ cursor: z.string().optional() }),
    readOnly: true,
    description:
      "Discover independently started sessions in the approved config root, with server lifetime references. Herdr startup, shutdown and restart are managed locally; this adapter does not provide session.start or session.stop.",
  },
  "workspace.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description: "List native workspaces in the selected session.",
    argv: () => ["workspace", "list"],
  },
  "workspace.create": {
    schema: z.strictObject({
      ...ref,
      cwd: z.string().optional(),
      label: z.string().max(128).optional(),
    }),
    readOnly: false,
    description:
      "Create a workspace without changing user focus. Retain returned native IDs; inspect workspace.list after unknown confirmation before retrying.",
    argv: (p, cwd) => [
      "workspace",
      "create",
      "--cwd",
      p.cwd ?? cwd,
      "--label",
      p.label ?? "Agenvo",
      "--no-focus",
    ],
  },
  "workspace.get": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: true,
    description: "Read a native workspace and its terminal topology.",
    argv: (p) => ["workspace", "get", p.workspaceId],
  },
  "workspace.close": {
    schema: z.strictObject({ ...ref, workspaceId: id }),
    readOnly: false,
    description:
      "Close a whole workspace and its terminals. Preserve required output and artifacts before cleanup.",
    argv: (p) => ["workspace", "close", p.workspaceId],
  },
  "pane.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "List live terminal panes; IDs are scoped to the server lifetime.",
    argv: () => ["pane", "list"],
  },
  "pane.get": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Inspect the selected pane before raw terminal input; pane state is not task success.",
    argv: (p) => ["pane", "get", p.paneId],
  },
  "pane.process-info": {
    schema: z.strictObject(pane),
    readOnly: true,
    description:
      "Read native process information for a pane. Use with output to inspect interruption; process presence or absence does not establish task success.",
    argv: (p) => ["pane", "process-info", "--pane", p.paneId],
  },
  "pane.run": {
    schema: z.strictObject({ ...pane, command: z.string().max(48000) }),
    readOnly: false,
    description:
      "Submit command text and Enter to a terminal. accepted is input delivery, not command completion or exit status; inspect output before further input.",
    argv: (p) => ["pane", "run", p.paneId, p.command],
  },
  "pane.read": {
    schema: z.strictObject({
      ...pane,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "pane",
      "read",
      p.paneId,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "pane.send-text": {
    schema: z.strictObject({ ...pane, text: z.string().min(1).max(48000) }),
    readOnly: false,
    description:
      "Send literal text without Enter to the selected terminal, including a question's text field. Inspect the current UI and authorization first; use pane.send-keys for an explicit submission. Raw terminal input has no approval request ID or stale-dialog protection.",
    argv: (p) => ["pane", "send-text", p.paneId, p.text],
  },
  "pane.send-keys": {
    schema: z.strictObject({ ...pane, keys }),
    readOnly: false,
    description:
      inputKeys + " Raw pane input does not validate agent identity.",
    argv: (p) => ["pane", "send-keys", p.paneId, ...p.keys],
  },
  "agent.list": {
    schema: z.strictObject(ref),
    readOnly: true,
    description:
      "Discover live agents, including agents started outside Agenvo. Use a returned live name or pane ID with agent methods. Names identify the current pane occupant, not a durable task.",
    argv: () => ["agent", "list"],
  },
  "agent.start": {
    schema: z.strictObject({
      ...ref,
      name: agentName,
      paneId: id,
      kind: z.enum(managedAgentKinds),
      args: z.array(z.string()).max(64).default([]),
      timeoutMs: z.number().int().min(3001).max(300000).default(30000),
    }),
    readOnly: false,
    description:
      "Start asynchronously. Poll agent.get using the returned session, name and backendGeneration. A startup timeout does not stop the process; rediscover agents by pane ID if the launch name is gone. Do not repeat after lost confirmation. Startup tracking is connector-local; rediscover native agents after reconnect.",
    argv: (p) => [
      "agent",
      "start",
      p.name,
      "--kind",
      p.kind,
      "--pane",
      p.paneId,
      "--timeout",
      String(p.timeoutMs),
      "--",
      ...fullAccessArgs(p.kind, p.args),
    ],
  },
  "agent.prompt": {
    schema: z.strictObject({ ...target, text: z.string().max(48000) }),
    readOnly: false,
    description:
      "Submit a prompt to a live agent. Native Herdr rejects blocked approval/question dialogs; inspect agent.explain and agent.read and use authorized input instead. accepted does not establish turn completion.",
    argv: (p) => ["agent", "prompt", p.name, p.text],
  },
  "agent.get": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Read native lifecycle and startup state. idle/done means ready for input, not verified task success; blocked requires agent.explain and agent.read. This instance does not expose requests.list.",
    argv: (p) => ["agent", "get", p.name],
  },
  "agent.read": {
    schema: z.strictObject({
      ...target,
      lines,
      source: readSource.default("recent-unwrapped"),
    }),
    readOnly: true,
    description: snapshot,
    argv: (p) => [
      "agent",
      "read",
      p.name,
      "--lines",
      String(p.lines),
      "--source",
      p.source,
    ],
  },
  "agent.explain": {
    schema: z.strictObject(target),
    readOnly: true,
    description:
      "Return native JSON detection evidence for the selected agent, including why it appears blocked or unknown. This is classifier diagnostics, not a structured approval request or task result.",
    argv: (p) => ["agent", "explain", p.name, "--json"],
  },
  "agent.send-keys": {
    schema: z.strictObject({ ...target, keys }),
    readOnly: false,
    description:
      inputKeys +
      " Herdr resolves a live agent; this does not bind input to a specific approval dialog.",
    argv: (p) => ["agent", "send-keys", p.name, ...p.keys],
  },
};
import { HerdrManagement } from "./herdr-management.js";

export class HerdrAdapter implements Adapter {
  available = false;
  version = "unknown";
  private starting = new Map<
    string,
    { state: "starting" | "settled"; outcome?: Outcome }
  >();
  readonly management: HerdrManagement;
  constructor(public config: HerdrConfig) {
    this.management = new HerdrManagement(
      (m, p) => this.call(m, p),
      () => this.nativeMethods(),
    );
  }
  async init() {
    if (basename(this.config.configRoot) !== "herdr")
      throw new Fault(
        "invalid_config_root",
        "Herdr config root must be named herdr; its parent becomes XDG_CONFIG_HOME.",
      );
    const { stdout } = await exec(this.config.binary, ["--version"], {
      timeout: 8000,
    });
    this.version = stdout.trim();
    this.available = /\b0\.9\.3\b/.test(stdout);
  }
  methods(): Method[] {
    return [...this.management.methods(), ...this.nativeMethods()];
  }
  private nativeMethods(): Method[] {
    return Object.entries(methods).map(([name, method]) => ({
      name,
      description: method.description,
      readOnly: method.readOnly,
      inputSchema: z.toJSONSchema(method.schema, { unrepresentable: "any" }),
    }));
  }

  private socket(name: string) {
    const path =
      name === "default"
        ? join(this.config.configRoot, "herdr.sock")
        : join(this.config.configRoot, "sessions", name, "herdr.sock");
    if (
      Buffer.byteLength(path.replace("herdr.sock", "herdr-client.sock")) >= 104
    )
      throw new Fault(
        "socket_path_too_long",
        "Use a shorter native Herdr config root or session name",
      );
    return path;
  }
  private environment(name: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HERDR_SOCKET_PATH: this.socket(name),
      HERDR_CONFIG_PATH: join(this.config.configRoot, "config.toml"),
      XDG_CONFIG_HOME: dirname(this.config.configRoot),
      HERDR_SESSION: name === "default" ? "" : name,
    };
    delete env.HERDR_PANE_ID;
    delete env.HERDR_WORKSPACE_ID;
    return env;
  }
  async generation(name: string) {
    const path = this.socket(name);
    if (
      Buffer.byteLength(path.replace("herdr.sock", "herdr-client.sock")) >= 104
    )
      throw new Fault("socket_path_too_long");
    const root = await realpath(this.config.configRoot);
    const resolved = await realpath(path);
    if (!resolved.startsWith(root + "/"))
      throw new Fault("permission_denied", "Socket escapes the approved root");
    const info = await stat(path, { bigint: true });
    if (!info.isSocket()) throw new Fault("runtime_unavailable");
    // Socket inode and creation/change timestamps survive connector restarts, but
    // change when Herdr replaces its endpoint. Access time is deliberately omitted.
    return digest(
      [resolved, info.dev, info.ino, info.birthtimeNs, info.ctimeNs].join(":"),
    );
  }
  private async execute(
    name: string,
    args: string[],
    timeout = 8000,
  ): Promise<unknown> {
    try {
      const { stdout } = await exec(this.config.binary, args, {
        cwd: this.config.cwd,
        env: this.environment(name),
        timeout,
        maxBuffer: 1024 * 1024,
      });
      try {
        return JSON.parse(stdout);
      } catch {
        return { output: stdout };
      }
    } catch (error: any) {
      if (!error.killed && typeof error.stderr === "string") {
        try {
          const native = JSON.parse(error.stderr);
          if (native.error)
            throw new Fault(
              "native_error",
              "Herdr rejected the request",
              "rejected",
              native.error,
            );
        } catch (parsed) {
          if (parsed instanceof Fault) throw parsed;
        }
      }
      throw new Fault(
        "execution_unknown",
        "Herdr CLI did not provide reliable confirmation; inspect the native session.",
        "unknown",
      );
    }
  }
  async call(method: string, input: Record<string, unknown>): Promise<Outcome> {
    if (method.startsWith("management."))
      return this.management.call(method, input);
    const definition = Object.hasOwn(methods, method)
      ? methods[method]
      : undefined;
    if (!definition) throw new Fault("unsupported_method");
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) throw new Fault("invalid_params");
    const p = parsed.data as Record<string, any>;
    if (method === "session.list") {
      const names = [
        "default",
        ...(await readdir(join(this.config.configRoot, "sessions")).catch(
          () => [] as string[],
        )),
      ];
      const sessions = [];
      for (const name of names
        .filter((n) => session.safeParse(n).success)
        .sort()) {
        try {
          const backendGeneration = await this.generation(name);
          // Discovery does not probe every server serially: one unresponsive
          // socket must not consume the finite call budget for the whole list.
          sessions.push({
            session: name,
            backendGeneration,
            endpointPresent: true,
          });
        } catch {
          sessions.push({ session: name, available: false });
        }
      }
      return accepted(page(sessions, p.cursor));
    }
    let generation: string;
    try {
      generation = await this.generation(p.session);
    } catch {
      throw new Fault("runtime_unavailable");
    }
    if (generation !== p.backendGeneration) throw new Fault("stale_reference");
    const args = definition.argv!(p, this.config.cwd);
    const key = [p.session, generation, p.name].join(":");
    if (method === "agent.start") {
      if (this.starting.get(key)?.state === "starting")
        throw new Fault("already_exists");
      if (
        [...this.starting.values()].filter((s) => s.state === "starting")
          .length >= 16
      )
        throw new Fault("resource_exhausted");
      // A native lookup prevents recognizing an existing named agent as this start.
      try {
        await this.execute(p.session, ["agent", "get", p.name]);
        throw new Fault("already_exists");
      } catch (e) {
        if (
          !(e instanceof Fault) ||
          e.code !== "native_error" ||
          !["agent_not_found", "agent_name_not_found"].includes(
            (e.native as any)?.code,
          )
        )
          throw e;
      }
      const attempt: { state: "starting" | "settled"; outcome?: Outcome } = {
        state: "starting",
      };
      this.starting.set(key, attempt);
      void this.execute(p.session, args, p.timeoutMs + 5000)
        .then(
          (result) => {
            attempt.outcome = accepted(result);
          },
          (e) => {
            attempt.outcome =
              e instanceof Fault ? e.outcome() : { execution: "unknown" };
          },
        )
        .finally(() => {
          attempt.state = "settled";
          if (this.starting.size > 128)
            for (const [k, a] of this.starting)
              if (a.state === "settled" && k !== key) {
                this.starting.delete(k);
                break;
              }
        });
      return {
        execution: "starting",
        result: {
          session: p.session,
          name: p.name,
          backendGeneration: generation,
          query: "agent.get",
        },
      };
    }
    let result: unknown;
    try {
      result = await this.execute(p.session, args);
    } catch (error) {
      // A failed asynchronous start may never register a native agent. Keep its
      // confirmed failure observable through the same advertised query key.
      if (
        method === "agent.get" &&
        this.starting.has(key) &&
        error instanceof Fault
      ) {
        return accepted({
          session: p.session,
          backendGeneration: generation,
          nativeError: error.outcome(),
          startup: this.starting.get(key),
        });
      }
      throw error;
    }
    return accepted({
      ...(result as object),
      session: p.session,
      backendGeneration: generation,
      ...(method === "agent.get" && this.starting.has(key)
        ? { startup: this.starting.get(key) }
        : {}),
    });
  }
  private stopEvents?: () => void;
  watchEvents(emit: (event: RuntimeEvent) => void) {
    this.stopEvents?.();
    const watchers = new Map<
      string,
      { generation: string; watch: HerdrEvents }
    >();
    let stopped = false,
      busy = false;
    const discover = async () => {
      if (busy || stopped || !this.available) return;
      busy = true;
      try {
        const names = [
          "default",
          ...(await readdir(join(this.config.configRoot, "sessions")).catch(
            () => [] as string[],
          )),
        ].filter((n) => session.safeParse(n).success);
        const live = new Set<string>();
        for (const name of names) {
          const generation = await this.generation(name).catch(() => undefined);
          if (!generation || stopped) continue;
          live.add(name);
          if (watchers.get(name)?.generation === generation) continue;
          watchers.get(name)?.watch.close();
          const watch = new HerdrEvents(
            this.socket(name),
            name,
            generation,
            emit,
          );
          watchers.set(name, { generation, watch });
          watch.start();
        }
        for (const [name, value] of watchers)
          if (!live.has(name)) {
            value.watch.close();
            watchers.delete(name);
            emit({
              eventId: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              serviceId: name,
              generation: value.generation,
              nativeType: "agenvo.resync_required",
              native: { reason: "service_unavailable" },
            });
          }
      } finally {
        busy = false;
      }
    };
    void discover();
    const timer = setInterval(() => void discover(), 3000);
    timer.unref();
    return (this.stopEvents = () => {
      stopped = true;
      clearInterval(timer);
      for (const v of watchers.values()) v.watch.close();
      watchers.clear();
    });
  }
  async close() {
    this.stopEvents?.();
    /* Herdr owns the server and its panes. */
  }
}
