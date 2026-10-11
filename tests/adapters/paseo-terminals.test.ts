import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PaseoAdapter } from "../../apps/paseo/src/paseo.js";
import { nativePaseo } from "../support/paseo-native.js";
import { until } from "../support/environment.js";

test(
  "Paseo plain terminal input, capture, project registration and close",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ag-terminal-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const daemon = await nativePaseo(root);
    t.after(() => daemon.close());
    const client = new DaemonClient({
      url: daemon.endpoint,
      clientId: crypto.randomUUID(),
      clientType: "cli",
      reconnect: { enabled: false },
    });
    await client.connect();
    const serverId = client.getLastServerInfoMessage()!.serverId;
    await client.close();
    const adapter = new PaseoAdapter({
      id: "paseo",
      kind: "paseo",
      label: "Isolated",
      endpoint: daemon.endpoint,
      serverId,
    });
    t.after(() => adapter.close());
    await adapter.init();
    const call = async (method: string, input = {}) => {
      const outcome = await adapter.call(method, input);
      assert.equal(outcome.execution, "accepted", JSON.stringify(outcome));
      return outcome.result as any;
    };
    const registered = await call("paseo.projects.add", { cwd: root });
    assert.equal(registered.project.projectRootPath, root);
    const projects = await call("paseo.projects.list");
    assert.ok(JSON.stringify(projects).includes(registered.project.projectId));
    const created = await call("paseo.workspaces.create", {
      source: { kind: "directory", path: root },
    });
    const terminal = await call("paseo.terminals.create", {
      cwd: root,
      workspaceId: created.workspace.id,
      name: "plain-shell",
    });
    const terminalId = terminal.terminal.id;
    assert.equal(typeof terminalId, "string");
    assert.ok(
      JSON.stringify(
        await call("paseo.terminals.list", {
          workspaceId: created.workspace.id,
        }),
      ).includes(terminalId),
    );
    await call("paseo.terminals.send-text", {
      terminalId,
      text: `"${process.execPath}" -e "console.log('AG_TERMINAL'+'_ok')"`,
    });
    await call("paseo.terminals.send-keys", { terminalId, keys: ["enter"] });
    await until(
      async () =>
        JSON.stringify(
          await call("paseo.terminals.read", { terminalId, start: 0, end: 20 }),
        ),
      (output) => output.includes("AG_TERMINAL_ok"),
    );
    await assert.rejects(
      adapter.call("paseo.terminals.send-keys", {
        terminalId,
        keys: ["unknown-key"],
      }),
      { code: "invalid_params" },
    );
    await call("paseo.terminals.run", {
      terminalId,
      command: `"${process.execPath}" -e "console.log('AG_RUN'+'_ok')"`,
    });
    await until(
      async () =>
        JSON.stringify(
          await call("paseo.terminals.read", { terminalId, start: 0, end: 20 }),
        ),
      (output) => output.includes("AG_RUN_ok"),
    );
    await call("paseo.terminals.close", { terminalId });
    assert.ok(
      !JSON.stringify(
        await call("paseo.terminals.list", {
          workspaceId: created.workspace.id,
        }),
      ).includes(terminalId),
    );
  },
);
