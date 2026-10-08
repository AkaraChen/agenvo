import { execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

// Windows signals terminate only the wrapper, leaving workerd/native children
// holding test directories and pipes. Stop the whole test-owned process tree.
export async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform === "win32") {
    let terminationError: unknown;
    try {
      await promisify(execFile)(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { timeout: 5000 },
      );
    } catch (error) {
      terminationError = error;
    }
    // taskkill can report a descendant that exited during traversal before
    // Node receives the root's exit event. Judge the observed root exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error("Test process did not exit after taskkill", {
                  cause: terminationError,
                }),
              ),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
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
