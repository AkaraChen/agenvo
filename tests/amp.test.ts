import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import WebSocket from "ws";
import { AmpAdapter } from "../apps/amp/src/amp.js";
import { ampHost } from "./support/amp-host.js";
import { until } from "./support/environment.js";

test(
  "Amp bridge manages external and new threads, preserves events, and never replays uncertain input",
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "agenvo-amp-"));
    const config = {
      id: "amp",
      kind: "amp" as const,
      label: "Fixture",
      cwd: root,
      binary: resolve("tests/fixtures/amp-cli.mjs"),
      bridgeDir: join(root, "bridge"),
      pluginPath: join(root, "plugin.ts"),
    };
    const adapter = new AmpAdapter(config);
    await adapter.init();
    const host = ampHost(config);
    t.after(async () => {
      host.releaseSend();
      host.stop();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    });
    await until(() => adapter.available, Boolean);
    assert.deepEqual(host.approve(), { action: "allow" });
    const call = async (method: string, params = {}) => {
      const result = await adapter.call("management." + method, params);
      assert.equal(result.execution, "accepted", JSON.stringify(result));
      assert.equal(result.error, undefined);
      return result.result as any;
    };
    const service = (await call("services.list")).items[0];
    const external = (
      await call("threads.list", { serviceRef: service.serviceRef })
    ).items[0];
    assert.equal(external.threadId, "T-external");
    assert.equal(external.activity, "unknown");
    const first = await call("threads.observe", {
      threadRef: external.threadRef,
    });
    assert.equal(first.thread.activity, "idle");
    assert.equal(host.threads.get("T-external").listeners, 1);
    await call("threads.observe", { threadRef: external.threadRef });
    assert.equal(host.threads.get("T-external").listeners, 1);
    await call("threads.send", {
      threadRef: external.threadRef,
      text: "work",
      providerOptions: { steer: true },
    });
    host.threads.get("T-external").finish("error");
    const observed = await until(
      () =>
        call("threads.observe", {
          threadRef: external.threadRef,
          cursor: first.nextCursor,
        }),
      (r) => r.items.some((e: any) => e.data.native.status === "error"),
    );
    assert.equal(observed.thread.activity, "unknown");
    assert.equal(observed.thread.native.state, "error");
    const history = await call("threads.read", {
      threadRef: external.threadRef,
      limit: 1,
    });
    assert.match(JSON.stringify(history), /EXTERNAL_THREAD_HISTORY/);
    const next = await call("threads.read", {
      threadRef: external.threadRef,
      cursor: history.nextCursor,
    });
    assert.equal(next.items[0].steer, true);
    const created = (
      await call("threads.create", { serviceRef: service.serviceRef })
    ).thread;
    assert.equal(host.sends, 1, "creation must not send a prompt");
    await assert.rejects(
      call("threads.read", {
        threadRef: created.threadRef,
        cursor: history.nextCursor,
      }),
      /invalid_cursor/,
    );
    await assert.rejects(
      call("threads.observe", {
        threadRef: created.threadRef,
        cursor: first.nextCursor,
      }),
      /invalid_cursor/,
    );
    await call("threads.send", {
      threadRef: created.threadRef,
      text: "continue",
    });
    await call("threads.interrupt", { threadRef: created.threadRef });
    assert.equal(host.cancelCount, 1);
    assert.equal(
      (await call("threads.get", { threadRef: created.threadRef })).thread
        .activity,
      "idle",
    );

    host.holdSend();
    const sending = adapter.call("management.threads.send", {
      threadRef: external.threadRef,
      text: "accepted before disconnection",
    });
    await until(
      () => host.sends,
      (n) => n === 3,
    );
    host.stop();
    assert.equal((await sending).execution, "unknown");
    await until(
      () => adapter.available,
      (value) => !value,
    );
    assert.equal(host.cancelCount, 1, "disconnect must not cancel native work");
    host.releaseSend();
    const stop = host.reconnect();
    t.after(stop);
    await until(() => adapter.available, Boolean);
    await assert.rejects(
      call("threads.get", { threadRef: external.threadRef }),
      /Rediscover/,
    );
    const current = (await call("services.list")).items[0];
    const rediscovered = (
      await call("threads.list", { serviceRef: current.serviceRef })
    ).items[0];
    const gap = await call("threads.observe", {
      threadRef: rediscovered.threadRef,
      cursor: observed.nextCursor,
    });
    assert.equal(gap.gap, true);
    assert.equal(gap.thread.activity, "working");
    assert.equal(host.sends, 3, "reconnection must not replay writes");
  },
);

test("Amp bridge rejects unauthenticated local clients and duplicate connector ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenvo-amp-auth-"));
  const config = {
    id: "amp",
    kind: "amp" as const,
    label: "Fixture",
    cwd: root,
    binary: process.execPath,
    bridgeDir: root,
    pluginPath: join(root, "plugin.ts"),
  };
  const adapter = new AmpAdapter(config);
  await adapter.init();
  t.after(async () => {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(new AmpAdapter(config).init(), /lock/);
  const endpoint = JSON.parse(
    await readFile(join(root, "connection.json"), "utf8"),
  );
  const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}`);
  await once(ws, "open");
  const closed = once(ws, "close");
  ws.send(
    JSON.stringify({
      type: "hello",
      token: "0".repeat(64),
      cwd: root,
      userId: null,
    }),
  );
  assert.equal((await closed)[0], 1008);
  assert.equal(adapter.available, false);
});
