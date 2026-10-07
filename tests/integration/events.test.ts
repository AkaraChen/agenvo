import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

test(
  "agent authorizes, pairs, subscribes, starts work, observes interruption, reconnects and unsubscribes",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const device = await lab.connect([
      {
        id: "codex",
        label: "Isolated Codex protocol fixture",
        kind: "codex",
        binary: resolve("tests/fixtures/codex-backend.mjs"),
        mode: "managed-stdio",
        cwd: lab.root,
        home: lab.root,
      },
    ]);
    const discover = await lab.rpc("server/discover");
    assert.deepEqual(discover.capabilities.events, {});
    assert.equal(
      (await lab.rpc("events/list")).events[0].name,
      "runtime.changed",
    );
    const subscription = lab.subscription(device, "codex", {
      nativeTypes: ["turn/completed"],
    });
    const first = await lab.rpc("events/subscribe", subscription);
    assert.equal(
      (await lab.rpc("events/subscribe", subscription)).id,
      first.id,
    );
    const services = await lab.call(
      device,
      "codex",
      "management.services.list",
    );
    const created = await lab.call(
      device,
      "codex",
      "management.threads.create",
      { serviceRef: services.items[0].serviceRef },
    );
    const threadRef = created.thread.threadRef;
    await lab.call(device, "codex", "management.threads.send", {
      threadRef,
      text: "Work on the fixture",
    });
    await lab.call(device, "codex", "management.threads.interrupt", {
      threadRef,
    });
    await until(
      () => lab.received,
      (events) => events.some((e) => e.data.nativeType === "turn/completed"),
    );
    const observed = await lab.call(
      device,
      "codex",
      "management.threads.observe",
      { threadRef },
    );
    assert.ok(observed.items.some((e: any) => e.type === "turn/completed"));
    assert.equal(
      lab.received.some((e) => e.data.nativeType === "turn/started"),
      false,
    );
    await lab.restart();
    await until(
      () => lab.received,
      (events) =>
        events.some((e) => e.data.nativeType === "agenvo.resync_required"),
    );
    const baseline = lab.received.filter(
      (e) => e.data.nativeType === "turn/completed",
    ).length;
    await lab.call(device, "codex", "management.threads.send", {
      threadRef,
      text: "Continue after relay restart",
    });
    await lab.call(device, "codex", "management.threads.interrupt", {
      threadRef,
    });
    await until(
      () =>
        lab.received.filter((e) => e.data.nativeType === "turn/completed")
          .length,
      (n) => n > baseline,
    );
    await lab.rpc("events/unsubscribe", {
      name: subscription.name,
      arguments: subscription.arguments,
      delivery: { mode: "webhook", url: subscription.delivery.url },
    });
    const count = lab.received.length;
    await lab.call(device, "codex", "management.threads.send", {
      threadRef,
      text: "Unsubscribed work",
    });
    await lab.call(device, "codex", "management.threads.interrupt", {
      threadRef,
    });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(lab.received.length, count);
  },
);
