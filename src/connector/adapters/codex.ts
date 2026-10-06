import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { connect as connectUnix } from "node:net";
import { realpath, stat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { z } from "zod";
import schemas from "./schema/codex.json";
import type { CodexConfig } from "../config.js";
import { accepted, type Adapter, type Method } from "./adapter.js";
import {
  enforcePolicy,
  enforceApproval,
  sharedFields,
} from "./codex-policy.js";
import {
  bytes,
  Fault,
  LIMITS,
  page,
  type Outcome,
} from "../../protocol/index.js";

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
for (const name of ["uint", "uint32", "uint64", "int64", "int32"])
  ajv.addFormat(name, true);
const methodValidators = new Map(
  Object.entries(schemas.methods).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
const responseValidators = new Map(
  Object.entries(schemas.responses).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
type Interaction = {
  interactionId: string;
  nativeId: string | number;
  method: string;
  params: Record<string, any>;
  contentRead: boolean;
  pathsWithinCeiling?: boolean;
};
type Rpc = { resolve(value: unknown): void; reject(error: Fault): void };
export class CodexAdapter implements Adapter {
  version = "unknown";
  available = false;
  onAvailabilityChange?: () => void;
  private child?: ChildProcessWithoutNullStreams;
  private socket?: WebSocket;
  private reconnect?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private subscriptions = new Set<string>();
  private generation = randomUUID();
  private id = 0;
  private pending = new Map<number, Rpc>();
  private interactions = new Map<string, Interaction>();
  private interactionBytes = 0;
  private fileChanges = new Map<
    string,
    { threadId: string; turnId: string; item: any }
  >();
  private readBuffer = Buffer.alloc(0);
  private closed = false;
  constructor(public config: CodexConfig) {}
  async init() {
    const { stdout } = await promisify(execFile)(
      this.config.binary,
      ["--version"],
      { timeout: 8000 },
    );
    this.version = stdout.trim();
    if (!/\b0\.160\.1\b/.test(this.version))
      throw new Fault("unsupported_backend_version");
    if (this.config.mode === "attach-unix") {
      try {
        await this.attach();
      } catch (error) {
        if (
          error instanceof Fault &&
          [
            "unsupported_backend_version",
            "backend_home_mismatch",
            "insecure_socket",
          ].includes(error.code)
        )
          throw error;
        this.fail();
      }
      return;
    }
    this.child = spawn(this.config.binary, ["app-server", "--stdio"], {
      cwd: this.config.cwd,
      env: { ...process.env, CODEX_HOME: this.config.home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume(); // Native logs may contain private prompts; never relay them.
    this.child.stdout.on("data", (data: Buffer) => {
      this.readBuffer = Buffer.concat([this.readBuffer, data]);
      let end: number;
      while ((end = this.readBuffer.indexOf(10)) >= 0) {
        const line = this.readBuffer.subarray(0, end);
        this.readBuffer = this.readBuffer.subarray(end + 1);
        if (line.length > LIMITS.parse) {
          this.fail();
          return;
        }
        try {
          this.receive(JSON.parse(line.toString("utf8")));
        } catch {
          this.fail();
          return;
        }
      }
      if (this.readBuffer.length > LIMITS.parse) this.fail();
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
    await this.rpc("initialize", {
      clientInfo: { name: "siyin", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ jsonrpc: "2.0", method: "initialized" });
    this.available = true;
  }
  private async attach() {
    if (this.closed) throw new Fault("runtime_unavailable");
    const path = this.config.socketPath!;
    const info = await stat(path);
    const parent = await stat(dirname(await realpath(path)));
    if (
      !info.isSocket() ||
      info.uid !== process.getuid?.() ||
      parent.uid !== info.uid ||
      (parent.mode & 0o022) !== 0
    )
      throw new Fault(
        "insecure_socket",
        "Use a Unix socket in a private directory owned by this user",
      );
    if (this.closed) throw new Fault("runtime_unavailable");
    const ws = (this.socket = new WebSocket("ws://localhost/rpc", {
      createConnection: () => connectUnix(path),
      maxPayload: LIMITS.parse,
      handshakeTimeout: 8000,
    }));
    ws.on("message", (raw) => {
      if (this.socket !== ws) return;
      try {
        this.receive(JSON.parse(raw.toString()));
      } catch {
        this.fail();
      }
    });
    ws.on("error", () => {
      if (this.socket === ws) this.fail();
    });
    ws.on("close", () => {
      if (this.socket === ws) this.fail();
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("close", () => reject(new Fault("runtime_unavailable")));
    });
    const init: any = await this.rpc("initialize", {
      clientInfo: { name: "siyin", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    if (!/\/0\.160\.1(?: |$)/.test(init.userAgent ?? ""))
      throw new Fault("unsupported_backend_version");
    if ((await realpath(init.codexHome)) !== this.config.home)
      throw new Fault("backend_home_mismatch");
    this.write({ jsonrpc: "2.0", method: "initialized" });
    // Resubscribe without resending turns or applying configuration overrides.
    for (const threadId of this.subscriptions) {
      try {
        await this.rpc("thread/resume", { threadId, excludeTurns: true });
      } catch (error) {
        if (error instanceof Fault && error.code === "native_error")
          this.subscriptions.delete(threadId);
        else throw error;
      }
    }
    if (this.socket !== ws || ws.readyState !== WebSocket.OPEN)
      throw new Fault("runtime_unavailable");
    this.reconnectAttempt = 0;
    this.available = true;
    this.onAvailabilityChange?.();
  }
  private write(value: unknown) {
    if (this.config.mode === "attach-unix") {
      if (
        this.socket?.readyState !== WebSocket.OPEN ||
        this.socket.bufferedAmount > LIMITS.parse
      )
        throw new Fault(
          "runtime_unavailable",
          "Native transport unavailable",
          "unknown",
        );
      this.socket.send(JSON.stringify(value));
      return;
    }
    if (
      !this.child?.stdin.writable ||
      this.child.stdin.writableLength > LIMITS.parse
    )
      throw new Fault(
        "runtime_unavailable",
        "Native transport unavailable",
        "unknown",
      );
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private rpc(method: string, params: unknown): Promise<unknown> {
    if (this.pending.size >= 16) throw new Fault("resource_exhausted");
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Fault(
            "execution_unknown",
            "Codex did not confirm within 8 seconds; inspect native state.",
            "unknown",
          ),
        );
      }, 8000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private receive(packet: any) {
    if (!packet || typeof packet !== "object")
      throw new Error("invalid_packet");
    if (
      this.config.mode === "attach-unix" &&
      packet.method === "item/completed"
    ) {
      // Some native request types have no serverRequest/resolved broadcast.
      // Item completion is also authoritative, including another client's answer.
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turnId &&
          (r.params.itemId === packet.params?.item?.id ||
            r.params.callId === packet.params?.item?.id)
        )
          this.interactions.delete(id);
      this.recount();
    }
    if (
      packet.method === "item/started" &&
      packet.params?.item?.type === "fileChange"
    ) {
      this.rememberFile(
        packet.params.threadId,
        packet.params.turnId,
        packet.params.item,
      );
    } else if (packet.method === "item/fileChange/patchUpdated") {
      const p = packet.params;
      const previous = this.fileChanges.get(this.fileKey(p));
      if (previous)
        this.rememberFile(p.threadId, p.turnId, {
          ...previous.item,
          changes: p.changes,
        });
    } else if (
      packet.method === "item/completed" &&
      packet.params?.item?.type === "fileChange"
    ) {
      this.forgetFile(
        this.fileKey({ ...packet.params, itemId: packet.params.item.id }),
      );
    } else if (packet.method === "serverRequest/resolved") {
      for (const [id, r] of this.interactions)
        if (
          r.nativeId === packet.params?.requestId &&
          r.params.threadId === packet.params?.threadId
        )
          this.interactions.delete(id);
      this.recount();
    } else if (packet.method && packet.id !== undefined) {
      if (!responseValidators.has(packet.method)) {
        if (this.config.mode === "attach-unix") return; // The owning app can answer unsupported requests.
        this.write({
          jsonrpc: "2.0",
          id: packet.id,
          error: {
            code: -32601,
            message:
              "Server request is not supported by this connector; handle it locally.",
          },
        });
        return;
      }
      for (const [id, r] of this.interactions)
        if (r.nativeId === packet.id) this.interactions.delete(id);
      this.recount();
      const interactionId = this.generation + ":" + randomUUID();
      const interaction: Interaction = {
        interactionId,
        nativeId: packet.id,
        method: packet.method,
        params: packet.params,
        contentRead: false,
        pathsWithinCeiling: false,
      };
      const size = bytes(interaction);
      if (
        bytes({
          ...interaction,
          responseSchema:
            schemas.responses[packet.method as keyof typeof schemas.responses],
        }) >
          LIMITS.frame - 4096 ||
        this.interactionBytes +
          size +
          [...this.fileChanges.values()].reduce((n, f) => n + bytes(f), 0) >
          LIMITS.parse
      ) {
        if (this.config.mode === "attach-unix") return;
        this.write({
          jsonrpc: "2.0",
          id: packet.id,
          error: {
            code: -32000,
            message: "Siyin input capacity exceeded; use the local runtime.",
          },
        });
        return;
      }
      this.interactions.set(interactionId, interaction);
      this.recount();
    } else if (["thread/closed", "thread/archived"].includes(packet.method)) {
      const threadId = packet.params?.threadId;
      this.subscriptions.delete(threadId);
      for (const [id, r] of this.interactions)
        if (r.params.threadId === threadId) this.interactions.delete(id);
      for (const [key, f] of this.fileChanges)
        if (f.threadId === threadId) this.fileChanges.delete(key);
      this.recount();
    } else if (packet.method === "turn/completed") {
      for (const [id, r] of this.interactions)
        if (
          r.params.threadId === packet.params?.threadId &&
          r.params.turnId === packet.params?.turn?.id
        )
          this.interactions.delete(id);
      for (const [key, file] of this.fileChanges)
        if (
          file.threadId === packet.params?.threadId &&
          file.turnId === packet.params?.turn?.id
        )
          this.fileChanges.delete(key);
      this.recount();
    } else if (!packet.method && typeof packet.id === "number") {
      const pending = this.pending.get(packet.id);
      this.pending.delete(packet.id);
      if (packet.error)
        pending?.reject(
          new Fault(
            "native_error",
            "Codex rejected the request",
            "rejected",
            packet.error,
          ),
        );
      else pending?.resolve(packet.result);
    }
    // Notifications are owned by Codex. v0.1 reads native history on demand.
  }
  private fileKey(p: Record<string, any>) {
    return JSON.stringify([p.threadId, p.turnId, p.itemId]);
  }
  private forgetFile(key: string) {
    this.fileChanges.delete(key);
    for (const i of this.interactions.values())
      if (this.fileKey(i.params) === key) {
        i.contentRead = false;
        i.pathsWithinCeiling = false;
      }
    this.recount();
  }
  private rememberFile(threadId: string, turnId: string, item: any) {
    const key = this.fileKey({ threadId, turnId, itemId: item.id });
    this.forgetFile(key);
    const entry = { threadId, turnId, item };
    if (bytes(entry) > LIMITS.frame - 4096) return;
    this.fileChanges.set(key, entry);
    while (
      this.fileChanges.size > 0 &&
      [...this.fileChanges.values()].reduce((n, f) => n + bytes(f), 0) +
        this.interactionBytes >
        LIMITS.parse
    ) {
      this.forgetFile(this.fileChanges.keys().next().value!);
    }
  }
  private async withinWorkspace(item: any): Promise<boolean> {
    if (!Array.isArray(item.changes) || !item.changes.length) return false;
    const paths = item.changes.flatMap((change: any) => [
      change.path,
      ...(change.kind?.move_path ? [change.kind.move_path] : []),
    ]);
    return (
      await Promise.all(
        paths.map(async (path: unknown) => {
          if (typeof path !== "string") return false;
          const target = resolve(this.config.cwd, path);
          try {
            const actual = await realpath(target).catch(async (error) => {
              if (error.code !== "ENOENT") throw error;
              return resolve(
                await realpath(dirname(target)),
                target.split("/").at(-1)!,
              );
            });
            const rel = relative(this.config.cwd, actual);
            return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
          } catch {
            return false;
          }
        }),
      )
    ).every(Boolean);
  }
  private recount() {
    this.interactionBytes = [...this.interactions.values()].reduce(
      (n, i) => n + bytes(i),
      0,
    );
  }
  private fail() {
    const wasAvailable = this.available;
    this.available = false;
    if (wasAvailable) this.onAvailabilityChange?.();
    for (const p of this.pending.values())
      p.reject(
        new Fault(
          "execution_unknown",
          "Codex app server exited or transport failed",
          "unknown",
        ),
      );
    this.pending.clear();
    this.interactions.clear();
    this.interactionBytes = 0;
    this.fileChanges.clear();
    if (this.config.mode === "attach-unix") {
      const ws = this.socket;
      this.socket = undefined;
      ws?.terminate();
      this.generation = randomUUID();
      if (!this.closed && !this.reconnect) {
        this.reconnect = setTimeout(
          () => {
            this.reconnect = undefined;
            void this.attach().catch((error) => {
              if (
                error instanceof Fault &&
                [
                  "unsupported_backend_version",
                  "backend_home_mismatch",
                  "insecure_socket",
                ].includes(error.code)
              )
                this.closed = true;
              this.fail();
            });
          },
          Math.min(30000, 1000 * 2 ** this.reconnectAttempt++),
        );
        this.reconnect.unref();
      }
    }
    if (this.child && !this.closed) {
      this.closed = true;
      this.child.kill("SIGTERM");
    }
  }
  methods(): Method[] {
    return [
      ...Object.entries(schemas.methods).map(([name, schema]) => ({
        name,
        readOnly: /(?:\/list|\/read)$/.test(name),
        description:
          (this.config.mode === "attach-unix"
            ? "Shared Codex 0.160.1 native method; existing thread settings are preserved."
            : "Codex 0.160.1 native method; local policy applies.") +
          (["thread/read", "thread/turns/list"].includes(name)
            ? " Codex 0.160.1 may reject turn-history reads with list_turns is not supported yet; use thread/read without includeTurns for metadata."
            : ""),
        inputSchema:
          this.config.mode === "attach-unix" && sharedFields[name]
            ? {
                ...schema,
                properties: Object.fromEntries(
                  Object.entries(schema.properties).filter(([key]) =>
                    sharedFields[name].includes(key),
                  ),
                ),
              }
            : schema,
      })),
      {
        name: "requests.list",
        readOnly: true,
        description:
          "Pending native input/approval requests. Read file changes with requests.read before approval; history may not contain pending items.",
        inputSchema: z.toJSONSchema(
          z.strictObject({ cursor: z.string().optional() }),
        ),
      },
      {
        name: "requests.read",
        readOnly: true,
        description:
          "Read the complete native pending file-change item. Fails explicitly if unavailable or too large; never fabricates a diff.",
        inputSchema: z.toJSONSchema(
          z.strictObject({ interactionId: z.string() }),
        ),
      },
      {
        name: "requests.respond",
        readOnly: false,
        description:
          "Answer one pending interaction once. Persistent policy amendments are denied. Native response schemas are included in requests.list.",
        inputSchema: z.toJSONSchema(
          z.strictObject({
            interactionId: z.string(),
            result: z.record(z.string(), z.unknown()),
          }),
        ),
      },
    ];
  }
  async call(
    method: string,
    original: Record<string, unknown>,
  ): Promise<Outcome> {
    if (!this.available) throw new Fault("runtime_unavailable");
    if (method === "requests.list") {
      const p = z
        .strictObject({ cursor: z.string().optional() })
        .parse(original);
      return accepted(
        page(
          [...this.interactions.values()].map((i) => ({
            ...i,
            responseSchema:
              schemas.responses[i.method as keyof typeof schemas.responses],
            ...(i.method === "item/fileChange/requestApproval"
              ? {
                  read: {
                    method: "requests.read",
                    params: { interactionId: i.interactionId },
                    itemId: i.params.itemId,
                  },
                  localApprovalRequired:
                    !i.contentRead ||
                    (this.config.mode !== "attach-unix" &&
                      (!i.pathsWithinCeiling ||
                        this.config.policy.sandbox === "read-only")),
                }
              : {}),
          })),
          p.cursor,
        ),
      );
    }
    if (method === "requests.read") {
      const p = z.strictObject({ interactionId: z.string() }).parse(original);
      const interaction = this.interactions.get(p.interactionId);
      if (!interaction) throw new Fault("interaction_expired");
      if (interaction.method !== "item/fileChange/requestApproval")
        throw new Fault("unsupported_method");
      const file = this.fileChanges.get(this.fileKey(interaction.params));
      if (!file)
        throw new Fault(
          "local_approval_required",
          "Complete pending changes are unavailable or exceed capacity; handle locally",
        );
      const within =
        this.config.mode === "attach-unix" ||
        (await this.withinWorkspace(file.item));
      if (this.fileChanges.get(this.fileKey(interaction.params)) !== file)
        throw new Fault(
          "content_changed",
          "Read the changed proposal again before deciding",
        );
      interaction.contentRead = true;
      interaction.pathsWithinCeiling = within;
      return accepted(file);
    }
    if (method === "requests.respond") {
      const p = z
        .strictObject({
          interactionId: z.string(),
          result: z.record(z.string(), z.unknown()),
        })
        .parse(original);
      const interaction = this.interactions.get(p.interactionId);
      if (!interaction) throw new Fault("interaction_expired");
      this.validate(responseValidators.get(interaction.method)!, p.result);
      enforceApproval(
        this.config,
        interaction.method,
        interaction.params,
        p.result,
      );
      if (
        interaction.method === "item/fileChange/requestApproval" &&
        String(p.result.decision).startsWith("accept") &&
        (!interaction.contentRead || !interaction.pathsWithinCeiling)
      )
        throw new Fault(
          "local_approval_required",
          "Read complete native changes within the configured workspace before approving; otherwise handle locally.",
        );
      this.interactions.delete(p.interactionId);
      this.recount();
      this.write({
        jsonrpc: "2.0",
        id: interaction.nativeId,
        result: p.result,
      });
      return accepted({
        interactionId: p.interactionId,
        submitted: true,
        ...(this.config.mode === "attach-unix"
          ? {
              resolution: "unconfirmed",
              note: "The native server arbitrates concurrent answers. Inspect native turn/item state; submission is not proof this answer won.",
            }
          : {}),
      });
    }
    const validator = methodValidators.get(method);
    if (!validator) throw new Fault("unsupported_method");
    this.validate(validator, original);
    const params = enforcePolicy(this.config, method, original);
    if (
      this.config.mode === "attach-unix" &&
      ["thread/start", "thread/resume"].includes(method) &&
      this.subscriptions.size >= 128 &&
      !this.subscriptions.has(String(params.threadId))
    )
      throw new Fault("resource_exhausted");
    const result: any = await this.rpc(method, params);
    if (
      this.config.mode === "attach-unix" &&
      ["thread/start", "thread/resume"].includes(method) &&
      typeof result?.thread?.id === "string"
    )
      this.subscriptions.add(result.thread.id);
    if (method === "thread/archive")
      this.subscriptions.delete(String(params.threadId));
    return accepted(result);
  }
  private validate(validator: ValidateFunction, input: unknown) {
    if (!validator(input))
      throw new Fault(
        "invalid_params",
        "Parameters do not match the approved native schema",
      );
  }
  async close() {
    const child = this.child;
    if (this.config.mode === "attach-unix") {
      this.closed = true;
      clearTimeout(this.reconnect);
      this.reconnect = undefined;
      this.subscriptions.clear();
    }
    this.fail();
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
