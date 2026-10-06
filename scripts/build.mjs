import { build } from "esbuild";
import { mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/cli/main.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  banner: { js: "#!/usr/bin/env node" },
});
await rm("dist/source", { recursive: true, force: true });
await cp("src/relay", "dist/source/relay", { recursive: true });
await cp("src/protocol", "dist/source/protocol", { recursive: true });
await cp("src/admin", "dist/source/admin", { recursive: true });
const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
config.main = "source/relay/worker.ts";
config.$schema = "../node_modules/wrangler/config-schema.json";
await writeFile("dist/wrangler.jsonc", JSON.stringify(config, null, 2));
