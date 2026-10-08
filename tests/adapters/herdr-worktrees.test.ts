import { socketTempDir } from "../support/environment.js";
import { binary } from "@agenvo/connector/cli/binary";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HerdrAdapter } from "../../apps/herdr/src/herdr.js";
import { instanceConfigSchema } from "../support/config.js";
import { herdrFixture } from "../fixtures/herdr-runtime.ts";

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)(
    "git",
    [
      "-c",
      "user.name=Agenvo",
      "-c",
      "user.email=agenvo@example.invalid",
      ...args,
    ],
    { cwd },
  ).then((r) => r.stdout);

test("Herdr worktrees and tabs map to native commands", async (t) => {
  const base = await realpath(
    await mkdtemp(join(socketTempDir(), "agenvo-w-")),
  );
  const root = join(base, "herdr");
  const repo = join(base, "repo");
  await mkdir(root);
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const cfg = instanceConfigSchema.parse({
    kind: "herdr",
    id: "work",
    label: "Test",
    binary: await binary("herdr", {}),
    cwd: repo,
    configRoot: root,
  });
  if (cfg.kind !== "herdr") throw new Error();
  const a = new HerdrAdapter(cfg);
  await a.init();
  const native = herdrFixture(cfg, "test");
  await native.start();
  t.after(async () => {
    try {
      await native.stop();
    } finally {
      await rm(base, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
  const ref = {
    session: "test",
    backendGeneration: await a.generation("test"),
  };
  const call = async (method: string, params: object = {}) =>
    ((await a.call(method, { ...ref, ...params })).result as any).result;
  const worktrees = async () =>
    (await call("worktree.list", { cwd: repo })).worktrees as any[];

  // A label that looks like an option stays a label.
  const created = await call("worktree.create", {
    cwd: repo,
    branch: "feature",
    label: "--focus",
  });
  const workspaceId = created.workspace.workspace_id;
  assert.equal(created.workspace.label, "--focus");
  const linked = (await worktrees()).find((w) => w.branch === "feature");
  assert.equal(linked.is_linked_worktree, true);
  assert.equal(linked.open_workspace_id, workspaceId);

  // Worktrees created outside Herdr are listed and can be opened.
  const external = join(base, "external");
  await git(repo, "worktree", "add", "-q", "-b", "external", external);
  assert.equal(
    (await worktrees()).find((w) => w.branch === "external")
      .open_workspace_id ?? null,
    null,
  );
  const opened = await call("worktree.open", { cwd: repo, path: external });
  assert.equal(
    (await worktrees()).find((w) => w.branch === "external").open_workspace_id,
    opened.workspace.workspace_id,
  );

  // A tab gives an agent its own shell beside existing panes.
  const tab = await call("tab.create", {
    workspaceId,
    label: "agent",
    env: { AGENVO_TAB_VALUE: "tab-env-ok" },
  });
  await call("pane.run", {
    paneId: tab.root_pane.pane_id,
    command: 'printf "%s\\n" "$AGENVO_TAB_VALUE"',
  });
  let output = "";
  for (let i = 0; i < 50 && !output.includes("tab-env-ok"); i++) {
    output = JSON.stringify(
      await a.call("pane.read", { ...ref, paneId: tab.root_pane.pane_id }),
    );
    if (!output.includes("tab-env-ok"))
      await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(output, /tab-env-ok/);
  await call("tab.close", { tabId: tab.tab.tab_id });

  // Removing the worktree keeps its branch.
  await call("worktree.remove", { workspaceId });
  assert.equal(
    (await worktrees()).some((w) => w.branch === "feature"),
    false,
  );
  assert.match(await git(repo, "branch", "--list", "feature"), /feature/);

  await assert.rejects(
    a.call("worktree.list", { ...ref, workspaceId, cwd: repo }),
    { code: "invalid_params" },
  );
  await assert.rejects(a.call("worktree.open", { ...ref, cwd: repo }), {
    code: "invalid_params",
  });
  await assert.rejects(
    a.call("tab.create", { ...ref, workspaceId, env: { "BAD-KEY": "x" } }),
    { code: "invalid_params" },
  );
});
