import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Fault } from "../protocol/index.js";
import { provisionOwnerKey, ownerKeyPath } from "./owner-key.js";
const require = createRequire(import.meta.url);
export async function deploy(options: Record<string, string | boolean>) {
  const name = String(options.name ?? "siyin");
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(name)) throw new Fault("invalid_name");
  const origin = String(options.origin ?? "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin))
    throw new Fault(
      "origin_required",
      "Pass --origin https://WORKER.SUBDOMAIN.workers.dev",
    );
  const templatePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "wrangler.jsonc",
  );
  const configPath = resolve(
    String(options.config ?? "siyin-deploy.local.json"),
  );
  let config: any;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
    if (config.name !== name) throw new Fault("deployment_mismatch");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
    config = JSON.parse(await readFile(templatePath, "utf8"));
    config.name = name;
    config.main = join(dirname(templatePath), config.main);
  }
  // Keep resource identities from the manifest, but deploy this installed
  // package's source even after the CLI was moved or upgraded.
  const template = JSON.parse(await readFile(templatePath, "utf8"));
  config.main = join(dirname(templatePath), template.main);
  config.vars = {
    ORIGIN: origin,
    OWNER_EMAIL: String(options.owner ?? config.vars.OWNER_EMAIL ?? ""),
    ACCESS_ISSUER: String(options.issuer ?? config.vars.ACCESS_ISSUER ?? ""),
    ACCESS_AUD: String(options.aud ?? config.vars.ACCESS_AUD ?? ""),
    OWNER_PUBLIC_KEY: await provisionOwnerKey(
      origin,
      config.vars.OWNER_PUBLIC_KEY ?? config.vars.PAIRING_PUBLIC_KEY,
    ),
  };
  if (
    config.vars.ACCESS_ISSUER &&
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      config.vars.ACCESS_ISSUER,
    )
  )
    throw new Fault("invalid_issuer");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  const wrangler = join(
    dirname(require.resolve("wrangler/package.json")),
    "bin/wrangler.js",
  );
  await new Promise<void>((done, reject) => {
    const child = spawn(
      process.execPath,
      [wrangler, "deploy", "--config", configPath],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? done()
        : reject(
            new Fault(
              "deploy_failed",
              `Wrangler failed; retain ${configPath} and retry the same command.`,
            ),
          ),
    );
  });
  return {
    origin,
    config: configPath,
    pairingKey: await ownerKeyPath(origin),
    access: {
      domains: [
        new URL(origin).host + "/admin",
        new URL(origin).host + "/authorize",
      ],
      owner: config.vars.OWNER_EMAIL,
      configured: Boolean(
        config.vars.ACCESS_ISSUER &&
        config.vars.ACCESS_AUD &&
        config.vars.OWNER_EMAIL,
      ),
      next: "In Cloudflare Zero Trust create one self-hosted Access app for these two paths, allow only the owner email, then rerun deploy with --issuer https://TEAM.cloudflareaccess.com --aud AUD. Public MCP/OAuth/device endpoints must stay outside Access. Wrangler login alone does not grant Access editing.",
    },
  };
}
