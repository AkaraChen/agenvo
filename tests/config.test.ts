import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  configDir,
  descriptor,
  instanceConfigSchema,
} from "../src/connector/config.js";

test("Agenvo configuration is explicit, with the legacy environment as a fallback", (t) => {
  const previous = {
    AGENVO_CONFIG_DIR: process.env.AGENVO_CONFIG_DIR,
    SIYIN_CONFIG_DIR: process.env.SIYIN_CONFIG_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.AGENVO_CONFIG_DIR;
  delete process.env.SIYIN_CONFIG_DIR;
  assert.equal(configDir(), join(homedir(), ".config", "agenvo"));
  process.env.SIYIN_CONFIG_DIR = "legacy-installation";
  assert.equal(configDir(), resolve("legacy-installation"));
  process.env.AGENVO_CONFIG_DIR = "selected-installation";
  assert.equal(configDir(), resolve("selected-installation"));
});

test("legacy execution ceilings are discarded and full access is explicit in the approved scope", async () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: "/bin/codex",
    home: "/tmp/codex",
    cwd: "/tmp",
    mode: "managed-stdio",
    policy: { sandbox: "read-only", approvalPolicy: "untrusted" },
  });
  assert.equal("policy" in config, false);
  const instance = await descriptor(config, true, "0.160.1");
  assert.equal(instance.scope.execution, "full-access");
});
