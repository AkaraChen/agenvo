#!/usr/bin/env node
// Protocol fixture for control-plane edge cases. Not a real Codex runtime.
import readline from "node:readline";
if (process.argv.includes("--version")) {
  // Keep this outside the schema baseline so protocol tests catch version gates.
  console.log("codex-cli 0.161.0");
  process.exit(0);
}
const requests = [
  {
    method: "item/tool/requestUserInput",
    params: {
      threadId: "t",
      turnId: "turn",
      questions: [
        {
          id: "label",
          header: "Label",
          question: "Pick a label",
          options: [
            { label: "Alpha", description: "First" },
            { label: "Beta", description: "Second" },
          ],
        },
      ],
    },
  },
  {
    method: "item/fileChange/requestApproval",
    params: { threadId: "t", turnId: "turn", itemId: "file", startedAtMs: 1 },
  },
  {
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "cmd",
      cwd: process.cwd(),
      additionalPermissions: { fileSystem: { write: [process.cwd()] } },
      startedAtMs: 1,
      availableDecisions: ["accept", "decline", "cancel"],
    },
  },
  {
    method: "item/permissions/requestApproval",
    params: {
      threadId: "t",
      turnId: "turn",
      itemId: "perm",
      cwd: process.cwd(),
      permissions: { fileSystem: { write: [process.cwd()] } },
      startedAtMs: 1,
    },
  },
  {
    method: "item/tool/call",
    params: {
      threadId: "t",
      turnId: "turn",
      callId: "tool",
      tool: "test",
      arguments: {},
    },
  },
  { method: "account/chatgptAuthTokens/refresh", params: {} },
];
let responses = [];
let calls = [];
const thread = {
  id: "t",
  cwd: process.cwd(),
  status: { type: "idle" },
  canAcceptDirectInput: true,
};
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const packet = JSON.parse(line);
  if (!packet.method) {
    responses.push(packet);
    return;
  }
  if (packet.id === undefined) return;
  calls.push({ method: packet.method, params: packet.params });
  let result = {};
  if (packet.method === "thread/start") {
    result = { thread };
    send({
      method: "item/started",
      params: {
        threadId: "t",
        turnId: "turn",
        item: {
          id: "file",
          type: "fileChange",
          status: "inProgress",
          changes: [
            {
              path: process.cwd() + "/new.txt",
              kind: { type: "add" },
              diff: "+hello",
            },
          ],
        },
      },
    });
    requests.forEach((r, i) => send({ id: "native-" + i, ...r }));
  }
  if (packet.method === "thread/items/list")
    result = {
      data: [
        {
          turnId: "turn",
          item: {
            id: "file",
            type: "fileChange",
            status: "inProgress",
            changes: [
              {
                path: process.cwd() + "/new.txt",
                kind: { type: "add" },
                diff: "+hello",
              },
            ],
          },
        },
      ],
      nextCursor: null,
    };
  if (packet.method === "thread/list")
    send({
      method: "item/fileChange/patchUpdated",
      params: {
        threadId: "t",
        turnId: "turn",
        itemId: "file",
        changes: [
          {
            path: process.cwd() + "/new.txt",
            kind: { type: "add" },
            diff:
              packet.params?.searchTerm === "oversize"
                ? "中".repeat(30000)
                : "+updated",
          },
        ],
      },
    });
  if (packet.method === "thread/read") result = { responses, calls, thread };
  if (packet.method === "thread/list")
    result = { data: [thread], nextCursor: null };
  if (["thread/resume", "thread/unarchive"].includes(packet.method))
    result = { thread };
  if (
    packet.method === "thread/turns/list" &&
    packet.params.itemsView === "notLoaded"
  ) {
    result = {
      data: [
        {
          id: "turn",
          status:
            thread.status.type === "active" ? "inProgress" : "interrupted",
        },
      ],
      nextCursor: null,
    };
  } else if (packet.method === "thread/turns/list") {
    send({
      id: packet.id,
      error: { code: -32600, message: "list_turns is not supported yet" },
    });
    return;
  }
  if (packet.method === "turn/start") {
    thread.status = { type: "active", activeFlags: [] };
    result = { turn: { id: "turn", status: "inProgress", items: [] } };
    send({ method: "turn/started", params: { threadId: "t", ...result } });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "t",
        turnId: "turn",
        itemId: "m",
        delta: "Fixture output",
      },
    });
  }
  if (packet.method === "turn/steer") {
    if (packet.params.expectedTurnId !== "turn") {
      send({
        id: packet.id,
        error: { code: -32600, message: "Turn mismatch" },
      });
      return;
    }
    result = { turnId: "turn" };
  }
  if (packet.method === "turn/interrupt") {
    thread.status = { type: "idle" };
    send({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "turn", status: "interrupted" } },
    });
  }
  send({ id: packet.id, result });
});
