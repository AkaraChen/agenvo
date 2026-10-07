import { z } from "zod";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import {
  mkdir,
  chmod,
  readFile,
  writeFile,
  rename,
  stat,
  realpath,
  open,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  canonical,
  digest,
  identifier,
  Fault,
  type Instance,
} from "../protocol/index.js";

const absolutePath = z
  .string()
  .refine(isAbsolute, "An absolute path is required");
const common = {
  id: identifier,
  label: z.string().min(1).max(128),
  binary: absolutePath,
  cwd: absolutePath,
};
export const instanceConfigSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("herdr"),
    configRoot: absolutePath,
  }),
  z
    .strictObject({
      ...common,
      kind: z.literal("codex"),
      mode: z.enum(["managed-stdio", "attach-unix"]),
      socketPath: absolutePath.optional(),
      home: absolutePath,
      // Read legacy installations without retaining obsolete execution ceilings.
      policy: z.unknown().optional(),
    })
    .superRefine((config, ctx) => {
      if ((config.mode === "attach-unix") !== Boolean(config.socketPath))
        ctx.addIssue({
          code: "custom",
          message:
            "attach-unix requires socketPath; managed-stdio does not accept it",
        });
    })
    .transform(({ policy: _legacyPolicy, ...config }) => config),
]);
export type InstanceConfig = z.infer<typeof instanceConfigSchema>;
export type CodexConfig = Extract<InstanceConfig, { kind: "codex" }>;
export type HerdrConfig = Extract<InstanceConfig, { kind: "herdr" }>;
export const configSchema = z
  .strictObject({
    schema: z.literal(1),
    relay: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.origin === value;
      }, "Relay must be a canonical HTTPS origin")
      .optional(),
    deviceId: z.string().uuid().optional(),
    name: z.string().max(128),
    instances: z.array(instanceConfigSchema).max(128),
  })
  .refine(
    (c) => new Set(c.instances.map((i) => i.id)).size === c.instances.length,
    "Duplicate instance ID",
  );
export type Config = z.infer<typeof configSchema>;
export const configDir = () =>
  resolve(
    process.env.AGENVO_CONFIG_DIR ??
      process.env.SIYIN_CONFIG_DIR ??
      join(homedir(), ".config", "agenvo"),
  );
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function loadConfig(dir = configDir()): Promise<Config> {
  return configSchema.parse(
    JSON.parse(await readFile(join(dir, "config.json"), "utf8")),
  );
}
export async function saveConfig(config: Config, dir = configDir()) {
  const validated = configSchema.parse(config);
  await atomicJson(join(dir, "config.json"), validated);
}
export async function credentials(
  dir = configDir(),
): Promise<{ secret: string }> {
  const path = join(dir, "credentials.json");
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0)
    throw new Fault("insecure_credentials", "Credentials must have mode 0600");
  return z
    .strictObject({ secret: z.string().min(64).max(128) })
    .parse(JSON.parse(await readFile(path, "utf8")));
}
export async function descriptor(
  config: InstanceConfig,
  available: boolean,
  backendVersion: string,
): Promise<Instance> {
  const { label, ...settings } = config;
  const scope = { ...settings, execution: "full-access" };
  return {
    instanceId: config.id,
    label,
    kind: config.kind,
    scope,
    fingerprint: await digest(canonical(scope)),
    available,
    backendVersion,
    capabilityRevision:
      config.kind === "herdr"
        ? "herdr-0.9.3-management-v1"
        : config.mode === "attach-unix"
          ? "codex-0.160.1-attach-management-v1"
          : "codex-0.160.1-management-v1",
  };
}
export async function validatePaths(config: InstanceConfig) {
  for (const path of [
    config.binary,
    config.cwd,
    config.kind === "herdr" ? config.configRoot : config.home,
  ]) {
    const actual = await realpath(path);
    if (actual !== path)
      throw new Fault("noncanonical_path", `Use the canonical path: ${actual}`);
  }
}
export async function acquireLock(
  dir = configDir(),
): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "run.lock");
  // An exclusive lock file avoids silently running two connectors for one credential.
  // Stale locks are deliberately recovered by doctor, never stolen during a start race.
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw new Fault(
      "connector_locked",
      "Connector lock exists; run agenvo doctor to inspect it.",
    );
  }
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
  );
  await handle.close();
  return async () => {
    await unlink(path).catch(() => {});
  };
}
