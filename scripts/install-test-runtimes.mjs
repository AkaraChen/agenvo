// Install pinned public binaries into an explicit test directory. No login or
// user configuration is copied. Versions must match the native adapter contract.
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: node scripts/install-test-runtimes.mjs <directory>");
const root = resolve(directory),
  bin = join(root, "bin");
await mkdir(bin, { recursive: true });
const os = { linux: "linux", darwin: "macos" }[process.platform];
const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!os || !arch)
  throw new Error("Native test runtimes require Linux or macOS on x64/arm64");
const name = `herdr-${os}-${arch}`;
const release = await fetch(
  "https://api.github.com/repos/herdrdev/herdr/releases/tags/v0.9.3",
).then((r) => {
  if (!r.ok) throw new Error(`Release lookup: ${r.status}`);
  return r.json();
});
const asset = release.assets.find((a) => a.name === name);
if (!asset?.digest?.startsWith("sha256:"))
  throw new Error("Release asset must have a SHA-256 digest");
const response = await fetch(asset.browser_download_url);
if (!response.ok) throw new Error(`Binary download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  "sha256:" + createHash("sha256").update(bytes).digest("hex") !==
  asset.digest
)
  throw new Error("Herdr asset digest mismatch");
await writeFile(join(bin, "herdr"), bytes);
await chmod(join(bin, "herdr"), 0o755);
await promisify(execFile)(
  "npm",
  [
    "install",
    "--prefix",
    root,
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "@openai/codex@0.160.1",
  ],
  { maxBuffer: 1024 * 1024 },
);
console.log(`Add to PATH: ${bin}:${join(root, "node_modules", ".bin")}`);
