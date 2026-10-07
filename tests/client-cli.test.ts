import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loginClient, clientCommand } from "../src/cli/client.js";
import { provisionOwnerKey } from "../src/cli/owner-key.js";
import { signedOwner } from "../src/relay/admin-auth.js";

test("browserless login discovers deployment endpoints, signs consent and binds PKCE and callback state", async (t) => {
  const dir = await mkdtemp("/tmp/agenvo-client-cli-");
  const originalDir = process.env.AGENVO_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  process.env.AGENVO_CONFIG_DIR = dir;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.AGENVO_CONFIG_DIR;
    else process.env.AGENVO_CONFIG_DIR = originalDir;
    await rm(dir, { recursive: true, force: true });
  });
  const origin = "https://agenvo.test";
  const publicKey = await provisionOwnerKey(origin);
  let authorization: URL;
  let badCallback = false;
  let badMetadata = false;
  let exchanges = 0;
  for (const prefix of ["", "/oauth"]) {
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(init?.redirect, "error");
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          registration_endpoint:
            (badMetadata ? "https://other.test" : origin) +
            prefix +
            "/register",
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + prefix + "/token",
        });
      if (url.pathname === prefix + "/register") {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.token_endpoint_auth_method, "none");
        assert.equal(
          body.redirect_uris[0],
          "http://localhost/agenvo/cli-callback",
        );
        return Response.json({ client_id: "fixture-client" });
      }
      if (url.pathname === "/api/admin/authorization/approve") {
        await signedOwner(
          new Request(url, init),
          { ORIGIN: origin, OWNER_PUBLIC_KEY: publicKey },
          "oauth",
        );
        const body = JSON.parse(String(init?.body));
        authorization = new URL(body.authorizationUrl);
        assert.equal(
          authorization.searchParams.get("client_id"),
          body.clientId,
        );
        assert.equal(
          authorization.searchParams.get("redirect_uri"),
          body.redirectUri,
        );
        const callback = new URL(body.redirectUri);
        callback.search = new URLSearchParams({
          code: "one-time-code",
          state: badCallback
            ? "other"
            : authorization.searchParams.get("state")!,
        }).toString();
        return Response.json({ redirectTo: callback.href });
      }
      if (url.pathname === prefix + "/token") {
        exchanges++;
        const body = new URLSearchParams(String(init?.body));
        assert.equal(
          createHash("sha256")
            .update(body.get("code_verifier")!)
            .digest("base64url"),
          authorization!.searchParams.get("code_challenge"),
        );
        return Response.json({
          access_token: "private-access-token",
          refresh_token: "private-refresh-token",
          expires_in: 900,
        });
      }
      throw Error("Unexpected endpoint: " + url.pathname);
    };
    const path = dir + "/client" + (prefix ? "-worker" : "-vps") + ".json";
    const result = await clientCommand("login", "", { origin, output: path });
    assert.equal(
      JSON.stringify(result).includes("private-access-token"),
      false,
    );
    assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal(
      JSON.parse(await readFile(path, "utf8")).tokens.access_token,
      "private-access-token",
    );
    const count = exchanges;
    await assert.rejects(clientCommand("login", "", { origin, output: path }), {
      code: "EEXIST",
    });
    assert.equal(exchanges, count);
    badCallback = true;
    await assert.rejects(loginClient(origin, "test"), {
      code: "invalid_oauth_callback",
    });
    assert.equal(exchanges, count);
    badCallback = false;
    badMetadata = true;
    await assert.rejects(loginClient(origin, "test"), {
      code: "invalid_oauth_metadata",
    });
    badMetadata = false;
  }
});
