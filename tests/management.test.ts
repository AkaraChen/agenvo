import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CodexManagement } from "../apps/codex-app-server/src/codex-management.js";
import { Fault } from "@agenvo/protocol";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { HerdrAdapter } from "../apps/herdr/src/herdr.js";
import { HerdrManagement } from "../apps/herdr/src/herdr-management.js";
import { instanceConfigSchema } from "./support/config.js";
import { describe, accepted } from "@agenvo/connector/adapters/adapter";
import { References } from "@agenvo/connector/adapters/management";
import { Observations } from "@agenvo/connector/adapters/observations";
import { fullAccessArgs } from "../apps/herdr/src/herdr-execution.js";

test("opaque references reject another instance, forgery, wrong object kind and restart", () => {
  const first = new References(),
    second = new References();
  const ref = first.issue("thread", { threadId: "external" });
  assert.deepEqual(first.read(ref, "thread"), { threadId: "external" });
  assert.throws(() => second.read(ref, "thread"), { code: "stale_reference" });
  assert.throws(() => first.read(ref + "forged", "thread"), {
    code: "stale_reference",
  });
  assert.throws(() => first.read(ref, "interaction"), {
    code: "invalid_reference",
  });
  first.reset();
  assert.throws(() => first.read(ref, "thread"), { code: "stale_reference" });
});

test("observations paginate with explicit eviction, truncation and reconnect gaps", () => {
  const journal = new Observations(1024, 3);
  const before = journal.list("t").nextCursor;
  for (let i = 0; i < 4; i++) journal.append("t", "turn/completed", { id: i });
  const first = journal.list("t", before, 2);
  assert.equal(first.gap, true);
  assert.deepEqual(
    first.items.map((i) => (i.data as any).id),
    [1, 2],
  );
  assert.equal(first.caughtUp, false);
  const next = journal.list("t", first.nextCursor);
  assert.equal(next.gap, false);
  assert.deepEqual(
    next.items.map((i) => (i.data as any).id),
    [3],
  );
  journal.append("t", "large", "x".repeat(2000));
  assert.equal(journal.list("t", next.nextCursor).items[0].truncated, true);
  journal.reset();
  const reset = journal.list("t", next.nextCursor);
  assert.equal(reset.gap, true);
  assert.equal(reset.items.length, 0);
  assert.throws(
    () => journal.list("t", reset.nextCursor.replace(/:0$/, ":99")),
    {
      code: "invalid_cursor",
    },
  );
});

test("management transport discovers external threads and preserves turns, interactions and native errors", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "agenvo-management-")),
  );
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: resolve("tests/fixtures/codex-backend.mjs"),
    cwd: root,
    home: root,
    mode: "managed-stdio",
  });
  if (config.kind !== "codex") throw Error();
  const a = new CodexAdapter(config);
  t.after(async () => {
    await a.close();
    await rm(root, { recursive: true, force: true });
  });
  await a.init();
  assert.equal(describe(a, {}).managementVersion, 1);
  assert.ok(a.methods().some((m) => m.name === "turn/start"));
  const publicMethods = a.management.methods();
  assert.equal(
    publicMethods.some((m) =>
      /management\.(agents|runs|observations)\./.test(m.name),
    ),
    false,
  );
  assert.equal(JSON.stringify(publicMethods).includes("runRef"), false);
  assert.equal(
    publicMethods.some((m) => m.name === "management.threads.steer"),
    false,
  );
  const services: any = (await a.call("management.services.list", {})).result;
  const serviceRef = services.items[0].serviceRef;
  const found: any = (await a.call("management.threads.list", { serviceRef }))
    .result;
  const threadRef = found.items[0].threadRef;
  assert.equal(found.items[0].native.id, "t");
  assert.equal(found.items[0].activity, "idle");
  await assert.rejects(
    a.call("management.threads.send", {
      threadRef,
      text: "test",
      providerOptions: { threadId: "other" },
    }),
    { code: "invalid_params" },
  );
  const created: any = (
    await a.call("management.threads.create", { serviceRef })
  ).result;
  assert.equal(created.thread.native.id, "t");
  const current: any = (await a.call("management.threads.get", { threadRef }))
    .result;
  assert.equal(current.thread.activity, "idle");
  assert.equal(current.thread.success, undefined);
  const sent: any = (
    await a.call("management.threads.send", { threadRef, text: "Work" })
  ).result;
  assert.equal(sent.native.turn.status, "inProgress");
  assert.equal(sent.confirmation, "native_input_accepted");
  await a.call("turn/steer", {
    threadId: "t",
    expectedTurnId: sent.native.turn.id,
    input: [{ type: "text", text: "Focus" }],
  });
  const requests: any = (
    await a.call("management.interactions.list", { threadRef })
  ).result;
  assert.equal(requests.items.length, 2);
  const observed: any = (
    await a.call("management.threads.observe", { threadRef })
  ).result;
  assert.equal(observed.interactions.items.length, 2);
  assert.ok(observed.interactions.items.every((i: any) => i.interactionRef));
  const other = a.management.refs.issue("thread", { threadId: "other" });
  const otherRequests: any = (
    await a.call("management.interactions.list", { threadRef: other })
  ).result;
  assert.equal(otherRequests.items.length, 0);
  const request = requests.items.find(
    (i: any) => i.method === "item/tool/requestUserInput",
  );
  const read: any = (
    await a.call("management.interactions.read", {
      interactionRef: request.interactionRef,
    })
  ).result;
  assert.equal(read.params.questions[0].id, "label");
  await a.call("management.interactions.respond", {
    interactionRef: request.interactionRef,
    result: { answers: { label: { answers: ["Alpha"] } } },
  });
  await assert.rejects(
    a.call("management.interactions.read", {
      interactionRef: request.interactionRef,
    }),
    { code: "interaction_expired" },
  );
  await assert.rejects(a.call("management.threads.read", { threadRef }), {
    code: "native_error",
  });
  const interrupt: any = (
    await a.call("management.threads.interrupt", { threadRef })
  ).result;
  assert.equal(interrupt.interruption, "requested");
  const events: any = (
    await a.call("management.threads.observe", { threadRef, limit: 50 })
  ).result;
  assert.equal(events.gap, false);
  assert.ok(
    events.items.some(
      (i: any) =>
        i.type === "turn/completed" &&
        i.data.native.turn.status === "interrupted",
    ),
  );
  assert.ok(
    events.items.some((i: any) => i.type === "item/agentMessage/delta"),
  );
  for (const action of ["resume", "archive", "unarchive"])
    await a.call("management.threads." + action, { threadRef });
  const native: any = (await a.call("thread/read", { threadId: "t" })).result;
  const starts = native.calls.filter((c: any) => c.method === "turn/start");
  assert.equal(
    starts.length,
    1,
    "invalid overrides must fail before native execution",
  );
  assert.deepEqual(starts[0].params.sandboxPolicy, {
    type: "dangerFullAccess",
  });
  assert.equal(starts[0].params.approvalPolicy, "never");
});

test("Herdr identity checks stop replaced occupants and never promote done to success", async () => {
  const cfg = {
    kind: "herdr" as const,
    id: "h",
    label: "H",
    binary: "/bin/herdr",
    cwd: "/tmp",
    configRoot: "/tmp/herdr",
  };
  const schemas = new HerdrAdapter(cfg).methods();
  let info = {
    name: "external",
    terminal_id: "terminal",
    pane_id: "w1:p1",
    agent: "codex",
    agent_status: "done",
    agent_session: { value: "first" },
  };
  let prompts = 0;
  let reads = 0;
  const manager = new HerdrManagement(
    async (method, p) => {
      if (method === "session.list")
        return accepted({
          items: [
            {
              session: "test",
              backendGeneration: "a".repeat(64),
              endpointPresent: true,
            },
          ],
        });
      if (method === "agent.list")
        return accepted({ result: { agents: [info] } });
      if (method === "agent.get") return accepted({ result: { agent: info } });
      if (method === "agent.prompt") {
        prompts++;
        return accepted({ result: {} });
      }
      if (method === "agent.read") {
        reads++;
        return accepted({ result: { output: "Snapshot " + reads } });
      }
      throw Error("unexpected method: " + method);
    },
    () => schemas,
  );
  const services: any = (await manager.call("management.services.list", {}))
    .result;
  const agents: any = (
    await manager.call("management.threads.list", {
      serviceRef: services.items[0].serviceRef,
    })
  ).result;
  const a = agents.items[0];
  assert.equal(a.activity, "idle");
  assert.equal(a.operations.send.available, true);
  assert.equal(a.success, undefined);
  await manager.call("management.threads.send", {
    threadRef: a.threadRef,
    text: "Continue",
  });
  const first: any = (
    await manager.call("management.threads.observe", { threadRef: a.threadRef })
  ).result;
  assert.equal(first.thread.activity, "idle");
  assert.equal(reads, 1);
  info = { ...info, agent_status: "working" };
  const next: any = (
    await manager.call("management.threads.observe", {
      threadRef: a.threadRef,
      cursor: first.nextCursor,
    })
  ).result;
  assert.equal(next.thread.activity, "working");
  assert.equal(next.thread.operations.send.available, true);
  assert.equal(reads, 2);
  assert.equal(
    next.items.find((i: any) => i.type === "terminal.observed").data.native
      .result.output,
    "Snapshot 2",
  );
  assert.equal(next.coverage.intermediateTransitions, "may_be_missed");
  for (const status of [
    { agent_status: "blocked", launch_pending: false },
    { agent_status: "idle", launch_pending: true },
  ]) {
    Object.assign(info, status);
    const state: any = (
      await manager.call("management.threads.get", { threadRef: a.threadRef })
    ).result;
    assert.equal(state.thread.operations.send.available, false);
  }
  Object.assign(info, { agent_status: "idle", launch_pending: false });
  info = { ...info, agent_session: { value: "replacement" } };
  await assert.rejects(
    manager.call("management.threads.send", {
      threadRef: a.threadRef,
      text: "Wrong target",
    }),
    { code: "stale_reference" },
  );
  assert.equal(prompts, 1);
  await assert.rejects(
    manager.call("management.threads.interrupt", { threadRef: a.threadRef }),
    { code: "unsupported_capability" },
  );
});

test("Herdr launch flags force supported agents into full access", () => {
  assert.ok(
    fullAccessArgs("codex", ["--no-daemon"]).includes(
      "--dangerously-bypass-approvals-and-sandbox",
    ),
  );
  assert.deepEqual(fullAccessArgs("devin", []), [
    "--permission-mode",
    "dangerous",
    "--respect-workspace-trust",
    "false",
  ]);
  assert.ok(
    fullAccessArgs("claude", []).includes("--dangerously-skip-permissions"),
  );
  assert.throws(() => fullAccessArgs("codex", ["--sandbox=read-only"]), {
    code: "invalid_params",
  });
  assert.throws(() => fullAccessArgs("opencode", []), {
    code: "unsupported_capability",
  });
});

test("large completion events retain native turn identity and outcome", () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: "/bin/codex",
    cwd: "/tmp",
    home: "/tmp/codex",
    mode: "managed-stdio",
  });
  if (config.kind !== "codex") throw Error();
  const manager = new CodexAdapter(config).management;
  manager.notify("turn/completed", {
    threadId: "t",
    turn: { id: "run", status: "completed", items: ["x".repeat(100000)] },
  });
  const entry = manager.observations.list("t").items[0];
  assert.equal(entry.truncated, true);
  assert.equal((entry.data as any).native.turnId, "run");
  assert.equal((entry.data as any).native.status, "completed");
});

test("Herdr startup polling preserves failures but recovers live agents after uncertain startup", async () => {
  const config = {
    kind: "herdr" as const,
    id: "test",
    label: "Test",
    binary: "/bin/herdr",
    cwd: "/tmp",
    configRoot: "/tmp/herdr",
  };
  const schemas = new HerdrAdapter(config).methods();
  let failed = false;
  let startupCode = "already_exists";
  let live = true;
  const manager = new HerdrManagement(
    async (method) => {
      if (method === "session.list")
        return accepted({
          items: [
            {
              session: "test",
              backendGeneration: "a".repeat(64),
              endpointPresent: true,
            },
          ],
        });
      if (method === "agent.start") return { execution: "starting" };
      if (method === "agent.get")
        return accepted({
          result: {
            agent: live
              ? {
                  name: "new",
                  agent: "codex",
                  terminal_id: "terminal",
                  pane_id: failed ? "w1:p1" : "w2:p1",
                  agent_status: "idle",
                }
              : undefined,
          },
          ...(failed
            ? {
                startup: {
                  state: "settled",
                  outcome: {
                    execution: "rejected",
                    error: {
                      code: "native_error",
                      native: { code: startupCode },
                    },
                  },
                },
              }
            : {}),
        });
      throw Error("unexpected method");
    },
    () => schemas,
  );
  const services: any = (await manager.call("management.services.list", {}))
    .result;
  const started: any = (
    await manager.call("management.threads.create", {
      serviceRef: services.items[0].serviceRef,
      providerOptions: { name: "new", paneId: "w1:p1", kind: "codex" },
    })
  ).result;
  await assert.rejects(
    manager.call(started.query.method, started.query.params),
    { code: "stale_reference" },
  );
  failed = true;
  const state: any = (
    await manager.call(started.query.method, started.query.params)
  ).result;
  assert.equal(state.thread, undefined);
  assert.equal(state.nativeError.error.native.code, "already_exists");
  startupCode = "timeout";
  const recovered: any = (
    await manager.call(started.query.method, started.query.params)
  ).result;
  assert.equal(recovered.thread.activity, "idle");
  assert.equal(recovered.thread.operations.send.available, true);
  assert.equal(recovered.startup.outcome.error.native.code, "timeout");
  failed = false;
  await assert.rejects(
    manager.call(started.query.method, started.query.params),
    { code: "stale_reference" },
  );
  failed = true;
  live = false;
  const lost: any = (
    await manager.call(started.query.method, started.query.params)
  ).result;
  assert.equal(lost.thread, undefined);
  assert.equal(lost.expectedPaneId, "w1:p1");
  assert.equal(lost.serviceRef, services.items[0].serviceRef);
});

test("thread observation cursors filter interleaved events and cannot cross threads", () => {
  const journal = new Observations();
  journal.append("a", "turn/completed", { status: "failed" });
  journal.append("b", "output", { text: "private to b" });
  journal.append("a", "output", { text: "next turn" });
  journal.append("b", "output", {});
  const first = journal.list("a", undefined, 1);
  assert.equal(first.items.length, 1);
  assert.equal(first.caughtUp, false);
  const second = journal.list("a", first.nextCursor, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].type, "output");
  assert.equal(second.caughtUp, true);
  assert.equal(journal.list("a", second.nextCursor).items.length, 0);
  assert.throws(() => journal.list("b", first.nextCursor), {
    code: "invalid_cursor",
  });
});

test("thread interrupt binds one native turn and never retargets after a race or uncertain result", async () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: "/bin/codex",
    cwd: "/tmp",
    home: "/tmp/test",
    mode: "managed-stdio",
  });
  if (config.kind !== "codex") throw Error();
  const methods = new CodexAdapter(config).methods();
  let active = true;
  let uncertain = false;
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const manager = new CodexManagement(
    config,
    async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/turns/list")
        return accepted({
          data: active ? [{ id: "old", status: "inProgress" }] : [],
        });
      if (method === "turn/interrupt") {
        if (uncertain)
          return {
            execution: "unknown",
            error: {
              code: "transport_failed",
              message: "Connection closed after dispatch",
            },
          };
        throw new Fault(
          "native_error",
          "The old turn ended and another turn is active.",
        );
      }
      throw Error("Unexpected native method");
    },
    () => methods,
  );
  const threadRef = manager.refs.issue("thread", { threadId: "t" });
  await assert.rejects(
    manager.call("management.threads.interrupt", { threadRef }),
    { code: "native_error" },
  );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["thread/turns/list", "turn/interrupt"],
  );
  assert.equal(calls[1].params.turnId, "old");
  calls.length = 0;
  uncertain = true;
  assert.equal(
    (await manager.call("management.threads.interrupt", { threadRef }))
      .execution,
    "unknown",
  );
  assert.equal(calls.length, 2);
  calls.length = 0;
  active = false;
  await assert.rejects(
    manager.call("management.threads.interrupt", { threadRef }),
    { code: "no_active_execution" },
  );
  assert.equal(calls.length, 1);
});

test("observe subscribes a discovered thread once and validates cursor scope before native calls", async () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: "/bin/codex",
    cwd: "/tmp",
    home: "/tmp/test",
    mode: "managed-stdio",
  });
  if (config.kind !== "codex") throw Error();
  const methods = new CodexAdapter(config).methods();
  const calls: string[] = [];
  const manager = new CodexManagement(
    config,
    async (method, params) => {
      calls.push(method);
      if (method === "thread/resume") {
        manager.subscribed(String(params.threadId));
        return accepted({ thread: { id: params.threadId } });
      }
      if (method === "thread/read")
        return accepted({
          thread: { id: params.threadId, status: { type: "idle" } },
        });
      if (method === "requests.list") return accepted({ items: [] });
      throw Error("Observation must not submit input");
    },
    () => methods,
  );
  const threadRef = manager.refs.issue("thread", { threadId: "a" });
  manager.notify("turn/completed", {
    threadId: "a",
    turn: { id: "previous", status: "failed", error: { message: "Failure" } },
  });
  manager.notify("turn/completed", {
    threadId: "b",
    turn: { id: "other", status: "completed" },
  });
  const first: any = (
    await manager.call("management.threads.observe", { threadRef })
  ).result;
  assert.equal(first.thread.activity, "idle");
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].data.native.turn.error.message, "Failure");
  assert.equal(first.coverage.subscribed, true);
  const next: any = (
    await manager.call("management.threads.observe", {
      threadRef,
      cursor: first.nextCursor,
    })
  ).result;
  assert.equal(next.items.length, 0);
  assert.equal(calls.filter((m) => m === "thread/resume").length, 1);
  calls.length = 0;
  await assert.rejects(
    manager.call("management.threads.observe", {
      threadRef: manager.refs.issue("thread", { threadId: "b" }),
      cursor: first.nextCursor,
    }),
    { code: "invalid_cursor" },
  );
  assert.equal(calls.length, 0);
});
