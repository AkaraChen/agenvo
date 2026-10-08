import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { ampHost } from "../support/amp-host.js";
import { until } from "../support/environment.js";

test(
  "Amp plugin reaches management and webhook delivery through the real paired Connector and MCP endpoint",
  { timeout: 25000 },
  async (t) => {
    const lab = await eventsLab(t);
    const config = {
      id: "amp",
      kind: "amp" as const,
      label: "Isolated Amp",
      cwd: lab.root,
      binary: resolve("tests/fixtures/amp-cli.mjs"),
      bridgeDir: join(lab.root, "bridge"),
      pluginPath: join(lab.root, "plugin.ts"),
    };
    const host = ampHost(config);
    lab.cleanup(host.stop);
    const device = await lab.connect([config]);
    const call = (method: string, params = {}) =>
      lab.call(device, "amp", "management." + method, params);
    // The connector's WebSocket hello initially reports unavailable until the
    // independent plugin attaches; observe the actual published descriptor.
    await until(
      async () => {
        const r = await lab.rpc("tools/call", {
          name: "instances_list",
          arguments: {},
        });
        return JSON.parse(r.content[0].text);
      },
      (r) => JSON.stringify(r).includes('"available":true'),
    );
    const service = (await call("services.list")).items[0];
    const external = (
      await call("threads.list", { serviceRef: service.serviceRef })
    ).items[0];
    assert.equal(external.threadId, "T-external");
    const created = (
      await call("threads.create", { serviceRef: service.serviceRef })
    ).thread;
    await call("threads.observe", { threadRef: created.threadRef });
    await lab.rpc(
      "events/subscribe",
      lab.subscription(device, "amp", {
        threadId: created.threadId,
        nativeTypes: ["agent.end"],
      }),
    );
    await call("threads.send", {
      threadRef: created.threadRef,
      text: "Run the fixture task",
    });
    host.threads.get(created.threadId).finish();
    await until(
      () => lab.received,
      (events) =>
        events.some(
          (e) =>
            e.data.nativeType === "agent.end" &&
            e.data.native.status === "done",
        ),
    );
    const history = await call("threads.read", {
      threadRef: created.threadRef,
    });
    assert.match(JSON.stringify(history), /ISOLATED_AMP_RESULT/);
    await call("threads.send", {
      threadRef: created.threadRef,
      text: "Continue the fixture task",
    });
    await call("threads.interrupt", { threadRef: created.threadRef });
    await until(
      () => lab.received,
      (events) => events.some((e) => e.data.native.status === "cancelled"),
    );
    const observed = await call("threads.observe", {
      threadRef: created.threadRef,
    });
    assert.ok(
      observed.items.some((e: any) => e.data.native.status === "cancelled"),
    );
    assert.equal(host.cancelCount, 1);
  },
);
