import { realpath, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, extname } from "node:path";
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
  const names =
    process.platform === "win32" && !extname(name)
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((ext) => name + ext.toLowerCase())
      : [name];
  for (const base of (process.env.PATH ?? "").split(delimiter)) {
    for (const candidate of names) {
      try {
        const path = await realpath(join(base, candidate));
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* Continue PATH lookup at configuration time only. */
      }
    }
  }
  throw new Fault("binary_not_found", name + " is not executable in PATH");
}
