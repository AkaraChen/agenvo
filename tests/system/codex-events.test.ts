import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { eventsLab } from "../support/events-lab.js";
import { modelServer } from "../support/model-server.js";
import { until, isolatedEnvironment } from "../support/environment.js";

for (const mode of ["managed-stdio", "attach-unix"] as const)
  test(
    `native Codex ${mode} executes a local mock-model turn, notifies completion, reads output and accepts follow-up interruption`,
    { timeout: 45000 },
    async (t) => {
      const lab = await eventsLab(t);
      const model = await modelServer();
      lab.cleanup(() => model.close());
      const home = join(lab.root, "codex");
      await mkdir(home);
      const binary = (
        await promisify(execFile)("/bin/sh", ["-c", "command -v codex"])
      ).stdout.trim();
      const socketPath = join(home, "native.sock");
      if (mode === "attach-unix") {
        const child = spawn(
          binary,
          ["app-server", "--listen", "unix://" + socketPath],
          {
            env: { ...isolatedEnvironment(lab.root), CODEX_HOME: home },
            stdio: "ignore",
          },
        );
        lab.cleanup(async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          const ended = once(child, "exit");
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
          await ended;
          clearTimeout(timer);
        });
        await until(
          () =>
            stat(socketPath).then(
              () => true,
              () => false,
            ),
          (present) => present,
        );
      }
      const device = await lab.connect([
        {
          kind: "codex",
          id: "codex",
          label: "Isolated native Codex",
          binary,
          cwd: lab.root,
          home,
          mode,
          ...(mode === "attach-unix" ? { socketPath } : {}),
        },
      ]);
      const call = (method: string, params = {}) =>
        lab.call(device, "codex", method, params);
      await lab.rpc(
        "events/subscribe",
        lab.subscription(device, "codex", { nativeTypes: ["turn/completed"] }),
      );
      const services = await call("management.services.list");
      const created = await call("management.threads.create", {
        serviceRef: services.items[0].serviceRef,
        providerOptions: {
          model: "fixture",
          modelProvider: "fixture",
          historyMode: "paginated",
          config: model.config,
        },
      });
      const threadRef = created.thread.threadRef;
      await call("management.threads.send", {
        threadRef,
        text: "Reply with the fixture result.",
      });
      await until(
        () => lab.received,
        (events) => events.some((e) => e.data.nativeType === "turn/completed"),
      );
      assert.ok(
        model.requests.length > 0,
        "the real app-server must reach the isolated model server",
      );
      const completion = lab.received.find(
        (e) => e.data.nativeType === "turn/completed",
      );
      assert.equal(completion.data.native.turn.status, "completed");
      const observed = await call("management.threads.observe", {
        threadRef,
        limit: 50,
      });
      assert.match(JSON.stringify(observed), /ISOLATED_MODEL_RESULT/);
      model.hold();
      const count = model.requests.length;
      await call("management.threads.send", {
        threadRef,
        text: "Wait for follow-up.",
      });
      await until(
        () => model.requests.length,
        (n) => n > count,
      );
      await call("management.threads.interrupt", { threadRef });
      await until(
        () => lab.received,
        (events) =>
          events.some((e) => e.data.native.turn?.status === "interrupted"),
      );
    },
  );
