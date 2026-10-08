import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { until } from "../support/environment.js";
import { herdrFixture } from "../fixtures/herdr-runtime.js";

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

test(
  "MCP consumer recovers a timed-out Herdr launch and observes a busy agent without relaunching",
  { timeout: 60000 },
  async (t) => {
    const lab = await eventsLab(t);
    const model = await modelServer();
    lab.cleanup(() => model.close());
    model.hold();
    const herdr = await executable("herdr", {});
    const codex = await executable("codex", {});
    const bin = join(lab.root, "bin"),
      gate = join(lab.root, "release-startup"),
      launches = join(lab.root, "launches");
    await mkdir(bin);
    // Hold the actual Codex launch until Herdr's startup deadline has expired.
    // The gate, not a guessed machine-speed-dependent sleep, controls readiness.
    await writeFile(
      join(bin, process.platform === "win32" ? "codex.cmd" : "codex"),
      process.platform === "win32"
        ? `@echo off
echo started>>"${launches}"
:wait
if exist "${gate}" goto run
powershell -NoProfile -Command "Start-Sleep -Milliseconds 50"
goto wait
:run
call "${codex}" %*
`
        : `#!/bin/sh\nprintf 'started\\n' >> ${quote(launches)}\nwhile [ ! -f ${quote(gate)} ]; do sleep 0.05; done\nexec ${quote(codex)} "$@"\n`,
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = bin + delimiter + originalPath;
    t.after(() => {
      process.env.PATH = originalPath;
    });
    const config = {
      kind: "herdr" as const,
      id: "runtime",
      label: "Test runtime",
      binary: herdr,
      cwd: lab.root,
      configRoot: join(lab.root, "herdr"),
    };
    const native = herdrFixture(config, "test");
    await native.start();
    lab.cleanup(() => native.stop());
    const deviceId = await lab.connect([config]);
    const target = { deviceId, instanceId: "runtime" };
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await lab.rpc("tools/call", {
        name,
        arguments: { ...target, ...args },
      });
      const outcome = JSON.parse(response.content[0].text);
      assert.match(outcome.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(response.isError, Boolean(outcome.error));
      return outcome;
    };
    const call = (method: string, params = {}) =>
      invoke("runtime_call", { method, params });
    const tools = (await lab.rpc("tools/list")).tools;
    for (const name of ["instances_list", "instance_describe"])
      assert.equal(
        tools.find((tool: any) => tool.name === name).annotations.readOnlyHint,
        true,
      );
    assert.notEqual(
      tools.find((tool: any) => tool.name === "runtime_call").annotations
        ?.readOnlyHint,
      true,
    );
    const service = (await call("management.services.list")).result.items.find(
      (s: any) => s.serviceId === "test",
    );
    const ref = {
      session: "test",
      backendGeneration: service.native.backendGeneration,
    };
    const paneId = (await call("workspace.create", ref)).result.result.root_pane
      .pane_id;
    const created = await call("management.threads.create", {
      serviceRef: service.serviceRef,
      providerOptions: {
        name: "delayed",
        paneId,
        kind: "codex",
        timeoutMs: 4000,
        args: [
          "--no-daemon",
          "--model",
          "fixture",
          "-c",
          'model_provider="fixture"',
          ...Object.entries(model.config).flatMap(([key, value]) => [
            "-c",
            `${key}=${JSON.stringify(value)}`,
          ]),
        ],
      },
    });
    assert.equal(created.execution, "starting");
    const query = created.result.query;
    const settled = await until(
      () => call(query.method, query.params),
      (r) => r.result?.startup?.state === "settled",
    );
    assert.equal(settled.result.startup.outcome.error.native.code, "timeout");
    assert.equal(settled.result.expectedPaneId, paneId);
    assert.equal(settled.result.serviceRef, service.serviceRef);
    await writeFile(gate, "release");
    const listed = await until(
      () => call("management.threads.list", { serviceRef: service.serviceRef }),
      (r) =>
        r.result.items.some(
          (a: any) => a.threadId === paneId && a.activity === "idle",
        ),
      20000,
    );
    const thread = listed.result.items.find((a: any) => a.threadId === paneId);
    assert.notEqual(thread.native.interactive_ready, true);
    assert.equal(thread.operations.send.available, true);
    assert.equal(
      (
        await call("management.threads.send", {
          threadRef: thread.threadRef,
          text: "Return the isolated fixture result.",
        })
      ).execution,
      "accepted",
    );
    await until(
      () => model.requests.length,
      (n) => n > 0,
    );
    await until(
      () => call("management.threads.get", { threadRef: thread.threadRef }),
      (r) => r.result.thread.activity === "working",
    );
    const history = await call("agent.read", {
      ...ref,
      name: paneId,
      lines: 100,
    });
    assert.equal(history.error.native.code, "agent_not_idle");
    const observed = await call("management.threads.observe", {
      threadRef: thread.threadRef,
      lines: 100,
    });
    assert.equal(observed.execution, "accepted");
    const terminal = observed.result.items.find(
      (item: any) => item.type === "terminal.observed",
    ).data;
    assert.equal(terminal.coverage.source, "visible");
    assert.equal(terminal.coverage.fallbackReason, "agent_not_idle");
    for (const args of [{}, { cursor: "20" }])
      assert.equal(
        (await invoke("instance_describe", args)).execution,
        "accepted",
      );
    model.release();
    await until(
      () =>
        call("pane.read", { ...ref, paneId, source: "visible", lines: 100 }),
      (r) => JSON.stringify(r.result).includes("ISOLATED_MODEL_RESULT"),
    );
    assert.equal((await readFile(launches, "utf8")).trim(), "started");
  },
);
