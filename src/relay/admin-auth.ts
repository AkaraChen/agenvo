import { importJWK, jwtVerify } from "jose";
import { digest, Fault } from "../protocol/index.js";

export async function signedOwner(
  request: Request,
  env: { ORIGIN: string; OWNER_PUBLIC_KEY: string },
  purpose: "pairing" | "oauth" = "pairing",
) {
  if (!env.OWNER_PUBLIC_KEY) throw new Fault("owner_not_configured");
  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > 4096)
      throw new Error("token");
    const jwk = JSON.parse(env.OWNER_PUBLIC_KEY);
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d)
      throw new Error("key");
    const { payload } = await jwtVerify(
      authorization.slice(7),
      await importJWK(jwk, "ES256"),
      {
        algorithms: ["ES256"],
        typ: `siyin-${purpose}+jwt`,
        issuer: "siyin-owner",
        subject: purpose,
        audience: env.ORIGIN,
        requiredClaims: ["exp", "iat"],
        maxTokenAge: 60,
        clockTolerance: 5,
      },
    );
    if (
      payload.exp! - payload.iat! > 60 ||
      payload.method !== request.method ||
      payload.path !== new URL(request.url).pathname ||
      payload.body !== (await digest(await request.clone().text()))
    )
      throw new Error("request");
  } catch {
    throw new Fault("permission_denied");
  }
}
