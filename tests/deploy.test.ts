import test from "node:test";
import assert from "node:assert/strict";
import { bindDeploymentResources } from "../src/cli/deploy.js";

test("deployment records provisioned KV identities without replacing saved resources", () => {
  const id = "a".repeat(32);
  const config = { kv_namespaces: [{ binding: "OAUTH_KV" }] };
  const version = {
    resources: {
      bindings: [{ name: "OAUTH_KV", type: "kv_namespace", namespace_id: id }],
    },
  };
  bindDeploymentResources(config, version);
  assert.deepEqual(config.kv_namespaces, [{ binding: "OAUTH_KV", id }]);
  bindDeploymentResources(config, version);
  const before = structuredClone(config);
  assert.throws(
    () =>
      bindDeploymentResources(config, {
        resources: {
          bindings: [
            {
              name: "OAUTH_KV",
              type: "kv_namespace",
              namespace_id: "b".repeat(32),
            },
          ],
        },
      }),
    { code: "deployment_binding_mismatch" },
  );
  assert.deepEqual(config, before);
  assert.throws(
    () => bindDeploymentResources(config, { resources: { bindings: [] } }),
    { code: "deployment_metadata_unavailable" },
  );
});
