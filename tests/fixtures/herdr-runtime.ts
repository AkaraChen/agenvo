import { isolatedEnvironment } from "../support/environment.js";
// Test-owned native service. Runtime provisioning deliberately bypasses Agenvo.
import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type HerdrConfig } from "../../src/connector/config.ts";
const exec = promisify(execFile);
export function herdrFixture(
  config: Pick<HerdrConfig, "binary" | "configRoot" | "cwd">,
  session: string,
) {
  const socket = join(config.configRoot, "sessions", session, "herdr.sock");
  const env = {
    ...isolatedEnvironment(config.cwd),
    CODEX_HOME: join(config.cwd, "codex-test-home"),
    XDG_CONFIG_HOME: dirname(config.configRoot),
    HERDR_SOCKET_PATH: socket,
    HERDR_CONFIG_PATH: join(config.configRoot, "config.toml"),
    HERDR_SESSION: session,
  };
  const exists = () =>
    stat(socket).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  let owned = false;
  return {
    async start() {
      if (await exists()) throw new Error("Test endpoint already exists");
      await mkdir(dirname(socket), { recursive: true });
      await mkdir(env.CODEX_HOME!, { recursive: true });
      const child = spawn(config.binary, ["server"], {
        cwd: config.cwd,
        env,
        stdio: "ignore",
        detached: true,
      });
      owned = true;
      let error: Error | undefined;
      child.on("error", (e) => {
        error = e;
      });
      child.unref();
      for (let i = 0; i < 80; i++) {
        if (error) throw error;
        if (await exists()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Test Herdr did not start");
    },
    async stop() {
      if (!owned || !(await exists())) return;
      await exec(config.binary, ["server", "stop"], {
        env,
        cwd: config.cwd,
        timeout: 8000,
      });
      for (let i = 0; i < 80; i++) {
        if (!(await exists())) {
          owned = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("Test Herdr did not stop");
    },
  };
}
