import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { Fault } from "@agenvo/protocol";
import { absolutePath, commonInstanceFields } from "@agenvo/connector/config";
export const instanceConfigSchema = z.strictObject({
  ...commonInstanceFields,
  kind: z.literal("paseo"),
  endpoint: z.url().refine((value) => {
    const u = new URL(value);
    return (
      ["ws:", "wss:"].includes(u.protocol) &&
      u.pathname === "/ws" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, "Use a ws:// or wss:// endpoint ending in /ws without credentials or query parameters"),
  serverId: z.string().min(1).max(256),
  passwordFile: absolutePath.optional(),
});
export type PaseoConfig = z.infer<typeof instanceConfigSchema>;
export async function password(config: Pick<PaseoConfig, "passwordFile">) {
  if (!config.passwordFile) return undefined;
  const info = await stat(config.passwordFile);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new Fault(
      "insecure_credentials",
      "Paseo password file must have mode 0600",
    );
  return (await readFile(config.passwordFile, "utf8")).trimEnd();
}
