import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { signedOwner } from "../src/relay/admin-auth.ts";
import {
  signOwnerRequest,
  provisionOwnerKey,
  loadOwnerKey,
  ownerKeyPath,
  ownerOrigin,
} from "../src/cli/owner-key.ts";
import { digest } from "../src/protocol/index.ts";

test("pairing signatures bind origin, method, path and body with a 60-second lifetime", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const other = await generateKeyPair("ES256", { extractable: true });
  const privateKey = await exportJWK(pair.privateKey);
  const origin = "https://siyin.test";
  const path = "/api/admin/pairings/approve";
  const body = JSON.stringify({ code: "test", digest: "test" });
  const env = {
    ORIGIN: origin,
    OWNER_PUBLIC_KEY: JSON.stringify(await exportJWK(pair.publicKey)),
  };
  const signed = await signOwnerRequest(privateKey, origin, "POST", path, body);
  const request = (
    token = signed,
    url = origin + path,
    method = "POST",
    data = body,
  ) =>
    new Request(url, {
      method,
      headers: { Authorization: "Bearer " + token },
      ...(method === "POST" ? { body: data } : {}),
    });
  await signedOwner(request(), env);
  for (const req of [
    request("runner-secret"),
    request(signed, origin + "/api/admin/pairings"),
    request(signed, origin + path, "GET"),
    request(signed, origin + path, "POST", body + " "),
    request(
      await signOwnerRequest(
        privateKey,
        "https://other.test",
        "POST",
        path,
        body,
      ),
    ),
    request(
      await signOwnerRequest(
        await exportJWK(other.privateKey),
        origin,
        "POST",
        path,
        body,
      ),
    ),
  ])
    await assert.rejects(signedOwner(req, env), { code: "permission_denied" });
  const now = Math.floor(Date.now() / 1000);
  const slightlyAhead = await new SignJWT({
    method: "POST",
    path,
    body: await digest(body),
  })
    .setProtectedHeader({ alg: "ES256", typ: "siyin-pairing+jwt" })
    .setIssuer("siyin-owner")
    .setSubject("pairing")
    .setAudience(origin)
    .setIssuedAt(now + 3)
    .setExpirationTime(now + 63)
    .sign(pair.privateKey);
  await signedOwner(request(slightlyAhead), env);
  for (const [iat, exp] of [
    [now - 120, now - 60],
    [now, now + 3600],
    [now + 60, now + 120],
  ]) {
    const token = await new SignJWT({
      method: "POST",
      path,
      body: await digest(body),
    })
      .setProtectedHeader({ alg: "ES256", typ: "siyin-pairing+jwt" })
      .setIssuer("siyin-owner")
      .setSubject("pairing")
      .setAudience(origin)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(pair.privateKey);
    await assert.rejects(signedOwner(request(token), env), {
      code: "permission_denied",
    });
  }
  await assert.rejects(
    signedOwner(request(), { ...env, OWNER_PUBLIC_KEY: "" }),
    { code: "owner_not_configured" },
  );
  await assert.rejects(
    signedOwner(request(), {
      ...env,
      OWNER_PUBLIC_KEY: JSON.stringify(privateKey),
    }),
    { code: "permission_denied" },
  );
});

test("deployment retains pairing trust and stores the private key only in owner configuration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "siyin-pairing-key-"));
  const previous = process.env.SIYIN_CONFIG_DIR;
  process.env.SIYIN_CONFIG_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.SIYIN_CONFIG_DIR;
    else process.env.SIYIN_CONFIG_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const origin = "https://siyin.test";
  const publicKey = await provisionOwnerKey(origin);
  assert.equal(JSON.parse(publicKey).d, undefined);
  assert.equal(await provisionOwnerKey(origin, publicKey), publicKey);
  assert.ok((await loadOwnerKey(origin)).d);
  const path = await ownerKeyPath(origin);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(
    await provisionOwnerKey("https://elsewhere.test", publicKey),
    publicKey,
  );
  await assert.rejects(
    provisionOwnerKey(
      origin,
      JSON.stringify({ ...JSON.parse(publicKey), x: "different" }),
    ),
    { code: "pairing_key_mismatch" },
  );
  await chmod(path, 0o644);
  await assert.rejects(loadOwnerKey(origin), {
    code: "insecure_credentials",
  });
  for (const invalid of [
    "http://siyin.test",
    origin + "/",
    origin + "/x",
    "https://user@siyin.test",
  ])
    assert.throws(() => ownerOrigin(invalid), {
      code: "https_origin_required",
    });
});
