import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CodexAdapter } from "../src/connector/adapters/codex.ts";
import { instanceConfigSchema } from "../src/connector/config.ts";
test("public adapter transport mediates native input and all allowed approval types", async (t) => {
  const root = await realpath(await mkdtemp("/tmp/agenvo-approval-"));
  const config = instanceConfigSchema.parse({
    kind: "codex",
    id: "test",
    label: "test",
    binary: resolve("tests/fixtures/codex-backend.mjs"),
    cwd: root,
    home: root,
    mode: "managed-stdio",
    policy: { sandbox: "workspace-write" },
  });
  if (config.kind !== "codex") throw new Error();
  const a = new CodexAdapter(config);
  t.after(async () => {
    await a.close();
    await rm(root, { recursive: true, force: true });
  });
  await a.init();
  await a.call("thread/start", {});
  const list: any = (await a.call("requests.list", {})).result;
  assert.equal(list.items.length, 5);
  const byMethod = (method: string) =>
    list.items.find((i: any) => i.method === method);
  const respond = (i: any, result: Record<string, unknown>) =>
    a.call("requests.respond", { interactionId: i.interactionId, result });
  const file = byMethod("item/fileChange/requestApproval");
  await assert.rejects(respond(file, { decision: "accept" }), {
    code: "local_approval_required",
  });
  await a.call("thread/items/list", { threadId: "t", turnId: "wrong" });
  await assert.rejects(respond(file, { decision: "accept" }), {
    code: "local_approval_required",
  });
  await a.call("thread/items/list", { threadId: "t", turnId: "turn" });
  const changes: any = (
    await a.call("requests.read", { interactionId: file.interactionId })
  ).result;
  assert.equal(changes.item.changes[0].diff, "+hello");
  await a.call("thread/list", {});
  await assert.rejects(respond(file, { decision: "accept" }), {
    code: "local_approval_required",
  });
  await a.call("requests.read", { interactionId: file.interactionId });
  await respond(file, { decision: "accept" });
  const command = byMethod("item/commandExecution/requestApproval");
  await assert.rejects(respond(command, { decision: "acceptForSession" }), {
    code: "policy_denied",
  });
  await respond(command, { decision: "accept" });
  await respond(byMethod("item/permissions/requestApproval"), {
    permissions: { fileSystem: { write: [root] } },
    scope: "turn",
    strictAutoReview: true,
  });
  const input = byMethod("item/tool/requestUserInput");
  await respond(input, { answers: { label: { answers: ["Alpha"] } } });
  await assert.rejects(
    respond(input, { answers: { label: { answers: ["Beta"] } } }),
    { code: "interaction_expired" },
  );
  await respond(byMethod("item/tool/call"), {
    success: true,
    contentItems: [{ type: "inputText", text: "ok" }],
  });
  const history: any = (await a.call("thread/read", { threadId: "t" })).result;
  assert.equal(history.responses.length, 6);
  assert.equal(
    history.responses.find((r: any) => r.id === "native-5").error.code,
    -32601,
  );
  await a.call("thread/start", {});
  assert.equal(
    ((await a.call("requests.list", {})).result as any).items.length,
    5,
  );
  const pendingFiles: any = (await a.call("requests.list", {})).result;
  const oversized = pendingFiles.items.find(
    (r: any) => r.method === "item/fileChange/requestApproval",
  );
  await a.call("thread/list", { searchTerm: "oversize" });
  await assert.rejects(
    a.call("requests.read", { interactionId: oversized.interactionId }),
    { code: "local_approval_required" },
  );
  await respond(oversized, { decision: "decline" });
  await a.call("turn/interrupt", { threadId: "t", turnId: "turn" });
  assert.equal(
    ((await a.call("requests.list", {})).result as any).items.length,
    0,
  );
});
