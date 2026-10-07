import { parseArgs } from "node:util";
import { asOutcome, VERSION } from "@agenvo/protocol";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Fault } from "@agenvo/protocol";
import { serverConfig, startServer } from "./server.js";

type Options = Record<string, string | boolean>;
export async function relayCommand(action: string, options: Options) {
  if (action === "init") {
    const origin = String(options.origin ?? "");
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
      next: "agenvo-server serve --config " + path,
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
  throw new Fault("invalid_arguments", "Use init or serve");
}

const args = parseArgs({
  allowPositionals: true,
  options: {
    origin: { type: "string" },
    "data-dir": { type: "string" },
    output: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    config: { type: "string" },
    "trusted-proxy": { type: "boolean" },
    help: { type: "boolean" },
    version: { type: "boolean" },
  },
});
if (args.values.version) console.log(VERSION);
else if (args.values.help || !args.positionals.length)
  console.log(`agenvo-server ${VERSION}

agenvo-server init --origin https://RELAY --data-dir PATH --output CONFIG [--host 127.0.0.1 --port 8080 --trusted-proxy]
agenvo-server serve --config CONFIG

Set AGENVO_ADMIN_SECRET in the server environment. Manage connectors and client authorizations in the Relay web interface.`);
else
  relayCommand(args.positionals[0], args.values as Options)
    .then((value) => console.log(JSON.stringify(value)))
    .catch((error) => {
      console.error(JSON.stringify(asOutcome(error)));
      process.exitCode = 1;
    });
