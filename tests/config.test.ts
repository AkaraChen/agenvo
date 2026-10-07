import { configDir } from "@agenvo/connector/config";
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { descriptor, instanceConfigSchema } from "./support/config.js";

test("Connector defaults isolate backends and explicit directories override defaults", (t) => {
  const previous = {
    AGENVO_CONFIG_DIR: process.env.AGENVO_CONFIG_DIR,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  delete process.env.AGENVO_CONFIG_DIR;
  assert.equal(
    configDir("herdr"),
    join(homedir(), ".config", "agenvo", "herdr"),
  );
  assert.notEqual(configDir("herdr"), configDir("codex-app-server"));
  process.env.AGENVO_CONFIG_DIR = "selected-installation";
  assert.equal(configDir("herdr"), resolve("selected-installation"));
});

test("Codex configuration is strict and full access is explicit in the approved scope", async () => {
  const config = instanceConfigSchema.parse({
    id: "test",
    label: "Test",
    kind: "codex",
    binary: "/bin/codex",
    home: "/tmp/codex",
    cwd: "/tmp",
    mode: "managed-stdio",
  });
  assert.equal(
    instanceConfigSchema.safeParse({ ...config, policy: {} }).success,
    false,
  );
  const instance = await descriptor(config, true, "0.160.1");
  assert.equal(instance.scope.execution, "full-access");
});
