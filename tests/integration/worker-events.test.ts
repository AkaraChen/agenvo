import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket from "ws";
import { Webhook } from "standardwebhooks";
import { digest } from "@agenvo/protocol";
import { until, isolatedEnvironment } from "../support/environment.js";

test(
  "workerd MCP events persist in a Durable Object and alarms deliver signed callbacks",
  { timeout: 45000 },
  async (t) => {
    const dir = await mkdtemp("/tmp/agenvo-workerd-events-");
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        "dev",
        "--config",
        "tests/wrangler.jsonc",
        "--ip",
        "127.0.0.1",
        "--port",
        "0",
        "--inspector-port",
        "0",
        "--persist-to",
        dir,
      ],
      {
        env: { ...isolatedEnvironment(dir), WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "";
    child.stdout.on("data", (c) => {
      log += c;
    });
    child.stderr.on("data", (c) => {
      log += c;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGTERM");
        await exit;
      }
      await rm(dir, { recursive: true, force: true });
    });
    const ready = await until(
      () => log,
      (s) => /Ready on (http:\/\/[^\s]+)/.test(s),
      20000,
    );
    const origin = /Ready on (http:\/\/[^\s]+)/
      .exec(ready)![1]
      .replace("localhost", "127.0.0.1");
    const fixture = async (method: string, ...args: unknown[]) => {
      const r = await fetch(origin + "/fixture", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json() as Promise<any>;
    };
    const secret = "whsec_" + Buffer.alloc(32, 5).toString("base64");
    const events: any[] = [];
    let fail = true;
    const receiver = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const p: any = new Webhook(secret).verify(
        body,
        req.headers as Record<string, string>,
      );
      if (p.type === "verification")
        res.end(JSON.stringify({ challenge: p.challenge }));
      else {
        events.push(p);
        res.statusCode = fail ? 503 : 200;
        fail = false;
        res.end();
      }
    }).listen(0, "127.0.0.1");
    await once(receiver, "listening");
    t.after(() => new Promise<void>((done) => receiver.close(() => done())));
    const url = `https://127.0.0.1:${(receiver.address() as { port: number }).port}/events`;
    await fixture("registerGrant", "fixture-grant", "fixture-client");
    const instance = {
      instanceId: "runtime",
      label: "Test",
      kind: "herdr",
      fingerprint: "a".repeat(64),
      scope: {},
      backendVersion: "0.9.3",
      capabilityRevision: "test",
      available: true,
    };
    const pair = await fixture(
      "createPairing",
      {
        digest: await digest("test-device"),
        label: "Test",
        instances: [instance],
      },
      "test",
    );
    const device = await fixture(
      "approvePairing",
      pair.code,
      await digest("test-device"),
    );
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/connect", {
      headers: {
        Authorization: "Bearer test-device",
        "Siyin-Device-Id": device.deviceId,
        "Siyin-Protocol": "1",
      },
    });
    t.after(() => ws.terminate());
    await once(ws, "open");
    const welcome = once(ws, "message");
    ws.send(JSON.stringify({ v: 1, type: "hello", instances: [instance] }));
    await welcome;
    const rpc = async (method: string, params = {}) => {
      const r = await fetch(origin + "/fixture-mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": method,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "fixture",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const p: any = await r.json();
      assert.equal(r.status, 200, JSON.stringify(p));
      assert.equal(p.error, undefined, JSON.stringify(p) + "\n" + log);
      return p.result;
    };
    assert.deepEqual((await rpc("server/discover")).capabilities.events, {});
    const subscription = {
      name: "runtime.changed",
      arguments: { deviceId: device.deviceId, instanceId: "runtime" },
      delivery: { mode: "webhook", url, secret },
      cursor: null,
    };
    await rpc("events/subscribe", subscription);
    const event = {
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      serviceId: "test",
      threadId: "pane",
      nativeType: "pane.agent_status_changed",
      native: { agent_status: "blocked" },
    };
    ws.send(
      JSON.stringify({
        v: 1,
        type: "runtime_event",
        instanceId: "runtime",
        fingerprint: instance.fingerprint,
        event,
      }),
    );
    await until(
      () => events,
      (e) => e.length >= 2,
      15000,
    ).catch(async (error) => {
      throw new Error(
        JSON.stringify(await fixture("eventDiagnostics")) + "\n" + log,
        { cause: error },
      );
    });
    assert.equal(events[0].eventId, events[1].eventId);
    assert.equal(events[1].data.native.agent_status, "blocked");
    await rpc("events/unsubscribe", {
      name: subscription.name,
      arguments: subscription.arguments,
      delivery: { mode: "webhook", url },
    });
    const count = events.length;
    ws.send(
      JSON.stringify({
        v: 1,
        type: "runtime_event",
        instanceId: "runtime",
        fingerprint: instance.fingerprint,
        event: { ...event, eventId: crypto.randomUUID() },
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(events.length, count);
  },
);
