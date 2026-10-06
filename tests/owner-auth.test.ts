import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import {
  verifyOwnerToken,
  owner,
  sameOrigin,
} from "../src/relay/owner-auth.ts";
import { configSchema } from "../src/connector/config.ts";

test("Access owner requires signature, issuer, audience, expiry and exact identity", async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256" }],
  });
  const env = {
    ACCESS_ISSUER: "https://test.cloudflareaccess.com",
    ACCESS_AUD: "agenvo",
    OWNER_EMAIL: "owner@example.com",
  };
  const token = (patch: Record<string, unknown> = {}, key = pair.privateKey) =>
    new SignJWT({
      iss: env.ACCESS_ISSUER,
      aud: env.ACCESS_AUD,
      sub: "owner",
      email: env.OWNER_EMAIL,
      type: "app",
      exp: Math.floor(Date.now() / 1000) + 60,
      ...patch,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(key);
  assert.equal(await verifyOwnerToken(await token(), keys, env), "owner");
  for (const patch of [
    { iss: "https://evil.example" },
    { aud: "other" },
    { email: "other@example.com" },
    { exp: 1 },
    { sub: undefined },
    { type: "service" },
  ])
    await assert.rejects(verifyOwnerToken(await token(patch), keys, env), {
      code: "permission_denied",
    });
  await assert.rejects(
    verifyOwnerToken(await token({}, other.privateKey), keys, env),
    { code: "permission_denied" },
  );
  await assert.rejects(
    owner(new Request("https://agenvo.test/admin"), {} as Env),
    { code: "owner_not_configured" },
  );
  assert.throws(
    () =>
      sameOrigin(
        new Request("https://agenvo.test/admin", {
          headers: { Origin: "https://evil.test" },
        }),
        { ORIGIN: "https://agenvo.test" } as Env,
      ),
    { code: "csrf_rejected" },
  );
});
test("stored connector configuration cannot downgrade or redirect credential transport", () => {
  for (const relay of [
    "http://example.com",
    "https://example.com/path",
    "https://name:secret@example.com",
    "https://example.com?x=1",
  ])
    assert.equal(
      configSchema.safeParse({ schema: 1, name: "test", instances: [], relay })
        .success,
      false,
    );
  assert.equal(
    configSchema.safeParse({
      schema: 1,
      name: "test",
      instances: [],
      relay: "https://example.com",
    }).success,
    true,
  );
});
