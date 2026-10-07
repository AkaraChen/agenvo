import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test(
  "an unmanaged Codex in Herdr advertises sending and reaches an isolated model",
  { timeout: 40000 },
  async (t) => {
    const root = await realpath(await mkdtemp("/tmp/agenvo-external-"));
    const model = await modelServer();
    const exec = promisify(execFile);
    const binary = (
      await exec("/bin/sh", ["-c", "command -v herdr"])
    ).stdout.trim();
    const codex = (
      await exec("/bin/sh", ["-c", "command -v codex"])
    ).stdout.trim();
    const adapter = new HerdrAdapter({
      kind: "herdr",
      id: "test",
      label: "Test",
      binary,
      cwd: root,
      configRoot: join(root, "herdr"),
    });
    const native = herdrFixture(adapter.config, "test");
    t.after(async () => {
      await native.stop();
      await model.close();
      await rm(root, { recursive: true, force: true });
    });
    await native.start();
    await adapter.init();
    const call = async (method: string, params = {}) =>
      (await adapter.call(method, params)).result as any;
    const service = (await call("management.services.list")).items.find(
      (s: any) => s.serviceId === "test",
    );
    const ref = {
      session: "test",
      backendGeneration: service.native.backendGeneration,
    };
    const paneId = (await call("workspace.create", ref)).result.root_pane
      .pane_id;
    const args = [
      codex,
      "--no-alt-screen",
      "--no-daemon",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "fixture",
      "-c",
      'model_provider="fixture"',
      ...Object.entries(model.config).flatMap(([key, value]) => [
        "-c",
        `${key}=${JSON.stringify(value)}`,
      ]),
    ];
    // A native terminal launch has no managed launch record or interactive_ready.
    await call("pane.run", {
      ...ref,
      paneId,
      command: args.map(quote).join(" "),
    });
    const list = await until(
      () => call("management.threads.list", { serviceRef: service.serviceRef }),
      (r) =>
        r.items.some(
          (a: any) => a.threadId === paneId && a.activity === "idle",
        ),
      20000,
    );
    const thread = list.items.find((a: any) => a.threadId === paneId);
    assert.notEqual(thread.native.interactive_ready, true);
    assert.equal(thread.operations.send.available, true);
    const sent = await adapter.call("management.threads.send", {
      threadRef: thread.threadRef,
      text: "Reply with the fixture result.",
    });
    assert.equal(sent.execution, "accepted");
    await until(
      () => model.requests.length,
      (n) => n > 0,
    );
    await until(
      () => call("pane.read", { ...ref, paneId, source: "visible" }),
      (r) => JSON.stringify(r).includes("ISOLATED_MODEL_RESULT"),
    );
  },
);
