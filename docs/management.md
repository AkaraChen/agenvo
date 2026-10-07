# Manage Agent threads

[简体中文](management.zh-CN.md) · [Usage](usage.md)

Agenvo manages Agent services through Threads: addressable working contexts that accept continued interaction. A Thread maps to a Codex thread or a live Herdr agent. Herdr does not gain persistent conversation history through this mapping. Agenvo has no separate public Run object; native turn identities and outcomes remain in results and events. Accepted input, an idle Thread and a completed native turn are different facts.

## Discover and call

1. Call `instances_list` and select `deviceId` and `instanceId`.
2. Call `instance_describe`. `managementVersion: 1` identifies the common interface. Read `management` for capabilities; paginate `items` or select a `method` to obtain its schema.
3. Call `runtime_call` with an advertised `management.*` method. Native methods remain available for backend-specific operations.

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.services.list",
  "params": {}
}
```

Pass a returned `serviceRef` to `management.threads.list`. Codex discovery includes other clients' threads, across providers and source kinds by default; use `providerOptions` for filters, including archived threads. A Herdr instance can contain several independent sessions: choose an explicit returned service. An endpoint found on disk is `unprobed`, not assumed reachable.

References are opaque and bound to a Connector adapter incarnation. Copy them verbatim. Rediscover objects after restart or Codex connection reset; native identities remain in results. A Thread reference cannot substitute for an interaction reference.

## Create and send input

`management.threads.create` takes `serviceRef` and backend-specific `providerOptions` described in its schema. Codex options include model and history mode. Herdr requires an existing pane, name and Agent kind; create a workspace through native methods first if needed. Full-access launches support Codex, Claude and Devin; other existing Agent kinds remain discoverable. The Connector does not start Herdr servers.

Creation does not send a prompt. Codex returns `thread.threadRef`. Herdr returns `execution: starting` with `result.query`; poll that query and use the live `thread.threadRef` when available. Check workspace ownership and contents before cleanup after a failed start.

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.threads.send",
  "params": { "threadRef": "RETURNED_THREAD_REFERENCE", "text": "Inspect the failing tests." }
}
```

Common input is text. `send` retains native busy-input behavior; it does not promise a new turn or a next-turn queue. Its result confirms input submission, not task completion. Codex includes the native turn response under `native`; callers do not need a separate execution reference to observe progress.

## Observe one Thread

```json
{
  "deviceId": "DEVICE_ID",
  "instanceId": "coding",
  "method": "management.threads.observe",
  "params": { "threadRef": "RETURNED_THREAD_REFERENCE", "limit": 20 }
}
```

The response contains:

| Field | Meaning |
| --- | --- |
| `thread` | Current activity, native state and observation time; idle is not business success |
| `items` | Events observed for this Thread, including output and native completion/failure |
| `interactions` | Codex pending-request summaries with `interactionRef`; Herdr reports `supported: false` |
| `nextCursor`, `caughtUp` | Incremental event position and whether the current buffer was exhausted |
| `gap` | Earlier events may be missing; consult current state and available native history |
| `coverage` | Source and completeness of the observations |

Poll with the returned `nextCursor`, including after `caughtUp: true`. Cursors are bound to a Thread; using one for another Thread fails with `invalid_cursor`. State, pending requests and events are sampled separately, not as one atomic snapshot. A pending interaction can expire before you answer it.

For Codex, the first observation resumes and subscribes to the Thread if this connection is not already subscribed. This sends no prompt, but reloads the context with full-access settings; the method is advertised as **not read-only**. Subscription failure is returned explicitly. Subsequent polls read metadata, pending requests and received native notifications. Subscription does not replay earlier events. Archived threads require explicit unarchive before observation if native resume rejects them.

For Herdr, each observation actively queries current Agent state and reads a bounded terminal snapshot, without needing earlier `get` or `read` calls. `lines` defaults to 80, up to 500. The events describe sampled state and output, not a terminal delta stream; transitions between polls can be missed. A pending startup can be observed, but output is unavailable until it becomes live. When the response supplies a live reference, use it for subsequent operations and start a new observation cursor.

The per-instance journal retains up to 256 entries within 512 KiB. Events are filtered before returning a Thread page; oversized entries are marked `truncated`. Eviction conservatively reports a gap even if discarded events belonged to another Thread. Connection reset clears the journal. After rediscovery, a Codex Thread's previous cursor reports `gap: true`; a cursor cannot reconstruct lost events. Neither backend's observation buffer is a durable task history.

Use `management.threads.get` for metadata only. Use `management.threads.read` for native turn history (Codex) or a terminal snapshot (Herdr). Codex detailed item pagination remains available through native `thread/items/list`, using native IDs. Empty, ephemeral or unsupported history can fail explicitly; a new Codex thread may not materialize until its first message.

## Interrupt and answer requests

`management.threads.interrupt` takes only `threadRef`. Codex resolves the latest native turn with a bounded metadata query, then sends one interruption request bound to that turn. No active execution returns `no_active_execution` without sending an interrupt. An unsupported native history query returns its error. If the turn changes before interruption, the native mismatch is returned; Agenvo does not retarget or retry. `interruption: requested` is a request confirmation: observe the native completion event for the actual outcome.

Precise same-turn input is available through native `turn/steer` with `threadId` and `expectedTurnId`. Exact turn interruption remains available through native `turn/interrupt`. Herdr does not advertise Thread interruption; terminal key operations retain their native semantics.

`observe.interactions` contains pending user-question and dynamic-tool summaries. Read a request with `management.interactions.read` and its `interactionRef`; answer with `management.interactions.respond` using the returned response schema. For full pending-request pages, call `management.interactions.list` with `threadRef` and optional `cursor`. Its pagination cursor is separate from the observation cursor. Permission approvals are automatic and do not become pending user questions.

## Lifecycle and execution

Codex creation, resume and input always apply `danger-full-access` and `approvalPolicy: never`, including attach mode. Herdr existing agents retain their program settings; supported new launches use native bypass flags. Native host or organization restrictions still return native errors.

Codex `threads.resume` reloads and subscribes without sending input. `archive` and `unarchive` change visibility, not cancellation or destruction. Attach mode disconnects without stopping the independent app-server. Managed-stdio owns its explicitly configured child process. Herdr owns its own service lifecycle.

After `unknown`, inspect native state before deciding whether another write is needed. Native turn IDs, request IDs and cursors are not idempotency keys. Agenvo does not automatically replay writes after disconnect. Check outputs and deliverables to assess task success.

## Upgrade an existing Connector

The three MCP tools and protocol 1 envelope remain compatible with existing Relays. Old Connectors do not advertise `managementVersion`; use their native methods. The common management API is not yet released: its previous Agent/Run method names are replaced without compatibility aliases. Re-read `instance_describe` after updating.

Legacy Codex `policy` fields are discarded on configuration load; `--sandbox` and `--approval-policy` CLI flags are removed. Descriptors include `execution: full-access`, changing their scope fingerprint. Approve an updated instance fingerprint through the owner CLI when restarting an upgraded Connector. Remote-access authentication is separate from disabled execution approvals. Installing code does not restart production or desktop services.

Herdr `agent.start` accepts Codex, Claude and Devin, whose explicit bypass flags are implemented. This narrows the previous launch-kind list; discovery still includes other existing Agent kinds.
