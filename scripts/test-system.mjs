import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "agenvo-system-"));
const suites = process.argv.includes("--adapters")
  ? ["tests/adapters"]
  : ["tests/system"];
const files = (
  await Promise.all(
    suites.map(async (dir) =>
      (await readdir(dir))
        .filter((f) => f.endsWith(".test.ts"))
        .map((f) => join(dir, f)),
    ),
  )
).flat();
try {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--test", ...files],
    {
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        ...(process.platform === "win32"
          ? {
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              COMSPEC: process.env.COMSPEC,
              PATHEXT: process.env.PATHEXT,
              USERPROFILE: root,
              APPDATA: join(root, "AppData", "Roaming"),
              LOCALAPPDATA: join(root, "AppData", "Local"),
              TEMP: root,
              TMP: root,
            }
          : {}),
        HOME: root,
        TMPDIR: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        CODEX_HOME: join(root, "codex"),
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        ...(process.platform !== "win32" ? { SHELL: "/bin/sh" } : {}),
      },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
