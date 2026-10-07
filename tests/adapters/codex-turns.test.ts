import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { CodexAdapter } from "../../src/connector/adapters/codex.js";
import { instanceConfigSchema } from "../../src/connector/config.js";

// Exercise real app-server turn control with a local model endpoint held open.
// No account, external model, tool execution or everyday thread is involved.
for (const mode of ["managed-stdio", "attach-unix"] as const)
  test(
    `native Codex ${mode} accepts steering and reports interruption through management`,
    { timeout: 30000 },
    async (t) => {
      const home = await realpath(await mkdtemp("/tmp/agenvo-native-turn-"));
      let connected!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        connected = resolve;
      });
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
          /* Consume the fixture prompt body. */
        }
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response"}}\n\n',
        );
        connected();
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address() as { port: number };
      const binary = (
        await promisify(execFile)("/bin/sh", ["-c", "command -v codex"])
      ).stdout.trim();
      const config = instanceConfigSchema.parse({
        id: "local",
        label: "Local",
        kind: "codex",
        binary,
        cwd: home,
        home,
        mode,
        ...(mode === "attach-unix"
          ? { socketPath: home + "/native.sock" }
          : {}),
      });
      if (config.kind !== "codex") throw Error();
      let child: ChildProcess | undefined;
      let peer: CodexAdapter | undefined;
      let peerThreadRef: string | undefined;
      const adapter = new CodexAdapter(config);
      t.after(async () => {
        server.closeAllConnections();
        await peer?.close();
        await adapter.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit");
          const timer = setTimeout(() => child?.kill("SIGKILL"), 2000);
          child.kill("SIGTERM");
          try {
            await stopped;
          } finally {
            clearTimeout(timer);
          }
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      });
      if (mode === "attach-unix") {
        child = spawn(
          binary,
          ["app-server", "--listen", "unix://" + home + "/native.sock"],
          { env: { ...process.env, CODEX_HOME: home }, stdio: "ignore" },
        );
        for (let i = 0; i < 100; i++) {
          if (
            await stat(home + "/native.sock").then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await adapter.init();
      assert.equal(adapter.available, true);
      const call = async (name: string, params = {}) =>
        (await adapter.call("management." + name, params)).result as any;
      const serviceRef = (await call("services.list")).items[0].serviceRef;
      const created = await call("threads.create", {
        serviceRef,
        providerOptions: {
          model: "fixture",
          modelProvider: "fixture",
          historyMode: "paginated",
          config: {
            "model_providers.fixture.name": "Local fixture",
            "model_providers.fixture.base_url": `http://127.0.0.1:${address.port}/v1`,
            "model_providers.fixture.wire_api": "responses",
            "model_providers.fixture.requires_openai_auth": false,
            "model_providers.fixture.supports_websockets": false,
          },
        },
      });
      const threadRef = created.thread.threadRef;
      const sent = await call("threads.send", {
        threadRef,
        text: "Wait for further instructions.",
      });
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          requestStarted,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  Error(
                    "Native app-server did not reach the local model endpoint",
                  ),
                ),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      if (mode === "attach-unix") {
        peer = new CodexAdapter({ ...config, id: "peer" });
        await peer.init();
        const services: any = (await peer.call("management.services.list", {}))
          .result;
        const agents: any = (
          await peer.call("management.threads.list", {
            serviceRef: services.items[0].serviceRef,
          })
        ).result;
        const external = agents.items.find(
          (a: any) => a.native.id === created.thread.native.id,
        );
        assert.ok(
          external,
          "A second client discovers the first client's materialized thread",
        );
        peerThreadRef = external.threadRef;
        await peer.call("management.threads.observe", {
          threadRef: external.threadRef,
        });
      }
      await adapter.call("turn/steer", {
        threadId: created.thread.native.id,
        expectedTurnId: sent.native.turn.id,
        input: [{ type: "text", text: "Continue waiting." }],
      });
      await assert.rejects(
        adapter.call("turn/interrupt", {
          threadId: created.thread.native.id,
          turnId: "not-the-active-turn",
        }),
        { code: "native_error" },
        "Native interruption must reject another turn identity",
      );
      await call("threads.interrupt", { threadRef });
      let completed: any;
      for (let i = 0; i < 100; i++) {
        const events = await call("threads.observe", { threadRef, limit: 50 });
        completed = events.items.find(
          (event: any) =>
            event.type === "turn/completed" &&
            event.data.native.turn.id === sent.native.turn.id,
        );
        if (completed) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(completed?.data.native.turn.status, "interrupted");
      if (peer) {
        const events: any = (
          await peer.call("management.threads.observe", {
            threadRef: peerThreadRef,
            limit: 50,
          })
        ).result;
        assert.ok(
          events.items.some(
            (event: any) =>
              event.type === "turn/completed" &&
              event.data.native.turn.id === sent.native.turn.id,
          ),
          "A subscribed second client receives the native completion",
        );
      }
      const history = await call("threads.read", { threadRef });
      assert.equal(history.kind, "conversation_items");
      assert.ok(
        history.items.some((turn: any) => turn.id === sent.native.turn.id),
      );
      await call("threads.resume", { threadRef });
      await call("threads.archive", { threadRef });
      await call("threads.unarchive", { threadRef });
    },
  );
