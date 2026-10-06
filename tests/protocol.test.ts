import test from "node:test";
import assert from "node:assert/strict";
import {
  bytes,
  page,
  LIMITS,
  canonical,
  readBody,
} from "../src/protocol/index.ts";
import {
  enforcePolicy,
  enforceApproval,
} from "../src/connector/adapters/codex-policy.ts";
import { instanceConfigSchema } from "../src/connector/config.ts";
import { bounded } from "../src/connector/adapters/adapter.ts";
const config = instanceConfigSchema.parse({
  id: "coding",
  label: "Coding",
  kind: "codex",
  binary: "/bin/codex",
  cwd: "/work",
  home: "/home/codex",
  mode: "managed-stdio",
  policy: {},
});
if (config.kind !== "codex") throw new Error();
test("UTF-8 limits and cursor preserve complete items", async () => {
  assert.equal(bytes("中"), 3);
  const list = Array.from({ length: 60 }, (_, id) => ({
    id,
    text: "中".repeat(500),
  }));
  const first = page(list);
  assert.ok(first.items.length < 50);
  assert.ok(bytes(first) < LIMITS.frame);
  assert.deepEqual(
    [...first.items, ...page(list, first.nextCursor).items],
    list,
  );
  await assert.rejects(
    readBody(
      new Request("https://example.com", {
        method: "POST",
        body: "中".repeat(100),
      }),
      100,
    ),
    /input_too_large/,
  );
  assert.equal(
    bounded({
      execution: "accepted",
      nativeIds: { threadId: "t1" },
      result: "中".repeat(30000),
    }).execution,
    "accepted",
  );
});
test("all mutable Codex entry points retain local permissions", () => {
  for (const method of ["thread/start", "thread/resume", "turn/start"]) {
    for (const params of [
      { approvalPolicy: "never" },
      { approvalsReviewer: "auto_review" },
      { cwd: "/etc" },
      { config: { mcp_servers: {} } },
      { modelProvider: "evil" },
    ])
      assert.throws(() => enforcePolicy(config, method, params), {
        code: "policy_denied",
      });
    const p = enforcePolicy(config, method, {});
    assert.equal(p.approvalsReviewer, "user");
    assert.equal(p.approvalPolicy, "untrusted");
  }
  assert.throws(
    () =>
      enforcePolicy(config, "turn/start", {
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
    { code: "policy_denied" },
  );
  assert.equal(canonical({ z: 1, a: 2 }), canonical({ a: 2, z: 1 }));
});
test("native input answers and persistent approval amendments are checked", () => {
  assert.throws(
    () =>
      enforceApproval(
        config,
        "item/commandExecution/requestApproval",
        {},
        { decision: "acceptForSession" },
      ),
    { code: "policy_denied" },
  );
  assert.throws(
    () =>
      enforceApproval(
        config,
        "item/commandExecution/requestApproval",
        {},
        {
          decision: {
            acceptWithExecpolicyAmendment: { execpolicyAmendment: ["sh"] },
          },
        },
      ),
    { code: "policy_denied" },
  );
  assert.throws(
    () =>
      enforceApproval(
        config,
        "item/tool/requestUserInput",
        { questions: [{ id: "q" }] },
        { answers: { wrong: { answers: ["yes"] } } },
      ),
    { code: "policy_denied" },
  );
  enforceApproval(
    config,
    "item/tool/requestUserInput",
    { questions: [{ id: "q" }] },
    { answers: { q: { answers: ["yes"] } } },
  );
});

test("approval decisions cannot bypass network, filesystem or unsandboxed ceilings", () => {
  const write = {
    ...config,
    policy: { ...config.policy, sandbox: "workspace-write" as const },
  };
  for (const params of [
    {},
    { cwd: "/work", networkApprovalContext: { host: "example.com" } },
    {
      cwd: "/work",
      additionalPermissions: { fileSystem: { write: ["/etc"] } },
    },
  ])
    assert.throws(
      () =>
        enforceApproval(
          write,
          "item/commandExecution/requestApproval",
          params,
          { decision: "accept" },
        ),
      { code: "policy_denied" },
    );
  enforceApproval(
    write,
    "item/commandExecution/requestApproval",
    {
      cwd: "/work",
      additionalPermissions: { fileSystem: { write: ["/work"] } },
    },
    { decision: "accept" },
  );
  assert.throws(
    () =>
      enforceApproval(
        write,
        "item/fileChange/requestApproval",
        { grantRoot: "/etc" },
        { decision: "accept" },
      ),
    { code: "policy_denied" },
  );
  for (const permissions of [
    { network: { enabled: true } },
    { fileSystem: { write: ["/etc"] } },
  ])
    assert.throws(
      () =>
        enforceApproval(
          write,
          "item/permissions/requestApproval",
          { permissions },
          { permissions, scope: "turn", strictAutoReview: true },
        ),
      { code: "policy_denied" },
    );
});
