#!/usr/bin/env node
// Protocol fixture for control-plane edge cases. Not a real Codex runtime.
import readline from "node:readline";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.160.1");
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
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const packet = JSON.parse(line);
  if (!packet.method) {
    responses.push(packet);
    return;
  }
  if (packet.id === undefined) return;
  let result = {};
  if (packet.method === "thread/start") {
    result = { thread: { id: "t" } };
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
  if (packet.method === "thread/read") result = { responses };
  if (packet.method === "turn/interrupt")
    send({
      method: "turn/completed",
      params: { threadId: "t", turn: { id: "turn", status: "interrupted" } },
    });
  send({ id: packet.id, result });
});
