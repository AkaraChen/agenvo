import { execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

// Windows signals terminate only the wrapper, leaving workerd/native children
// holding test directories and pipes. Stop the whole test-owned process tree.
export async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", [
      "/PID",
      String(child.pid),
      "/T",
      "/F",
    ]);
    await exited;
    return;
  }
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}
