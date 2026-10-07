import { writeFile, open, unlink, readFile, stat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { atomicJson } from "../connector/config.js";
import { resolve } from "node:path";
import { ownerOrigin, loadOwnerKey, signOwnerRequest } from "./owner-key.js";
import { Fault } from "../protocol/index.js";

export async function clientCommand(
  action: string,
  authorizationUrl: string,
  options: Record<string, string | boolean>,
) {
  if (action === "call") return callTool(authorizationUrl, options);
  const origin = ownerOrigin(String(options.origin ?? ""));
  if (action === "login") {
    if (!options.output)
      throw new Fault("invalid_arguments", "Pass --output PRIVATE_FILE");
    const path = resolve(String(options.output));
    // Reserve before remote changes; never replace another client's credentials.
    const file = await open(path, "wx", 0o600);
    try {
      const credentials = await loginClient(
        origin,
        String(options.name ?? "agenvo-cli"),
      );
      await file.writeFile(JSON.stringify(credentials) + "\n");
      return {
        authorized: true,
        credentialsFile: path,
        origin,
        clientId: credentials.clientId,
      };
    } catch (error) {
      await unlink(path);
      throw error;
    } finally {
      await file.close();
    }
  }
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

async function jsonRequest(url: string, init: RequestInit) {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Fault(
      "oauth_request_failed",
      "OAuth endpoint returned HTTP " + response.status,
    );
  return response.json() as Promise<any>;
}

// The owner signs the same consent endpoint as browser-initiated clients. The
// callback is consumed locally; no browser or listening HTTP server is needed.
export async function loginClient(origin: string, name: string) {
  origin = ownerOrigin(origin);
  const owner = await loadOwnerKey(origin);
  const metadata = await oauthMetadata(origin);
  const redirectUri = "http://localhost/agenvo/cli-callback";
  const client = await jsonRequest(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  if (typeof client.client_id !== "string")
    throw new Fault("invalid_oauth_response");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: "runtime:approved",
    resource: origin + "/mcp",
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    state,
  }).toString();
  const path = "/api/admin/authorization/approve";
  const body = JSON.stringify({
    authorizationUrl: url.href,
    clientId: client.client_id,
    redirectUri,
  });
  const signature = await signOwnerRequest(
    owner,
    origin,
    "POST",
    path,
    body,
    "oauth",
  );
  const approval = await jsonRequest(origin + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + signature,
      "Content-Type": "application/json",
    },
    body,
  });
  const callback = new URL(approval.redirectTo);
  if (
    callback.origin + callback.pathname !== redirectUri ||
    callback.searchParams.get("state") !== state ||
    !callback.searchParams.get("code")
  )
    throw new Fault("invalid_oauth_callback");
  const tokens = await jsonRequest(metadata.token_endpoint, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      resource: origin + "/mcp",
    }),
  });
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.refresh_token !== "string" ||
    !Number.isFinite(tokens.expires_in)
  )
    throw new Fault("invalid_oauth_response");
  return {
    origin,
    clientId: client.client_id,
    tokens,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

async function callTool(
  tool: string,
  options: Record<string, string | boolean>,
) {
  if (!tool || !options.credentials)
    throw new Fault(
      "invalid_arguments",
      "Pass TOOL and --credentials PRIVATE_FILE",
    );
  const path = resolve(String(options.credentials));
  if (((await stat(path)).mode & 0o077) !== 0)
    throw new Fault("insecure_credentials");
  const credentials = JSON.parse(await readFile(path, "utf8"));
  const origin = ownerOrigin(credentials.origin);
  if (credentials.expiresAt <= Date.now() + 30000) {
    const metadata = await oauthMetadata(origin);
    const tokens = await jsonRequest(metadata.token_endpoint, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: credentials.clientId,
        refresh_token: credentials.tokens.refresh_token,
        resource: origin + "/mcp",
      }),
    });
    credentials.tokens = { ...credentials.tokens, ...tokens };
    credentials.expiresAt = Date.now() + tokens.expires_in * 1000;
    await atomicJson(path, credentials);
  }
  const params = options["params-file"]
    ? JSON.parse(await readFile(String(options["params-file"]), "utf8"))
    : {};
  const client = new Client({ name: "agenvo-cli", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(origin + "/mcp"),
    {
      requestInit: {
        headers: { Authorization: "Bearer " + credentials.tokens.access_token },
      },
    },
  );
  try {
    await client.connect(transport);
    return await client.callTool({ name: tool, arguments: params });
  } finally {
    await client.close();
  }
}

async function oauthMetadata(origin: string) {
  const metadata = await jsonRequest(
    origin + "/.well-known/oauth-authorization-server",
    { method: "GET" },
  );
  if (metadata.issuer !== origin) throw new Fault("invalid_oauth_metadata");
  for (const field of [
    "registration_endpoint",
    "authorization_endpoint",
    "token_endpoint",
  ]) {
    const endpoint = new URL(metadata[field]);
    if (
      endpoint.origin !== origin ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash
    )
      throw new Fault("invalid_oauth_metadata");
  }
  return metadata;
}
