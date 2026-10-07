const ADMIN_SECRET = "test-admin-secret-not-for-production-1234567890";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer } from "../../src/server/server.js";
import { CodexAdapter } from "../../src/connector/adapters/codex.js";
import { instanceConfigSchema } from "../../src/connector/config.js";
import { describe, accepted } from "../../src/connector/adapters/adapter.js";
import { digest, asOutcome, type Instance } from "../../src/protocol/index.js";

// Exercise the production HTTP routes behind the same Host-preserving boundary
// used by the documented reverse proxy. No fixture authorization endpoints.
test(
  "VPS persists OAuth/device state and routes MCP over authenticated WebSockets",
  { timeout: 30000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "agenvo-vps-"));
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const origin = "https://127.0.0.1:" + port;
    const config = {
      origin,
      dataDir,
      host: "127.0.0.1",
      port,
    };
    let runtime = await startServer(config, ADMIN_SECRET);
    let base = () =>
      "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
    t.after(async () => {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const request = async (path: string, init: RequestInit = {}) =>
      fetch(base() + path, {
        redirect: "manual",
        ...init,
        headers: {
          host: new URL(origin).host,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      });
    const json = (value: unknown) => ({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    const admin = async (
      path: string,
      value?: unknown,
      purpose: "pairing" | "oauth" = "pairing",
    ) => {
      const body = value === undefined ? "" : JSON.stringify(value),
        method = body ? "POST" : "GET";
      const signature = ADMIN_SECRET;
      const r = await request(path, {
        method,
        headers: {
          Authorization: "Bearer " + signature,
          "Content-Type": "application/json",
        },
        ...(body ? { body } : {}),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<any>;
    };
    assert.equal((await request("/health")).status, 200);
    assert.equal((await request("/api/admin/state")).status, 403);
    for (const [value, expected] of [
      [{ kind: "grant", id: "missing" }, 404],
      [{ kind: "device", id: "missing" }, 404],
      [{ kind: "instance", id: "missing" }, 400],
      [{ kind: "instance", id: "missing", instanceId: "missing" }, 404],
    ] as const) {
      const body = JSON.stringify(value),
        path = "/api/admin/revoke";
      const token = ADMIN_SECRET;
      const r = await request(path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body,
      });
      assert.equal(r.status, expected, await r.text());
    }
    const metadata = (await (
      await request("/.well-known/oauth-authorization-server")
    ).json()) as any;
    assert.equal(metadata.token_endpoint, origin + "/token");
    assert.equal((await request("/mcp", json({}))).status, 401);
    const registration = await request(
      "/register",
      json({
        client_name: "Test client",
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    );
    assert.equal(registration.status, 201, await registration.clone().text());
    const client = (await registration.json()) as any;
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(origin + "/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      scope: "runtime:approved",
      resource: origin + "/mcp",
      state: "bound-state",
    }).toString();
    assert.equal((await request(url.pathname + url.search)).status, 303);
    const login = await request("/login", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({
        secret: ADMIN_SECRET,
        next: url.pathname + url.search,
      }),
    });
    assert.equal(login.status, 303);
    const ownerCookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const consent = await request(login.headers.get("location")!, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(consent.status, 200);
    const handle = /name="handle" value="([^"]+)"/.exec(
      await consent.text(),
    )![1];
    const consentPost = () =>
      request("/authorize", {
        method: "POST",
        headers: { Cookie: ownerCookie, Origin: origin },
        body: new URLSearchParams({ handle, decision: "approve" }),
      });
    const unrelated = await request("/login", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({ secret: ADMIN_SECRET }),
    });
    const unrelatedCookie = unrelated.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert.equal(
      (
        await request("/authorize", {
          method: "POST",
          headers: { Cookie: unrelatedCookie, Origin: origin },
          body: new URLSearchParams({ handle, decision: "approve" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/authorize", {
          method: "POST",
          headers: { Cookie: ownerCookie, Origin: "https://evil.test" },
          body: new URLSearchParams({ handle, decision: "approve" }),
        })
      ).status,
      403,
    );
    const approved = await consentPost();
    assert.equal(approved.status, 302);
    assert.equal((await consentPost()).status, 403);
    const redirect = new URL(approved.headers.get("location")!);
    assert.equal(redirect.searchParams.get("state"), "bound-state");
    const denyPage = await request(url.pathname + url.search, {
      headers: { Cookie: ownerCookie },
    });
    const denyHandle = /name="handle" value="([^"]+)"/.exec(
      await denyPage.text(),
    )![1];
    const deniedConsent = await request("/authorize", {
      method: "POST",
      headers: { Cookie: ownerCookie, Origin: origin },
      body: new URLSearchParams({ handle: denyHandle, decision: "deny" }),
    });
    assert.equal(deniedConsent.status, 302);
    const deniedConsentUrl = new URL(deniedConsent.headers.get("location")!);
    assert.equal(deniedConsentUrl.searchParams.get("error"), "access_denied");
    assert.equal(deniedConsentUrl.searchParams.get("state"), "bound-state");
    assert.equal(deniedConsentUrl.searchParams.get("iss"), metadata.issuer);
    assert.equal(deniedConsentUrl.searchParams.has("code"), false);
    const malicious = new URL(url);
    malicious.searchParams.set("redirect_uri", "https://evil.test/callback");
    assert.equal(
      (
        await request(malicious.pathname + malicious.search, {
          headers: { Cookie: ownerCookie },
        })
      ).status,
      400,
    );
    const exchange = async (fields: Record<string, string>) =>
      request("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          ...fields,
        }).toString(),
      });
    const fields = {
      grant_type: "authorization_code",
      code: redirect.searchParams.get("code")!,
      redirect_uri: client.redirect_uris[0],
      code_verifier: verifier,
      resource: origin + "/mcp",
    };
    assert.equal(
      (
        await exchange({
          ...fields,
          code_verifier: randomBytes(32).toString("base64url"),
        })
      ).status,
      400,
    );
    const exchanged = await exchange(fields);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = (await exchanged.json()) as any;
    assert.equal((await exchange(fields)).status, 400);
    const secret = randomBytes(32).toString("hex");
    const instance: Instance = {
      instanceId: "test",
      label: "Test runtime",
      kind: "codex",
      fingerprint: "a".repeat(64),
      scope: {},
      backendVersion: "0.160.1",
      capabilityRevision: "test",
      available: true,
    };
    const pair = (await (
      await request(
        "/pairings",
        json({
          digest: await digest(secret),
          label: "Test device",
          instances: [instance],
        }),
      )
    ).json()) as any;
    const device = await admin("/api/admin/pairings/approve", {
      code: pair.code,
      digest: await digest(secret),
    });
    const poll = await request("/pairings/poll", {
      ...json({ code: pair.code }),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + pair.pollSecret,
      },
    });
    assert.equal(((await poll.json()) as any).deviceId, device.deviceId);
    await runtime.close();
    runtime = await startServer(config, ADMIN_SECRET);
    const state = await admin("/api/admin/state");
    assert.equal(state.devices[0].id, device.deviceId);
    const ws = new WebSocket(base().replace("http:", "ws:") + "/connect", {
      headers: {
        Host: new URL(origin).host,
        Authorization: "Bearer " + secret,
        "Siyin-Device-Id": device.deviceId,
        "Siyin-Protocol": "1",
      },
    });
    t.after(() => ws.terminate());
    await once(ws, "open");
    const welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", instances: [instance] }));
    assert.equal(JSON.parse((await welcome)[0].toString()).type, "welcome");
    const adapterConfig = instanceConfigSchema.parse({
      id: "test",
      label: "Test runtime",
      kind: "codex",
      binary: resolve("tests/fixtures/codex-backend.mjs"),
      cwd: dataDir,
      home: dataDir,
      mode: "managed-stdio",
    });
    if (adapterConfig.kind !== "codex") throw Error();
    const adapter = new CodexAdapter(adapterConfig);
    await adapter.init();
    t.after(() => adapter.close());
    ws.on("message", async (raw) => {
      const p = JSON.parse(raw.toString());
      if (p.type !== "call") return;
      let outcome;
      try {
        outcome =
          p.method === "siyin.describe"
            ? accepted(describe(adapter, p.params))
            : await adapter.call(p.method, p.params);
      } catch (error) {
        outcome = asOutcome(error);
      }
      ws.send(
        JSON.stringify({
          v: 1,
          type: outcome.error ? "error" : "result",
          requestId: p.requestId,
          outcome,
        }),
      );
    });
    const mcp = new Client({ name: "integration", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(origin + "/mcp"),
      {
        requestInit: {
          headers: { Authorization: "Bearer " + tokens.access_token },
        },
        fetch: async (input, init) => {
          const u = new URL(String(input));
          return request(u.pathname + u.search, init);
        },
      },
    );
    await mcp.connect(transport);
    const tools = await mcp.listTools();
    assert.deepEqual(tools.tools.map((v) => v.name).sort(), [
      "instance_describe",
      "instances_list",
      "runtime_call",
    ]);
    const listed = await mcp.callTool({
      name: "instances_list",
      arguments: {},
    });
    assert.match(JSON.stringify(listed), /Test runtime/);
    const result = await mcp.callTool({
      name: "runtime_call",
      arguments: {
        deviceId: device.deviceId,
        instanceId: "test",
        method: "thread/list",
        params: {},
      },
    });
    assert.match(JSON.stringify(result), /canAcceptDirectInput/);
    const call = async (method: string, params = {}) => {
      const response = await mcp.callTool({
        name: "runtime_call",
        arguments: {
          deviceId: device.deviceId,
          instanceId: "test",
          method,
          params,
        },
      });
      assert.equal(response.isError, false, JSON.stringify(response));
      return JSON.parse((response.content as any)[0].text).result;
    };
    const info = await mcp.callTool({
      name: "instance_describe",
      arguments: {
        deviceId: device.deviceId,
        instanceId: "test",
        method: "management.threads.send",
      },
    });
    assert.match(JSON.stringify(info), /managementVersion/);
    const services = await call("management.services.list");
    const created = await call("management.threads.create", {
      serviceRef: services.items[0].serviceRef,
    });
    const sent = await call("management.threads.send", {
      threadRef: created.thread.threadRef,
      text: "Integration fixture",
    });
    assert.equal(sent.native.turn.id, "turn");
    await call("management.threads.interrupt", {
      threadRef: created.thread.threadRef,
    });
    const observed = await call("management.threads.observe", {
      threadRef: created.thread.threadRef,
      limit: 50,
    });
    assert.equal(observed.gap, false);
    assert.ok(observed.items.some((i: any) => i.type === "turn/completed"));

    // A temporarily absent instance must still have its retained approval revoked.
    let changed = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "instances_changed", instances: [] }));
    await changed;
    await admin("/api/admin/revoke", {
      kind: "instance",
      id: device.deviceId,
      instanceId: "test",
    });
    changed = once(ws, "message");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "instances_changed",
        instances: [instance],
      }),
    );
    await changed;
    const reappeared = await mcp.callTool({
      name: "runtime_call",
      arguments: {
        deviceId: device.deviceId,
        instanceId: "test",
        method: "thread/list",
      },
    });
    assert.equal(reappeared.isError, true);
    await admin("/api/admin/revoke", { kind: "device", id: device.deviceId });
    const denied = await mcp.callTool({
      name: "runtime_call",
      arguments: {
        deviceId: device.deviceId,
        instanceId: "test",
        method: "thread/list",
      },
    });
    assert.equal(denied.isError, true);
    await mcp.close();
    const refreshed = await exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const next = (await refreshed.json()) as any;
    assert.equal(
      (
        await exchange({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/mcp", {
          ...json({}),
          headers: {
            Authorization: "Bearer " + next.access_token,
            "Content-Type": "application/json",
          },
        })
      ).status,
      401,
    );
  },
);

test("forwarded client addresses are trusted only with an explicit single-proxy configuration", async () => {
  for (const trustedProxy of [false, true]) {
    const dataDir = await mkdtemp(join(tmpdir(), "agenvo-proxy-"));
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const runtime = await startServer(
      {
        origin: "https://127.0.0.1:" + port,
        dataDir,
        host: "127.0.0.1",
        port,
        trustedProxy,
      },
      ADMIN_SECRET,
    );
    try {
      const pair = (address: string) =>
        fetch("http://127.0.0.1:" + port + "/pairings", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": address,
          },
          body: JSON.stringify({
            digest: "a".repeat(64),
            label: "Test",
            instances: [],
          }),
        });
      for (let i = 0; i < 10; i++)
        assert.equal((await pair("192.0.2.1")).status, 201);
      assert.equal((await pair("192.0.2.1")).status, 429);
      assert.equal((await pair("192.0.2.2")).status, trustedProxy ? 201 : 429);
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});
