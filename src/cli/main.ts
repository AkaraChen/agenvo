import { parseArgs } from "node:util";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import {
  readFile,
  realpath,
  mkdir,
  unlink,
  stat,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir, hostname } from "node:os";
import {
  configDir,
  loadConfig,
  saveConfig,
  atomicJson,
  credentials,
  descriptor,
  instanceConfigSchema,
  type Config,
} from "../connector/config.js";
import { run } from "../connector/main.js";
import { service } from "./service.js";
import { relayCommand, adminCommand } from "./relay.js";
import { deploy } from "./deploy.js";
import { pairingCommand } from "./pairing.js";
import { clientCommand } from "./client.js";
import { digest, Fault, asOutcome, VERSION } from "../protocol/index.js";

const args = parseArgs({
  allowPositionals: true,
  options: Object.fromEntries(
    [
      "name",
      "id",
      "label",
      "binary",
      "cwd",
      "config-root",
      "home",
      "mode",
      "socket",
      "sandbox",
      "approval-policy",
      "origin",
      "owner",
      "issuer",
      "aud",
      "config",
      "fingerprint",
      "client-id",
      "redirect-uri",
      "output",
      "data-dir",
      "host",
      "port",
      "device-id",
      "instance-id",
    ]
      .map((n) => [n, { type: "string" as const }])
      .concat([
        ["json", { type: "boolean" }],
        ["trusted-proxy", { type: "boolean" }],
        ["no-browser", { type: "boolean" }],
        ["cancel", { type: "boolean" }],
        ["recover-lock", { type: "boolean" }],
        ["help", { type: "boolean" }],
        ["version", { type: "boolean" }],
      ] as any),
  ),
});
const options = args.values as Record<string, string | boolean>;
const [command, subcommand, kind] = args.positionals;
const dir = configDir();
const output = (value: unknown) =>
  console.log(JSON.stringify(value, null, options.json ? undefined : 2));
async function config(): Promise<Config> {
  try {
    return await loadConfig(dir);
  } catch (e: any) {
    if (e.code === "ENOENT")
      return { schema: 1, name: hostname(), instances: [] };
    throw e;
  }
}
async function binary(name: string) {
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
function openBrowser(url: string) {
  if (options["no-browser"]) return;
  const child = spawn(
    process.platform === "darwin" ? "open" : "xdg-open",
    [url],
    { stdio: "ignore", detached: true },
  );
  child.on("error", () => {});
  child.unref();
}
async function post(
  url: string,
  body: unknown,
  secret?: string,
  deviceId?: string,
) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(secret ? { Authorization: "Bearer " + secret } : {}),
      ...(deviceId ? { "Siyin-Device-Id": deviceId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Fault("relay_rejected", "Relay returned HTTP " + response.status);
  return response.json() as Promise<any>;
}
async function main() {
  if (options.version) return output({ version: VERSION });
  if (options.help || !command)
    return console.log(
      `Agenvo ${VERSION}\n\nagenvo deploy --origin https://WORKER.SUBDOMAIN.workers.dev [--name agenvo] [--owner EMAIL --issuer URL --aud AUD]\nagenvo relay init --origin https://RELAY --data-dir PATH --output CONFIG [--host 127.0.0.1 --port 8080 --trusted-proxy]\nagenvo relay serve --config CONFIG\nagenvo admin state --origin https://RELAY\nagenvo admin approve-instance --device-id ID --instance-id ID --fingerprint SHA256 --origin https://RELAY\nagenvo admin revoke device|instance|grant --id ID [--instance-id ID] --origin https://RELAY\nagenvo instance add herdr --id work --config-root PATH [--cwd PATH]\nagenvo instance add codex --id coding --home PATH [--mode managed-stdio|attach-unix] [--socket PATH] [--sandbox read-only|workspace-write]\nagenvo connect https://RELAY [--name DEVICE]\nagenvo connect --cancel\nagenvo pairing list --origin https://RELAY\nagenvo pairing approve CODE --fingerprint SHA256 --origin https://RELAY\nagenvo client inspect AUTHORIZATION_URL --origin https://RELAY\nagenvo client approve AUTHORIZATION_URL --origin https://RELAY --client-id ID --redirect-uri URI --output PRIVATE_FILE\nagenvo run\nagenvo service install|uninstall\nagenvo status --json\nagenvo doctor [--recover-lock]\nagenvo disconnect\n\nConfig: ${dir}\nManaged Codex homes default to a separate local directory. attach-unix uses an existing server and preserves native thread permissions; it never starts or stops that server. Log in there with CODEX_HOME=PATH codex login.\nAfter changing instances, explicitly restart the connector and approve new scopes with agenvo admin approve-instance.`,
    );
  if (command === "relay")
    return output(await relayCommand(subcommand, options));
  if (command === "admin")
    return output(await adminCommand(subcommand, kind, options));
  if (command === "deploy") return output(await deploy(options));
  if (command === "client")
    return output(await clientCommand(subcommand, kind, options));
  if (command === "pairing")
    return output(await pairingCommand(subcommand, kind, options));
  if (command === "run") {
    await run(dir);
    return;
  }
  if (command === "instance" && subcommand === "add") {
    const c = await config();
    if (!options.id || !["herdr", "codex"].includes(kind))
      throw new Fault("invalid_arguments");
    if (c.instances.some((i) => i.id === options.id))
      throw new Fault("already_exists", "Choose a new instance ID");
    const cwd = await realpath(resolve(String(options.cwd ?? process.cwd())));
    const base = {
      id: options.id,
      label: options.label ?? options.id,
      kind,
      binary: await binary(kind),
      cwd,
    };
    let entry;
    if (kind === "herdr") {
      if (!options["config-root"])
        throw new Fault(
          "config_root_required",
          "Choose the whole Herdr environment to share with --config-root",
        );
      const configRoot = await realpath(
        resolve(String(options["config-root"])),
      );
      if (basename(configRoot) !== "herdr")
        throw new Fault(
          "invalid_config_root",
          "Use the native Herdr directory named herdr; its parent is XDG_CONFIG_HOME.",
        );
      entry = { ...base, configRoot };
    } else {
      if (options.socket && options.mode !== "attach-unix")
        throw new Fault(
          "invalid_arguments",
          "--socket requires --mode attach-unix",
        );
      if (
        options.mode === "attach-unix" &&
        (options.sandbox || options["approval-policy"])
      )
        throw new Fault(
          "invalid_arguments",
          "attach-unix preserves native permissions; sandbox and approval-policy options apply only to managed-stdio",
        );
      const home = resolve(
        String(
          options.home ??
            (options.mode === "attach-unix"
              ? join(homedir(), ".codex")
              : join(dir, "codex", String(options.id))),
        ),
      );
      if (options.mode !== "attach-unix")
        await mkdir(home, { recursive: true, mode: 0o700 });
      entry = {
        ...base,
        mode: options.mode ?? "managed-stdio",
        ...(options.mode === "attach-unix"
          ? {
              socketPath: resolve(
                String(
                  options.socket ??
                    join(home, "app-server-control", "app-server-control.sock"),
                ),
              ),
            }
          : {}),
        home: await realpath(home),
        policy: {
          sandbox: options.sandbox ?? "read-only",
          approvalPolicy: options["approval-policy"] ?? "untrusted",
        },
      };
    }
    const instance = instanceConfigSchema.parse(entry);
    c.instances.push(instance);
    await saveConfig(c, dir);
    output({
      instanceId: instance.id,
      config: join(dir, "config.json"),
      scope: instance,
      ...(c.relay
        ? {
            next:
              "Restart the connector, inspect agenvo admin state --origin " +
              c.relay +
              ", then use agenvo admin approve-instance.",
          }
        : {}),
    });
    return;
  }
  if (command === "connect") {
    if (options.cancel) {
      const p = JSON.parse(await readFile(join(dir, "pairing.json"), "utf8"));
      await post(p.relay + "/pairings/cancel", { code: p.code }, p.pollSecret);
      await unlink(join(dir, "pairing.json"));
      await unlink(join(dir, "credentials.json")).catch(() => {});
      return output({ cancelled: true });
    }
    const relay = new URL(subcommand);
    if (
      relay.protocol !== "https:" ||
      relay.pathname !== "/" ||
      relay.username ||
      relay.password ||
      relay.search ||
      relay.hash
    )
      throw new Fault("https_origin_required");
    const c = await config();
    if (c.deviceId)
      throw new Fault(
        "already_paired",
        "Disconnect before pairing a different device",
      );
    let p: any;
    try {
      p = JSON.parse(await readFile(join(dir, "pairing.json"), "utf8"));
      if (p.relay !== relay.origin)
        throw new Fault(
          "pending_pairing",
          "Cancel the existing pairing before choosing a different relay",
        );
      if (p.expires <= Date.now()) {
        await unlink(join(dir, "pairing.json"));
        p = undefined;
      } else if (p.configHash !== (await digest(JSON.stringify(c.instances)))) {
        throw new Fault(
          "pending_pairing",
          "Configuration changed; cancel the existing pairing before starting again",
        );
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!p) {
      const secret = randomBytes(32).toString("hex");
      await atomicJson(join(dir, "credentials.json"), { secret });
      const instances = await Promise.all(
        c.instances.map((i) => descriptor(i, false, "pending")),
      );
      p = await post(new URL("/pairings", relay).href, {
        digest: await digest(secret),
        label: String(options.name ?? c.name),
        instances,
      });
      p = {
        ...p,
        relay: relay.origin,
        expires: Date.now() + p.expiresIn * 1000,
        name: String(options.name ?? c.name),
        configHash: await digest(JSON.stringify(c.instances)),
      };
      await atomicJson(join(dir, "pairing.json"), p);
    }
    output({
      approvalUrl: p.approvalUrl,
      code: p.code,
      fingerprint: p.fingerprint,
    });
    openBrowser(p.approvalUrl);
    const expires = p.expires;
    while (Date.now() < expires) {
      const result = await post(
        new URL("/pairings/poll", relay).href,
        { code: p.code },
        p.pollSecret,
      );
      if (result.status === "approved") {
        c.deviceId = result.deviceId;
        c.relay = relay.origin;
        c.name = p.name;
        await saveConfig(c, dir);
        await unlink(join(dir, "pairing.json"));
        output({ paired: true, deviceId: c.deviceId, next: "agenvo run" });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Fault("pairing_expired");
  }
  if (command === "service") {
    if (!["install", "uninstall"].includes(subcommand))
      throw new Fault("invalid_arguments");
    const c = await loadConfig(dir);
    if (subcommand === "install") {
      if (!c.deviceId) throw new Fault("not_paired");
      await credentials(dir);
    }
    output(await service(dir, subcommand as "install" | "uninstall"));
    return;
  }
  if (command === "status") {
    const c = await config();
    let status: any = {};
    try {
      status = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
      process.kill(status.pid, 0);
    } catch {
      status.state = "stopped";
    }
    output({
      configDir: dir,
      relay: c.relay,
      deviceId: c.deviceId,
      instances: c.instances.map((i) => ({ id: i.id, kind: i.kind })),
      ...status,
    });
    return;
  }
  if (command === "doctor") {
    const c = await loadConfig(dir);
    const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
    for (const path of [
      dir,
      join(dir, "config.json"),
      join(dir, "credentials.json"),
    ]) {
      try {
        const s = await stat(path);
        checks.push({
          check: "permissions:" + path,
          ok: (s.mode & 0o077) === 0,
        });
      } catch {
        checks.push({ check: "permissions:" + path, ok: false });
      }
    }
    try {
      const lock = JSON.parse(await readFile(join(dir, "run.lock"), "utf8"));
      let alive = true;
      try {
        process.kill(lock.pid, 0);
      } catch {
        alive = false;
      }
      if (!alive && options["recover-lock"])
        await unlink(join(dir, "run.lock"));
      checks.push({
        check: "connector-lock",
        ok: alive || Boolean(options["recover-lock"]),
        detail: alive
          ? "Running PID " + lock.pid
          : "Stale lock; use --recover-lock only after verifying the process is stopped.",
      });
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const i of c.instances) {
      try {
        const { stdout } = await promisify(execFile)(i.binary, ["--version"], {
          timeout: 8000,
        });
        checks.push({
          check: i.id + ":version",
          ok:
            i.kind === "herdr"
              ? /0\.9\.3\b/.test(stdout)
              : /0\.160\.1\b/.test(stdout),
          detail: stdout.trim(),
        });
      } catch {
        checks.push({ check: i.id + ":version", ok: false });
      }
      if (i.kind === "codex") {
        try {
          const result = await promisify(execFile)(
            i.binary,
            ["login", "status"],
            { env: { ...process.env, CODEX_HOME: i.home }, timeout: 8000 },
          );
          checks.push({
            check: i.id + ":login",
            ok:
              result.stdout.includes("Logged in") ||
              result.stderr.includes("Logged in"),
          });
        } catch {
          checks.push({
            check: i.id + ":login",
            ok: false,
            detail: "Run CODEX_HOME=" + i.home + " codex login locally.",
          });
        }
      }
    }
    if (c.relay) {
      try {
        const r = await fetch(c.relay + "/health", {
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        const health: any = await r.json();
        checks.push({
          check: "relay",
          ok: r.ok && health.protocol === 1 && health.ownerConfigured,
        });
      } catch {
        checks.push({ check: "relay", ok: false });
      }
    }
    if (process.platform === "linux") {
      const result = await promisify(execFile)("loginctl", [
        "show-user",
        String(process.getuid!()),
        "--property=Linger",
      ]).catch(() => ({ stdout: "unknown" }));
      checks.push({
        check: "linger",
        ok: result.stdout.includes("yes"),
        detail: result.stdout.trim() + "; no automatic host changes",
      });
    }
    output({ ok: checks.every((c) => c.ok), checks });
    return;
  }
  if (command === "disconnect") {
    const c = await loadConfig(dir);
    let cloudRevoked = false;
    if (c.relay && c.deviceId) {
      try {
        const { secret } = await credentials(dir);
        await post(c.relay + "/disconnect", {}, secret, c.deviceId);
        cloudRevoked = true;
      } catch {
        /* Local disconnect must still clear credentials. */
      }
    }
    let serviceUninstalled = false;
    try {
      await service(dir, "uninstall");
      serviceUninstalled = true;
    } catch {
      /* Report separately; local credential removal still takes priority. */
    }
    await unlink(join(dir, "credentials.json")).catch(() => {});
    const revokedDeviceId = c.deviceId;
    delete c.deviceId;
    await saveConfig(c, dir);
    output({
      disconnected: true,
      cloudRevoked,
      serviceUninstalled,
      ...(cloudRevoked
        ? {}
        : {
            next:
              "When connectivity returns, run agenvo admin revoke device --id " +
              revokedDeviceId +
              " --origin " +
              c.relay,
          }),
    });
    return;
  }
  throw new Fault("unknown_command");
}
main().catch((error) => {
  output(
    asOutcome(
      error instanceof Fault
        ? error
        : new Fault(
            "cli_error",
            error instanceof Error ? error.message : "CLI failed",
          ),
    ),
  );
  process.exitCode = 1;
});
