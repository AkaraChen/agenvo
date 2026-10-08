import { binary as executable } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { herdrFixture } from "../fixtures/herdr-runtime.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

const quote = (s: string) =>
  "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
test(
  "external Herdr agent is discovered, prompts produce events, blocked input is readable and restart invalidates state",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const root = join(lab.root, "herdr");
    await mkdir(root);
    const binary = await executable("herdr", {});
    const config = {
      kind: "herdr" as const,
      id: "herdr",
      label: "Test Herdr",
      binary,
      cwd: lab.root,
      configRoot: root,
    };
    const native = herdrFixture(config, "test");
    await native.start();
    lab.cleanup(() => native.stop());
    const device = await lab.connect([config]);
    // Two separately installed backends on one host have independent connection identities.
    const codexDevice = await lab.connect([
      {
        kind: "codex",
        id: "herdr",
        label: "Codex on the same host",
        binary: resolve("tests/fixtures/codex-backend.mjs"),
        mode: "managed-stdio",
        cwd: lab.root,
        home: lab.root,
      },
    ]);
    assert.notEqual(device, codexDevice);
    const codexServices = await lab.call(
      codexDevice,
      "herdr",
      "management.services.list",
    );
    assert.ok(codexServices.items.length);

    const subscription = lab.subscription(device, "herdr", {
      serviceId: "test",
      nativeTypes: ["pane.agent_status_changed"],
    });
    await lab.rpc("events/subscribe", subscription);
    const call = (method: string, params = {}) =>
      lab.call(device, "herdr", method, params);
    const services = await call("management.services.list");
    const service = services.items.find(
      (s: any) => s.native.session === "test",
    );
    const ref = {
      session: "test",
      backendGeneration: service.native.backendGeneration,
    };
    const created = await call("workspace.create", ref),
      paneId = created.result.root_pane.pane_id;
    await call("pane.run", {
      ...ref,
      paneId,
      command: `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(resolve("tests/fixtures/herdr-agent.mjs"))}`,
    });
    const threads = await until(
      () => call("management.threads.list", { serviceRef: service.serviceRef }),
      (r) => r.items.some((a: any) => a.native.agent === "fixture"),
    );
    const threadRef = threads.items.find(
      (a: any) => a.native.agent === "fixture",
    ).threadRef;
    await until(
      () => lab.received,
      (events) =>
        events.some((e) => e.data.nativeType === "agenvo.resync_required"),
    );
    const baseline = lab.received.length;
    // A custom lifecycle reporter is observable but has no native named-agent prompt contract.
    // The consumer can use the advertised raw terminal input without a new abstraction.
    await call("pane.run", { ...ref, paneId, command: "ask for a label" });
    await until(
      () => lab.received.slice(baseline),
      (events) => events.some((e) => e.data.native.agent_status === "blocked"),
    );
    const output = await call("management.threads.read", { threadRef });
    assert.match(JSON.stringify(output), /Which label should I use/);
    await call("pane.send-text", { ...ref, paneId, text: "alpha" });
    await call("pane.send-keys", { ...ref, paneId, keys: ["enter"] });
    await until(
      () => call("management.threads.read", { threadRef }),
      (value) => JSON.stringify(value).includes("Fixture result: alpha"),
    );
    const before = lab.received.length;
    await native.stop();
    await native.start();
    await until(
      () => lab.received.slice(before),
      (events) =>
        events.some((e) => e.data.nativeType === "agenvo.resync_required"),
    );
    const current = await call("management.services.list");
    assert.ok(
      (await lab.call(codexDevice, "herdr", "management.services.list")).items
        .length,
    );
    await lab.admin("/api/admin/revoke", { kind: "device", id: codexDevice });
    assert.ok((await call("management.services.list")).items.length);

    assert.notEqual(
      current.items.find((s: any) => s.native.session === "test").native
        .backendGeneration,
      ref.backendGeneration,
    );
  },
);
