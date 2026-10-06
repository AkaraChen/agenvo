import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateKeyPair, exportJWK, importJWK, SignJWT, type JWK } from "jose";
import { configDir } from "../connector/config.js";
import { digest, Fault } from "../protocol/index.js";

export function ownerOrigin(value: string) {
  if (!value) throw new Fault("origin_required", "Pass --origin https://RELAY");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Fault("https_origin_required", "Use a canonical HTTPS origin");
  return url.origin;
}

export async function ownerKeyPath(origin: string) {
  return join(configDir(), "owner", (await digest(origin)) + ".json");
}

export async function loadOwnerKey(origin: string): Promise<JWK> {
  const path = await ownerKeyPath(origin);
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Fault("insecure_credentials");
  const data = JSON.parse(await readFile(path, "utf8"));
  if (
    data.origin !== origin ||
    data.key?.kty !== "EC" ||
    data.key?.crv !== "P-256" ||
    !data.key?.d
  )
    throw new Fault("invalid_pairing_key");
  return data.key;
}

// Only deployment provisions trust. A runner can never self-authorize by
// generating a key: the corresponding public key must be deployed to the relay.
export async function provisionOwnerKey(origin: string, existing?: string) {
  let key: JWK;
  try {
    key = await loadOwnerKey(origin);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    if (existing) return existing; // Deploying from another machine retains trust.
    const pair = await generateKeyPair("ES256", { extractable: true });
    key = await exportJWK(pair.privateKey);
    const path = await ownerKeyPath(origin);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents concurrent deployments from replacing a key.
    try {
      await writeFile(path, JSON.stringify({ origin, key }) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      key = await loadOwnerKey(origin);
    }
  }
  const publicKey = { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
  if (existing) {
    const previous = JSON.parse(existing);
    if (Object.entries(publicKey).some(([k, v]) => previous[k] !== v))
      throw new Fault(
        "pairing_key_mismatch",
        "Restore the deployment's owner key or explicitly update OWNER_PUBLIC_KEY in its manifest.",
      );
  }
  return JSON.stringify(publicKey);
}

export async function signOwnerRequest(
  key: JWK,
  origin: string,
  method: string,
  path: string,
  body = "",
  purpose: "pairing" | "oauth" = "pairing",
) {
  return new SignJWT({ method, path, body: await digest(body) })
    .setProtectedHeader({ alg: "ES256", typ: `siyin-${purpose}+jwt` })
    .setIssuer("siyin-owner")
    .setSubject(purpose)
    .setAudience(origin)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(await importJWK(key, "ES256"));
}
