import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configDir } from "../src/connector/config.js";

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
