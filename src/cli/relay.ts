import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ownerOrigin, adminRequest } from "./admin-client.js";
import { Fault } from "../protocol/index.js";
import { serverConfig, startServer } from "../server/server.js";

type Options = Record<string, string | boolean>;
export async function relayCommand(action: string, options: Options) {
  if (action === "init") {
    const origin = ownerOrigin(String(options.origin ?? ""));
    if (!options.output || !options["data-dir"])
      throw new Fault("invalid_arguments", "Pass --output and --data-dir");
    const config = serverConfig.parse({
      origin,
      dataDir: resolve(String(options["data-dir"])),
      host: String(options.host ?? "127.0.0.1"),
      port: Number(options.port ?? 8080),
      trustedProxy: Boolean(options["trusted-proxy"]),
    });
    const path = resolve(String(options.output));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    return {
      config: path,
      next: "agenvo relay serve --config " + path,
    };
  }
  if (action === "serve") {
    if (!options.config) throw new Fault("invalid_arguments", "Pass --config");
    const config = serverConfig.parse(
      JSON.parse(await readFile(String(options.config), "utf8")),
    );
    const runtime = await startServer(config);
    console.log(
      JSON.stringify({
        listening: runtime.server.address(),
        origin: config.origin,
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        runtime.close().then(resolve, reject);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return { stopped: true };
  }
  throw new Fault("invalid_arguments", "Use relay init or relay serve");
}
export async function adminCommand(
  action: string,
  kind: string | undefined,
  options: Options,
) {
  const origin = ownerOrigin(String(options.origin ?? ""));
  let path: string,
    body = "",
    method = "POST";
  if (action === "state") {
    path = "/api/admin/state";
    method = "GET";
  } else if (action === "approve-instance") {
    if (
      !options["device-id"] ||
      !options["instance-id"] ||
      !options.fingerprint
    )
      throw new Fault("invalid_arguments");
    path = "/api/admin/instances/approve";
    body = JSON.stringify({
      deviceId: options["device-id"],
      instanceId: options["instance-id"],
      fingerprint: options.fingerprint,
    });
  } else if (action === "revoke") {
    if (
      !["device", "instance", "grant"].includes(kind ?? "") ||
      !options.id ||
      (kind === "instance" && !options["instance-id"])
    )
      throw new Fault("invalid_arguments");
    path = "/api/admin/revoke";
    body = JSON.stringify({
      kind,
      id: options.id,
      ...(options["instance-id"] ? { instanceId: options["instance-id"] } : {}),
    });
  } else throw new Fault("invalid_arguments");
  return adminRequest(origin, method, path, body);
}
