import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backend as codex } from "../apps/codex-app-server/src/backend.js";
import { backend as herdr } from "../apps/herdr/src/backend.js";
import { HerdrAdapter } from "../apps/herdr/src/herdr.js";

test("runtime diagnostics report versions without requiring the CI baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agenvo-versions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "runtime");
  await writeFile(
    binary,
    `#!/usr/bin/env node
console.log(process.argv.includes('--version') ? 'fixture 9.0.0' : 'Logged in');
`,
    { mode: 0o755 },
  );
  const common = { id: "test", label: "Test", binary, cwd: root };
  const codexConfig = codex.schema.parse({
    ...common,
    kind: "codex",
    home: root,
    mode: "managed-stdio",
  });
  const codexChecks = await codex.doctor(codexConfig);
  assert.equal(codexChecks.find((c) => c.check === "test:version")?.ok, true);
  assert.equal(
    codexChecks.find((c) => c.check === "test:version")?.detail,
    "fixture 9.0.0",
  );
  const configRoot = join(root, "herdr");
  await mkdir(configRoot);
  const herdrConfig = herdr.schema.parse({
    ...common,
    kind: "herdr",
    configRoot,
  });
  assert.equal((await herdr.doctor(herdrConfig))[0].ok, true);
  const adapter = new HerdrAdapter(herdrConfig);
  t.after(() => adapter.close());
  await adapter.init();
  assert.equal(adapter.available, true);
  assert.equal(adapter.version, "fixture 9.0.0");
});
