import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { CodexAdapter } from "../apps/codex-app-server/src/codex.js";
import { until } from "./support/environment.js";

test(
  "closing managed Codex terminates the process behind a Windows command shim",
  {
    skip:
      process.platform !== "win32"
        ? "Windows npm command shim lifecycle"
        : false,
    timeout: 15000,
  },
  async (t) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "agenvo process ")),
    );
    const pidFile = join(root, "native.pid");
    const script = join(root, "runtime.mjs");
    const binary = join(root, "codex.cmd");
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';
if (!process.argv.includes('--version')) writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
await import(${JSON.stringify(pathToFileURL(resolve("tests/fixtures/codex-backend.mjs")).href)});
`,
    );
    await writeFile(binary, `@"${process.execPath}" "${script}" %*\r\n`);
    const adapter = new CodexAdapter({
      kind: "codex",
      id: "test",
      label: "Test",
      binary,
      cwd: root,
      home: root,
      mode: "managed-stdio",
    });
    let pid = 0;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: any) {
        if (error.code !== "ESRCH") throw error;
        return false;
      }
    };
    t.after(async () => {
      await adapter.close();
      if (pid && alive())
        await execa("taskkill", ["/PID", String(pid), "/T", "/F"], {
          reject: false,
        });
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    });
    await adapter.init();
    pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(pid && alive());
    await adapter.close();
    await until(alive, (running) => !running, 3000);
  },
);
