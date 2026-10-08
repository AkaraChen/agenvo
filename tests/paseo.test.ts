import test from "node:test";
import assert from "node:assert/strict";
import { PaseoAdapter } from "../apps/paseo/src/paseo.js";
import { paseoFixture } from "./fixtures/paseo-daemon.js";
import { until } from "./support/environment.js";

test("Paseo reconnect does not replay uncertain modern creation and retains its correlation key", async (t) => {
  const fixture = await paseoFixture(true);
  t.after(() => fixture.close());
  const adapter = new PaseoAdapter({
    id: "paseo",
    label: "Paseo",
    kind: "paseo",
    endpoint: fixture.endpoint,
    serverId: fixture.serverId,
  });
  t.after(() => adapter.close());
  await adapter.init();
  fixture.dropNextCreate();
  const result = await adapter.call("paseo.agents.create", {
    provider: "codex",
    cwd: "/fixture",
  });
  assert.equal(result.execution, "unknown");
  const native = result.error?.native as { idempotencyKey: string };
  assert.ok(native.idempotencyKey);
  await until(() => adapter.available, Boolean);
  const creates = fixture.requests.filter(
    (r) => r.type === "agent.create.request",
  );
  assert.equal(creates.length, 1);
  assert.equal(creates[0].idempotencyKey, native.idempotencyKey);
  assert.equal(
    fixture.agents.size,
    1,
    "the failed response does not imply creation failed",
  );
});

test("Paseo rejects a different daemon identity before subscribing", async (t) => {
  const fixture = await paseoFixture();
  t.after(() => fixture.close());
  const adapter = new PaseoAdapter({
    id: "paseo",
    label: "Paseo",
    kind: "paseo",
    endpoint: fixture.endpoint,
    serverId: "previous-daemon",
  });
  t.after(() => adapter.close());
  await assert.rejects(adapter.init(), { code: "daemon_identity_changed" });
  assert.equal(adapter.available, false);
  assert.equal(fixture.requests.length, 0);
});
