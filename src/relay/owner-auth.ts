import { createRemoteJWKSet, jwtVerify } from "jose";
import { Fault } from "../protocol/index.js";

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function owner(request: Request, env: Env): Promise<string> {
  if (
    !env.OWNER_EMAIL ||
    !env.ACCESS_AUD ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER)
  )
    throw new Fault("owner_not_configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16384) throw new Fault("permission_denied");
  let keys = keysets.get(env.ACCESS_ISSUER);
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", env.ACCESS_ISSUER),
    );
    keysets.set(env.ACCESS_ISSUER, keys);
  }
  return verifyOwnerToken(token, keys, env);
}
export async function verifyOwnerToken(
  token: string,
  keys: Parameters<typeof jwtVerify>[1],
  env: Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUD" | "OWNER_EMAIL">,
): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "sub", "email"],
    });
    if (payload.email !== env.OWNER_EMAIL || payload.type !== "app")
      throw new Error("identity");
    return payload.sub!;
  } catch {
    throw new Fault("permission_denied");
  }
}
export function sameOrigin(request: Request, env: Env) {
  if (request.headers.get("origin") !== env.ORIGIN)
    throw new Fault("csrf_rejected");
}
