import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { AmpAdapter } from "../../apps/amp/src/amp.js";
import { binary } from "@agenvo/connector/cli/binary";
import { isolatedEnvironment, until } from "../support/environment.js";

test(
  "native Amp loads the release plugin, serves a CLI discovery request and disposes without credentials",
  { timeout: 15000 },
  async (t) => {
    let executable: string;
    try {
      executable = await binary("amp", {});
    } catch {
      t.skip(
        "Amp CLI is not installed; this smoke test does not exercise cloud inference",
      );
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "agenvo-amp-native-"));
    const config = {
      kind: "amp" as const,
      id: "amp",
      label: "Native smoke",
      cwd: root,
      binary: resolve("tests/fixtures/amp-cli.mjs"),
      bridgeDir: join(root, "bridge"),
      pluginPath: join(root, "bridge.ts"),
    };
    const adapter = new AmpAdapter(config);
    await adapter.init();
    await writeFile(
      config.pluginPath,
      `import attach from ${JSON.stringify(pathToFileURL(resolve("apps/amp/dist/plugin.js")).href)};\nexport default amp => attach(amp, ${JSON.stringify(config)});\n`,
    );
    const child = execa(
      executable,
      ["plugins", "exec", config.pluginPath, "agent.end", "--data", "{}"],
      {
        cwd: root,
        env: { ...isolatedEnvironment(root), AMP_URL: "http://127.0.0.1:1" },
        extendEnv: false,
        timeout: 10000,
        reject: false,
      },
    );
    t.after(async () => {
      child.kill();
      await child;
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    });
    await until(() => adapter.available, Boolean);
    const serviceId = [...adapter.services.keys()][0];
    const result = await adapter.call("amp.threads.list", { serviceId });
    assert.equal(result.execution, "accepted", JSON.stringify(result));
    assert.equal((result.result as any[])[0].id, "T-external");
    assert.equal((await child).exitCode, 0);
    await until(
      () => adapter.available,
      (value) => !value,
    );
  },
);
