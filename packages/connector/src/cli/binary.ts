import { realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { Fault } from "@agenvo/protocol";
export async function binary(
  name: string,
  options: Record<string, string | boolean>,
) {
  if (options.binary) {
    const path = await realpath(String(options.binary));
    await access(path, constants.X_OK);
    return path;
  }
  for (const base of (process.env.PATH ?? "").split(":")) {
    try {
      const path = await realpath(join(base, name));
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Continue PATH lookup at configuration time only. */
    }
  }
  throw new Fault("binary_not_found", name + " is not executable in PATH");
}
