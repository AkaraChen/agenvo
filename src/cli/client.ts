import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ownerOrigin, loadOwnerKey, signOwnerRequest } from "./owner-key.js";
import { Fault } from "../protocol/index.js";

export async function clientCommand(
  action: string,
  authorizationUrl: string,
  options: Record<string, string | boolean>,
) {
  const origin = ownerOrigin(String(options.origin ?? ""));
  if (!["inspect", "approve"].includes(action))
    throw new Fault("invalid_arguments");
  const url = new URL(authorizationUrl);
  if (
    url.origin !== origin ||
    url.pathname !== "/authorize" ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Fault("invalid_authorization_request");
  if (
    action === "approve" &&
    (!options["client-id"] || !options["redirect-uri"] || !options.output)
  )
    throw new Fault(
      "invalid_arguments",
      "Inspect first, then pass --client-id, --redirect-uri and --output PATH. The callback contains a one-time authorization code.",
    );
  const path = "/api/admin/authorization/" + action;
  const body = JSON.stringify({
    authorizationUrl,
    ...(action === "approve"
      ? { clientId: options["client-id"], redirectUri: options["redirect-uri"] }
      : {}),
  });
  const token = await signOwnerRequest(
    await loadOwnerKey(origin),
    origin,
    "POST",
    path,
    body,
    "oauth",
  );
  const response = await fetch(origin + path, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body,
  });
  if (!response.ok)
    throw new Fault(
      "authorization_api_rejected",
      "Authorization API returned HTTP " + response.status,
    );
  const result = await response.json();
  if (action === "inspect") return result;
  const pathOut = resolve(String(options.output));
  await writeFile(pathOut, JSON.stringify(result) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return {
    authorized: true,
    callbackFile: pathOut,
    next: "Open redirectTo from this private file in the initiating browser to finish the client's OAuth flow.",
  };
}
