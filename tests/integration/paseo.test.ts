import test from "node:test";
import assert from "node:assert/strict";
import { paseoFixture } from "../fixtures/paseo-daemon.js";
import { eventsLab } from "../support/events-lab.js";
import { until } from "../support/environment.js";

test(
  "Paseo MCP attachment preserves native input, history, interactions and reconnect uncertainty",
  { timeout: 45000 },
  async (t) => {
    const lab = await eventsLab(t);
    const daemon = await paseoFixture();
    lab.cleanup(() => daemon.close());
    const external = daemon.add();
    const device = await lab.connect([
      {
        id: "paseo",
        kind: "paseo",
        label: "Isolated Paseo",
        endpoint: daemon.endpoint,
        serverId: daemon.serverId,
      },
    ]);
    const call = (method: string, params = {}) =>
      lab.call(device, "paseo", method, params);
    const outcome = async (method: string, params = {}) =>
      JSON.parse(
        (
          await lab.rpc("tools/call", {
            name: "runtime_call",
            arguments: {
              deviceId: device,
              instanceId: "paseo",
              method,
              params,
            },
          })
        ).content[0].text,
      );
    await lab.rpc("events/subscribe", lab.subscription(device, "paseo"));
    const discover = async () => {
      const service = (await call("management.services.list")).items[0];
      const list = await call("management.threads.list", {
        serviceRef: service.serviceRef,
      });
      return {
        service,
        thread: list.items.find((x: any) => x.threadId === external.id),
      };
    };
    const { service, thread } = await discover();
    assert.equal(thread.threadId, external.id);
    assert.equal(
      daemon.requests.filter(
        (p) => p.type === "fetch_agents_request" && p.subscribe,
      ).length,
      1,
    );
    const created = await call("management.threads.create", {
      serviceRef: service.serviceRef,
      providerOptions: {
        provider: "codex",
        cwd: "/fixture",
        title: "Created through MCP",
      },
    });
    assert.ok(created.thread.threadId);
    const create = daemon.requests.find(
      (p) => p.type === "create_agent_request",
    );
    assert.equal(create.initialPrompt, undefined);
    assert.equal(create.config.modeId, "full-access");
    const observe = await call("management.threads.observe", {
      threadRef: thread.threadRef,
    });
    await call("management.threads.send", {
      threadRef: thread.threadRef,
      text: "Continue external work",
      providerOptions: { activeTurnBehavior: "steer" },
    });
    const send = daemon.requests.find(
      (p) => p.type === "send_agent_message_request",
    );
    assert.equal(send.agentId, external.id);
    assert.equal(send.activeTurnBehavior, "steer");
    assert.ok(send.messageId);
    assert.equal(external.currentModeId, "full-access");
    await until(
      () => lab.received,
      (items) => items.some((e) => e.data.nativeType === "turn_completed"),
    );
    const observed = await call("management.threads.observe", {
      threadRef: thread.threadRef,
      cursor: observe.nextCursor,
    });
    assert.ok(observed.items.some((x: any) => x.type === "turn_completed"));
    external.pendingPermissions = [
      { id: "tool-1", provider: "codex", kind: "tool", name: "Run", input: {} },
    ];
    daemon.stream(external.id, {
      type: "permission_requested",
      provider: "codex",
      request: external.pendingPermissions[0],
    });
    await until(
      () => external.pendingPermissions.length,
      (n) => n === 0,
    );
    const permission = daemon.requests.find(
      (p) => p.type === "agent_permission_response",
    );
    assert.equal(permission.response.behavior, "allow");
    const history = await call("management.threads.read", {
      threadRef: thread.threadRef,
    });
    assert.match(JSON.stringify(history.items), /FIXTURE_HISTORY/);
    daemon.replaceHistory(external.id);
    assert.equal(
      (
        await outcome("management.threads.read", {
          threadRef: thread.threadRef,
          cursor: history.nextCursor,
        })
      ).error.code,
      "invalid_cursor",
    );
    assert.equal(
      (
        await call("management.threads.observe", {
          threadRef: thread.threadRef,
          cursor: observed.nextCursor,
        })
      ).gap,
      true,
    );
    external.pendingPermissions = [
      {
        id: "question-1",
        provider: "codex",
        kind: "question",
        name: "Question",
        input: { question: "Which target?" },
      },
    ];
    daemon.stream(external.id, {
      type: "permission_requested",
      provider: "codex",
      request: external.pendingPermissions[0],
    });
    const pending = await call("management.interactions.list", {
      threadRef: thread.threadRef,
    });
    assert.equal(pending.items.length, 1);
    assert.equal(
      daemon.requests.some(
        (p) =>
          p.type === "agent_permission_response" &&
          p.requestId === "question-1",
      ),
      false,
    );
    const reply = await call("management.interactions.respond", {
      interactionRef: pending.items[0].interactionRef,
      response: { behavior: "allow", updatedInput: { answer: "fixture" } },
    });
    assert.equal(reply.confirmation, "transport_submitted");
    await until(
      () => external.pendingPermissions.length,
      (n) => n === 0,
    );
    assert.equal(
      (
        await outcome("management.interactions.read", {
          interactionRef: pending.items[0].interactionRef,
        })
      ).error.code,
      "stale_interaction",
    );
    assert.equal(
      (
        await outcome("management.threads.send", {
          threadRef: thread.threadRef,
          text: "UNKNOWN_RECEIPT",
        })
      ).execution,
      "unknown",
    );
    daemon.dropNextSend();
    const lost = await outcome("management.threads.send", {
      threadRef: thread.threadRef,
      text: "Dropped response",
    });
    assert.equal(lost.execution, "unknown");
    await until(
      async () => outcome("management.services.list"),
      (r) => r.execution === "accepted",
      10000,
    );
    assert.equal(
      (await outcome("management.threads.get", { threadRef: thread.threadRef }))
        .error.code,
      "stale_reference",
    );
    const fresh = await discover();
    const after = await call("management.threads.observe", {
      threadRef: fresh.thread.threadRef,
      cursor: observed.nextCursor,
    });
    assert.equal(after.gap, true);
    assert.equal(
      daemon.requests.filter(
        (p) =>
          p.type === "send_agent_message_request" &&
          p.text === "Dropped response",
      ).length,
      1,
    );
    assert.equal(
      (
        await outcome("management.threads.archive", {
          threadRef: fresh.thread.threadRef,
        })
      ).error.code,
      "unsupported_capability",
    );
    await call("paseo.agents.archive", { agentId: external.id });
    assert.equal(external.status, "closed");
    assert.ok(external.archivedAt);
    const archived = await call("paseo.workspaces.archive", {
      workspaceId: "wks_fixture",
    });
    assert.equal(archived.workspaceId, "wks_fixture");
    assert.ok(archived.archivedAt);
    assert.ok(
      daemon.requests.some(
        (p) =>
          p.type === "archive_workspace_request" &&
          p.workspaceId === "wks_fixture",
      ),
    );
  },
);
