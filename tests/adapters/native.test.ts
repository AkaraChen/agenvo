import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HerdrAdapter } from "../../src/connector/adapters/herdr.ts";
import { CodexAdapter } from "../../src/connector/adapters/codex.ts";
import { instanceConfigSchema } from "../../src/connector/config.ts";
import { herdrFixture } from "../fixtures/herdr-runtime.ts";
const exec = promisify(execFile);
async function executable(name: string) {
  return (await exec("/bin/sh", ["-c", "command -v " + name])).stdout.trim();
}

test("Herdr isolated sessions preserve references across connector reconstruction", async (t) => {
  const base = await realpath(await mkdtemp("/tmp/agenvo-h-"));
  const root = join(base, "herdr");
  await mkdir(root);
  const binary = await executable("herdr");
  const cfg = instanceConfigSchema.parse({
    kind: "herdr",
    id: "work",
    label: "Test",
    binary,
    cwd: root,
    configRoot: root,
  });
  if (cfg.kind !== "herdr") throw new Error();
  const a = new HerdrAdapter(cfg);
  await a.init();
  assert.equal(a.available, true);
  const native = herdrFixture(cfg, "test");
  await native.start();
  const ref = {
    session: "test",
    backendGeneration: await a.generation("test"),
  };
  assert.equal(
    a
      .methods()
      .some((m) => m.name === "session.start" || m.name === "session.stop"),
    false,
  );
  await assert.rejects(a.call("session.start", { session: "test" }), {
    code: "unsupported_method",
  });
  await assert.rejects(a.call("session.stop", ref), {
    code: "unsupported_method",
  });
  assert.equal(await a.generation("test"), ref.backendGeneration);
  t.after(async () => {
    try {
      await native.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const workspace: any = (await a.call("workspace.create", ref)).result;
  const paneId =
    workspace.result?.pane?.pane_id ??
    workspace.result?.workspace?.active_pane_id;
  const panes: any = (await a.call("pane.list", ref)).result;
  const nativePane = paneId ?? panes.result?.panes?.[0]?.pane_id;
  assert.ok(nativePane, JSON.stringify(panes));
  await a.call("pane.run", {
    ...ref,
    paneId: nativePane,
    command: "printf 'AGENVO_NATIVE_HERDR_OK\\n'",
  });
  const b = new HerdrAdapter(cfg);
  await b.init();
  assert.equal(await b.generation("test"), ref.backendGeneration);
  let output = "";
  for (let i = 0; i < 20 && !output.includes("AGENVO_NATIVE_HERDR_OK"); i++) {
    output = JSON.stringify(
      await b.call("pane.read", { ...ref, paneId: nativePane }),
    );
    if (!output.includes("AGENVO_NATIVE_HERDR_OK"))
      await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /AGENVO_NATIVE_HERDR_OK/);
  // Native discovery and diagnostics work for panes created outside agent.start.
  assert.equal((await b.call("agent.list", ref)).execution, "accepted");
  assert.equal(
    (await b.call("pane.get", { ...ref, paneId: nativePane })).execution,
    "accepted",
  );
  assert.equal(
    (await b.call("pane.process-info", { ...ref, paneId: nativePane }))
      .execution,
    "accepted",
  );
  await assert.rejects(
    b.call("pane.send-keys", { ...ref, paneId: nativePane, keys: [] }),
    { code: "invalid_params" },
  );
  await assert.rejects(
    b.call("agent.send-keys", { ...ref, name: "missing-agent", keys: ["esc"] }),
    { code: "native_error" },
  );
  // All logical keys must be validated before any input is delivered.
  await assert.rejects(
    b.call("pane.send-keys", {
      ...ref,
      paneId: nativePane,
      keys: ["x", "not-a-native-key"],
    }),
    { code: "native_error" },
  );
  await b.call("pane.run", { ...ref, paneId: nativePane, command: "sleep 60" });
  let running = false;
  for (let i = 0; i < 40; i++) {
    const info = await b.call("pane.process-info", {
      ...ref,
      paneId: nativePane,
    });
    if (JSON.stringify(info).includes("sleep")) {
      running = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(running, "sleep must start before testing interruption");
  await b.call("pane.send-keys", {
    ...ref,
    paneId: nativePane,
    keys: ["ctrl+c"],
  });
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    const info = await b.call("pane.process-info", {
      ...ref,
      paneId: nativePane,
    });
    if (!JSON.stringify(info).includes("sleep")) {
      stopped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    stopped,
    "interruption must be observable, not inferred from delivery",
  );
  await b.call("pane.send-text", {
    ...ref,
    paneId: nativePane,
    text: "printf 'AGENVO_INPUT_%s\\n' 'RECOVERED'",
  });
  await b.call("pane.send-keys", {
    ...ref,
    paneId: nativePane,
    keys: ["enter"],
  });
  let recovered = false;
  for (let i = 0; i < 30; i++) {
    const read = await b.call("pane.read", { ...ref, paneId: nativePane });
    if (JSON.stringify(read).includes("AGENVO_INPUT_RECOVERED")) {
      recovered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(recovered, "same pane must accept new work after interruption");
  // Start only the interactive UI: no prompt/model turn or approval is submitted.
  await b.call("agent.start", {
    ...ref,
    name: "inspect",
    paneId: nativePane,
    kind: "codex",
    timeoutMs: 4000,
    args: ["--no-alt-screen"],
  });
  let discovered = false;
  for (let i = 0; i < 70; i++) {
    const agents = await b.call("agent.list", ref);
    if (JSON.stringify(agents).includes('"inspect"')) {
      try {
        await b.call("agent.explain", { ...ref, name: nativePane });
        discovered = true;
        break;
      } catch (error: any) {
        if (error.native?.code !== "agent_explain_unavailable") throw error;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(discovered, "native agent must be discoverable");
  assert.equal(
    (await b.call("agent.explain", { ...ref, name: nativePane })).execution,
    "accepted",
  );
  assert.equal(
    (
      await b.call("agent.send-keys", {
        ...ref,
        name: nativePane,
        keys: ["esc"],
      })
    ).execution,
    "accepted",
  );
  assert.equal(
    (await b.call("agent.read", { ...ref, name: nativePane })).execution,
    "accepted",
  );
  await native.stop();
  await assert.rejects(a.call("pane.read", { ...ref, paneId: nativePane }), {
    code: "runtime_unavailable",
  });
  await native.start();
  assert.notEqual(await a.generation("test"), ref.backendGeneration);
  await assert.rejects(a.call("pane.read", { ...ref, paneId: nativePane }), {
    code: "stale_reference",
  });
});

test("Codex native initialization and policy rejection at the adapter entry", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "agenvo-codex-")));
  const cfg = instanceConfigSchema.parse({
    kind: "codex",
    id: "coding",
    label: "Test",
    binary: await executable("codex"),
    cwd: home,
    home,
    mode: "managed-stdio",
    policy: {},
  });
  if (cfg.kind !== "codex") throw new Error();
  const adapter = new CodexAdapter(cfg);
  t.after(async () => {
    await adapter.close();
    await rm(home, { recursive: true, force: true });
  });
  await adapter.init();
  assert.equal(adapter.available, true);
  await assert.rejects(
    adapter.call("thread/start", { sandbox: "danger-full-access" }),
    { code: "policy_denied" },
  );
  await assert.rejects(
    adapter.call("thread/start", { permissions: "unrestricted" }),
    { code: "invalid_params" },
  );
  await assert.rejects(
    adapter.call("thread/start", {
      config: { "mcp_servers.evil.command": "sh" },
    }),
    { code: "policy_denied" },
  );
  assert.equal((await adapter.call("requests.list", {})).execution, "accepted");
  await assert.rejects(
    adapter.call("requests.respond", { interactionId: "old", result: {} }),
    { code: "interaction_expired" },
  );
  assert.equal(
    (await adapter.call("thread/list", { limit: 1 })).execution,
    "accepted",
  );
});
