import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../apps/server/src/store.js";

test("the owner calls runtimes through the administrator API, without a grant", async (t) => {
  const { Relay } = await import("@agenvo/relay/core");
  const { admin } = await import("@agenvo/relay/admin");
  const dir = await mkdtemp(join(tmpdir(), "agenvo-admin-call-"));
  const store = new SqliteStore(join(dir, "state.sqlite"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const relay = new Relay({
    origin: "https://relay.test",
    store,
    sockets: () => [],
    accept: () => {},
    scheduleCleanup: async () => {},
  });
  let authorized = 0;
  const call = (body: unknown, method = "POST") =>
    admin(
      new Request("https://relay.test/api/admin/call", {
        method,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      }),
      relay,
      async () => {
        authorized++;
      },
    );
  const unknown = await call({
    deviceId: "device-1",
    instanceId: "paseo",
    method: "paseo.agents.get",
    params: { agentId: "a" },
  });
  assert.equal(unknown?.status, 200);
  assert.equal(authorized, 1);
  const outcome = (await unknown!.json()) as {
    execution: string;
    error: { code: string };
  };
  // The owner is not an OAuth grant, and still only reaches approved
  // instances of known devices.
  assert.equal(outcome.execution, "not_started");
  assert.equal(outcome.error.code, "permission_denied");
  assert.equal((await call({}, "GET"))?.status, 405);
  await assert.rejects(call({ deviceId: "device-1" }));
});
