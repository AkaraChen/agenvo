import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { signOwnerRequest } from "../../src/cli/owner-key.ts";
import { digest } from "../../src/protocol/index.ts";

test(
  "actual Worker routes enforce pairing, epochs, byte bounds and revocation",
  { timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agenvo-worker-test-"));
    const ownerKeys = await generateKeyPair("ES256", { extractable: true });
    const ownerPrivate = await exportJWK(ownerKeys.privateKey);
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        "tests/wrangler.jsonc",
        "--var",
        "OWNER_PUBLIC_KEY:" +
          JSON.stringify(await exportJWK(ownerKeys.publicKey)),
        "--ip",
        "127.0.0.1",
        "--port",
        "0",
        "--persist-to",
        dir,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const base = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(output)), 20000);
      const read = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/Ready on (http:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1].replace("localhost", "127.0.0.1"));
        }
      };
      child.stdout.on("data", read);
      child.stderr.on("data", read);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(output));
      });
    });
    const mf = {
      dispatchFetch: (url: string, init?: RequestInit) =>
        fetch(base + new URL(url).pathname, init).catch((error) => {
          throw new Error(
            "HTTP test failed at " +
              new URL(url).pathname +
              " " +
              String(init?.method ?? "GET"),
            { cause: error },
          );
        }),
    };
    t.after(async () => {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
      await rm(dir, { recursive: true, force: true });
    });
    const fixture = async (method: string, ...args: unknown[]) => {
      const r = await mf.dispatchFetch("https://agenvo.test/fixture", {
        method: "POST",
        body: JSON.stringify({ method, args }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<any>;
    };
    for (const [value, status] of [
      [{ kind: "grant", id: "missing" }, 404],
      [{ kind: "device", id: "missing" }, 404],
      [{ kind: "instance", id: "missing" }, 400],
      [{ kind: "instance", id: "missing", instanceId: "missing" }, 404],
    ] as const) {
      const body = JSON.stringify(value),
        path = "/api/admin/revoke";
      const token = await signOwnerRequest(
        ownerPrivate,
        "https://agenvo.test",
        "POST",
        path,
        body,
      );
      const response = await mf.dispatchFetch("https://agenvo.test" + path, {
        method: "POST",
        headers: { Authorization: "Bearer " + token },
        body,
      });
      assert.equal(response.status, status, await response.text());
    }
    const cliConsent = await mf.dispatchFetch("https://agenvo.test/authorize");
    assert.equal(cliConsent.status, 200);
    assert.match(await cliConsent.text(), /agenvo client inspect/);
    const registration = await mf.dispatchFetch(
      "https://agenvo.test/oauth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Integration test",
          redirect_uris: ["http://127.0.0.1:8899/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      },
    );
    assert.equal(registration.status, 201);
    const client = (await registration.json()) as any;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorization = new URL(base + "/authorize");
    authorization.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:8899/callback",
      response_type: "code",
      scope: "runtime:approved",
      state: "test-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "https://agenvo.test/mcp",
    }).toString();
    const consent = await fetch(authorization, {
      headers: { "x-test-owner": "local-owner" },
    });
    assert.equal(consent.status, 200);
    const consentHtml = await consent.text();
    const handle = /name="handle" value="([^"]+)"/.exec(consentHtml)![1];
    const cookie = consent.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const approved = await fetch(base + "/authorize", {
      method: "POST",
      redirect: "manual",
      headers: {
        "x-test-owner": "local-owner",
        Origin: "https://agenvo.test",
        Cookie: cookie,
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    assert.equal(approved.status, 302, await approved.clone().text());
    const authUrl = new URL(authorization);
    authUrl.protocol = "https:";
    authUrl.host = "agenvo.test";
    authUrl.port = "";
    const cliAuthorization = async (
      action: string,
      patch: Record<string, unknown> = {},
      purpose: "pairing" | "oauth" = "oauth",
    ) => {
      const path = "/api/admin/authorization/" + action;
      const body = JSON.stringify({
        authorizationUrl: authUrl.href,
        ...(action === "approve"
          ? {
              clientId: client.client_id,
              redirectUri: "http://127.0.0.1:8899/callback",
            }
          : {}),
        ...patch,
      });
      const signed = await signOwnerRequest(
        ownerPrivate,
        "https://agenvo.test",
        "POST",
        path,
        body,
        purpose,
      );
      return mf.dispatchFetch("https://agenvo.test" + path, {
        method: "POST",
        body,
        headers: { Authorization: "Bearer " + signed },
      });
    };
    const inspected = await cliAuthorization("inspect");
    assert.equal(inspected.status, 200);
    assert.equal(((await inspected.json()) as any).clientId, client.client_id);
    assert.equal(
      (await cliAuthorization("approve", {}, "pairing")).status,
      403,
    );
    assert.equal(
      (await cliAuthorization("approve", { clientId: "other" })).status,
      403,
    );
    assert.equal(
      (
        await cliAuthorization("approve", {
          redirectUri: "https://evil.test/callback",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await cliAuthorization("approve", {
          authorizationUrl: authUrl.href.replace("agenvo.test", "evil.test"),
        })
      ).status,
      400,
    );
    const cliApproved = await cliAuthorization("approve");
    assert.equal(cliApproved.status, 200, await cliApproved.clone().text());
    assert.equal(cliApproved.headers.get("cache-control"), "no-store");
    const code = new URL(
      ((await cliApproved.json()) as any).redirectTo,
    ).searchParams.get("code")!;
    const exchange = () =>
      fetch(base + "/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: "http://127.0.0.1:8899/callback",
          resource: "https://agenvo.test/mcp",
        }),
      });
    const exchanged = await exchange();
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const tokens = (await exchanged.json()) as any;
    assert.ok(tokens.access_token);
    const refresh = () =>
      fetch(base + "/oauth/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: tokens.refresh_token,
        }),
      });
    const renewed = await refresh();
    assert.equal(
      renewed.status,
      200,
      renewed.status === 200 ? "" : await renewed.clone().text(),
    );
    Object.assign(tokens, await renewed.json());
    const toolsCall = (token: string) =>
      fetch(base + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "instances_list", arguments: {} },
        }),
      });
    const oauthCall = await toolsCall(tokens.access_token);
    assert.equal(oauthCall.status, 200, await oauthCall.clone().text());
    assert.match(await oauthCall.text(), /accepted/);
    const grants = (await fixture("adminState")).grants;
    assert.equal(grants.length, 1);
    await fixture("revoke", "grant", grants[0].id);
    const deniedCall = await toolsCall(tokens.access_token);
    assert.equal(deniedCall.status, 200);
    assert.match(await deniedCall.text(), /permission_denied/);
    assert.equal((await refresh()).status, 400);
    assert.equal((await exchange()).status, 400);
    // CSRF is rejected even when the identity verifier has accepted the owner.
    const csrf = await fetch(base + "/admin/revoke", {
      method: "POST",
      headers: { "x-test-owner": "local-owner", Origin: "https://other.test" },
      body: new URLSearchParams({ kind: "grant", id: grants[0].id }),
    });
    assert.equal(csrf.status, 403);
    const secret = "a".repeat(64);
    const fingerprint = "b".repeat(64);
    const instance = {
      instanceId: "work",
      kind: "herdr",
      label: "Work",
      fingerprint,
      scope: {},
      backendVersion: "0.9.3",
      capabilityRevision: "test",
      available: true,
    };
    const pairing: any = await (
      await mf.dispatchFetch("https://agenvo.test/pairings", {
        method: "POST",
        body: JSON.stringify({
          digest: await digest(secret),
          label: "Test",
          instances: [instance],
        }),
      })
    ).json();
    assert.ok(pairing.pollSecret);
    const cancelled = await fixture(
      "createPairing",
      {
        digest: await digest("cancel"),
        label: "Cancelled",
        instances: [instance],
      },
      "cancel-test",
    );
    await fixture("cancelPairing", cancelled.code, cancelled.pollSecret);
    assert.equal(
      (await fixture("adminState")).pairings.some(
        (p: any) => p.code === cancelled.code,
      ),
      false,
    );
    const apiPath = "/api/admin/pairings/approve";
    const approvalBody = JSON.stringify({
      code: pairing.code,
      digest: await digest(secret),
    });
    const approvalToken = await signOwnerRequest(
      ownerPrivate,
      "https://agenvo.test",
      "POST",
      apiPath,
      approvalBody,
    );
    for (const unauthorized of [
      "",
      secret,
      pairing.pollSecret,
      tokens.access_token,
    ]) {
      const response = await mf.dispatchFetch("https://agenvo.test" + apiPath, {
        method: "POST",
        headers: { Authorization: "Bearer " + unauthorized },
        body: approvalBody,
      });
      assert.equal(response.status, 403);
    }
    const listed = await mf.dispatchFetch(
      "https://agenvo.test/api/admin/pairings",
      {
        headers: {
          Authorization:
            "Bearer " +
            (await signOwnerRequest(
              ownerPrivate,
              "https://agenvo.test",
              "GET",
              "/api/admin/pairings",
            )),
        },
      },
    );
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const pending = ((await listed.json()) as any).pairings;
    assert.ok(pending.some((p: any) => p.code === pairing.code));
    assert.ok(pending.every((p: any) => !p.pollDigest && !p.pollSecret));
    const mismatchedBody = JSON.stringify({
      code: pairing.code,
      digest: "0".repeat(64),
    });
    const mismatch = await mf.dispatchFetch("https://agenvo.test" + apiPath, {
      method: "POST",
      body: mismatchedBody,
      headers: {
        Authorization:
          "Bearer " +
          (await signOwnerRequest(
            ownerPrivate,
            "https://agenvo.test",
            "POST",
            apiPath,
            mismatchedBody,
          )),
      },
    });
    assert.equal(mismatch.status, 400);
    assert.equal(
      ((await mismatch.json()) as any).error.code,
      "pairing_expired",
    );
    const approve = () =>
      mf.dispatchFetch("https://agenvo.test" + apiPath, {
        method: "POST",
        headers: { Authorization: "Bearer " + approvalToken },
        body: approvalBody,
      });
    const pairingApproved = await approve();
    assert.equal(
      pairingApproved.status,
      200,
      await pairingApproved.clone().text(),
    );
    const { deviceId } = (await pairingApproved.json()) as any;
    assert.equal((await approve()).status, 400); // Replaying cannot create a second device.
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer " + approvalToken },
          body: "{}",
        })
      ).status,
      401,
    );
    const poll = () =>
      mf.dispatchFetch("https://agenvo.test/pairings/poll", {
        method: "POST",
        headers: { Authorization: "Bearer " + pairing.pollSecret },
        body: JSON.stringify({ code: pairing.code }),
      });
    assert.equal(((await (await poll()).json()) as any).deviceId, deviceId);
    assert.equal((await poll()).status, 400);
    assert.equal(
      (await mf.dispatchFetch("https://agenvo.test/admin")).status,
      503,
    );
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/mcp", {
          method: "POST",
          headers: { Authorization: "Bearer " + secret },
          body: "{}",
        })
      ).status,
      401,
    );
    const connect = async () => {
      const ws = new WebSocket(base.replace("http:", "ws:") + "/connect", {
        headers: {
          Authorization: "Bearer " + secret,
          "Siyin-Device-Id": deviceId,
          "Siyin-Protocol": "1",
        },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const ready = new Promise<void>((resolve) => {
        ws.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "welcome") resolve();
        });
      });
      ws.send(JSON.stringify({ v: 1, type: "hello", instances: [instance] }));
      await ready;
      return ws;
    };
    await fixture("registerGrant", "grant1", "client1");
    const ws = await connect();
    const nextCall = () =>
      new Promise<any>((resolve) => {
        const listener = (event: any) => {
          const p = JSON.parse(event.data);
          if (p.type === "call") {
            ws.removeEventListener("message", listener);
            resolve(p);
          }
        };
        ws.addEventListener("message", listener);
      });
    const input = {
      deviceId,
      instanceId: "work",
      method: "pane.run",
      params: {},
    };
    const packet = nextCall();
    const result = fixture("call", "grant1", input);
    const p = await packet;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: "wrong",
        outcome: { execution: "accepted", result: "wrong" },
      }),
    );
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: p.requestId,
        outcome: { execution: "accepted", result: "correct" },
      }),
    );
    assert.equal((await result).result, "correct");
    const bigPacket = nextCall();
    const big = fixture("call", "grant1", input);
    const bp = await bigPacket;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: bp.requestId,
        outcome: { execution: "accepted", result: "中".repeat(23000) },
      }),
    );
    assert.equal((await big).error.code, "result_too_large");
    const revokedPacket = nextCall();
    const revoked = fixture("call", "grant1", input);
    await revokedPacket;
    await fixture("revoke", "grant", "grant1");
    const revokeResult = await revoked;
    assert.equal(revokeResult.error.code, "permission_denied");
    assert.equal(revokeResult.execution, "unknown");
    assert.equal(
      (await fixture("call", "grant1", input)).execution,
      "not_started",
    );
    await fixture("registerGrant", "grant2", "client2");
    const full = new Promise<void>((resolve) => {
      let received = 0;
      const listener = (raw: any) => {
        if (JSON.parse(raw.toString()).type === "call" && ++received === 16) {
          ws.off("message", listener);
          resolve();
        }
      };
      ws.on("message", listener);
    });
    const occupied = Array.from({ length: 16 }, () =>
      fixture("call", "grant2", input),
    );
    await full;
    assert.equal(
      (await fixture("call", "grant2", input)).error.code,
      "resource_exhausted",
    );
    await fixture("revoke", "instance", deviceId, "work");
    assert.ok(
      (await Promise.all(occupied)).every(
        (r: any) =>
          r.execution === "unknown" && r.error.code === "permission_denied",
      ),
    );
    assert.equal(
      (await fixture("call", "grant2", input)).execution,
      "not_started",
    );
    await fixture("approveInstance", deviceId, "work", fingerprint);
    // A timed-out write is unknown, and its late result cannot settle another call.
    const timeoutPacket = nextCall();
    const timedOut = fixture("call", "grant2", input);
    const timed = await timeoutPacket;
    assert.equal((await timedOut).execution, "unknown");
    ws.send(
      JSON.stringify({
        v: 1,
        type: "result",
        requestId: timed.requestId,
        outcome: { execution: "accepted", result: "late" },
      }),
    );
    const oldPacket = nextCall();
    const oldCall = fixture("call", "grant2", input);
    await oldPacket;
    const replacement = await connect();
    assert.equal((await oldCall).execution, "unknown");
    await fixture("revoke", "device", deviceId);
    assert.equal(
      (
        await mf.dispatchFetch("https://agenvo.test/connect", {
          headers: {
            Authorization: "Bearer " + secret,
            "Siyin-Device-Id": deviceId,
            "Siyin-Protocol": "1",
          },
        })
      ).status,
      401,
    );
    replacement.close();
  },
);
