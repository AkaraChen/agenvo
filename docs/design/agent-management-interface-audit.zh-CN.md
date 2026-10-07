# Agent 管理接口核对记录

基线核对日期：2026-10-07，下面的“当前范围”固定指重构前 commit 5651eb2。本次重构后的能力与运行验证见[设计的实现记录](agent-management.zh-CN.md#实现与已验证范围)，不要将基线表当作最新版发现结果。目标设计见[Agent 管理服务的统一接口](agent-management.zh-CN.md)。本记录区分原生定义、Agenvo 已暴露接口和运行验证，不把三者合并为“支持”。

## 版本与证据

| 对象 | 本次证据 | 能证明的范围 |
| --- | --- | --- |
| Agenvo | main，`5651eb2e81c96bfd96a9a77d80cb3ded775f3f32`，读取适配器、协议与 MCP 实现 | 当前仓库暴露的方法和内部处理路径 |
| Herdr | 本机 `herdr --version` 为 0.9.3；读取 v0.9.3 源码，commit `7b116c05bfda646af39d2524c54e70c751f57ee8`；检查 CLI help | 此版本的方法、类型、输入和订阅实现；没有调用活跃 session |
| Codex | 本机 `codex --version` 为 codex-cli 0.160.1；该二进制生成含 experimental 的 JSON Schema | 方法名称、参数和通知定义；experimental 字段不因此成为稳定或已启用能力 |
| Codex 官方文档 | [App Server](https://developers.openai.com/codex/app-server/)，本次读取时重定向到 ChatGPT Learn | 用于核对 thread/turn 和 steer 的语义；实际可用范围以所接版本、策略和运行验证为准 |

本次没有启动模型任务、连接日常 Herdr session、重启 Codex App 或部署新服务。代码阅读和 schema 生成属于静态核对；本文提到的现有适配器版本限制不是本次新做的运行实验。

## Herdr 0.9.3

原生证据固定到上述 commit：[Agent 类型](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/agents.rs)、[状态枚举](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/common.rs)、[Agent API 实现](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/agents.rs)、[等待实现](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/wait.rs)、[事件定义](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/events.rs)、[订阅实现](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/server.rs)。

| 管理行为 | 原生接口与字段 | Agenvo 当前范围 | 设计结论 |
| --- | --- | --- | --- |
| 服务发现 | 独立 session / 本地控制端点 | session.list 扫描批准的 config root，返回服务代次 | instance 与 Herdr session 不能直接一对一等同 |
| Agent 发现 | agent.list、agent.get；AgentInfo 包含 terminal_id、pane_id、workspace_id、可选 agent_session | 已暴露，可发现已有 Agent | 原生身份保留；名称不是持久任务 ID |
| 创建 | workspace.create；agent.start 指定 name、kind、pane_id、args、timeout_ms | 已暴露；agent.start 使用 Connector 本地异步启动跟踪 | 创建资源与发提示词分开，starting 不等于已准备好 |
| 输入 | agent.prompt 指定 target、text，可选 wait | 已暴露 prompt；当前适配器不使用 wait 完成任务 | 原生队列将提示词写入终端；blocked 会拒绝，确认不证明某轮完成 |
| 读取 | agent.read / pane.read；agent.explain 提供识别依据 | 已暴露有界快照与 explain | 输出类型是终端快照；explain 不是结构化审批请求列表 |
| 等待与事件 | agent.wait；events.subscribe、events.wait；状态、输出匹配等事件 | 当前未暴露 wait 和事件订阅 | 可作为观察输入；状态等待不构成有身份的业务执行结果 |
| 中断 | agent.send-keys / pane.send-keys | 已暴露按键发送 | Esc / Ctrl+C 的效果取决于终端程序，不能映射为可靠的 Thread interrupt |
| 恢复 | agent_session 元数据和 agent_resume 模块包含特定 Agent 的恢复逻辑 | 当前没有统一恢复接口 | 不能说 Herdr 完全不支持恢复；也不能据内部能力宣称已具有通用 resume API |
| 收尾 | workspace.close 等原生资源操作 | 已暴露 workspace.close | 关闭终端与上下文归档不同，不提供归档映射 |

`AgentStatus` 为 idle、working、blocked、done、unknown；AgentInfo 另有 launch_pending、interactive_ready、state_change_seq、completion_seq、revision。completion_seq 表示观察到的一次工作结束后的空闲转换，并不是持久的任务身份、退出码或成功证明。

`EventsSubscribeParams` 只有 subscriptions，没有供调用方恢复历史的 cursor/since 参数。服务在订阅开始时读取当前内部 sequence，再流式发送事件。内部 sequence 的存在不等于公开的断线重放契约；不能将它当成可靠历史游标。

Herdr 的恢复逻辑另见 [agent_resume.rs](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/agent_resume.rs)。是否能暴露某种恢复操作，需要逐种 Agent 验证其原生会话标识、恢复参数和失败语义。

## Codex app-server 0.160.1

| 管理行为 | 本机生成 schema 中的接口 | Agenvo 当前范围 | 设计结论 |
| --- | --- | --- | --- |
| 发现 | thread/list、thread/loaded/list、thread/read | 已暴露 | 保留持久列表与当前加载集合的差异 |
| 创建与继续 | thread/start、thread/resume、turn/start | 已暴露，参数受模式和 policy 限制 | thread 是可继续交互的上下文，turn 是一次执行 |
| 同轮追加 | turn/steer，必填 threadId、expectedTurnId、input | 尚未暴露 | 可以提供原生带轮次前置条件的 steer；需扩展 schema、权限检查和行为验证 |
| 执行中断 | turn/interrupt，必填 threadId、turnId | 已暴露 | 请求确认与 turn 实际 interrupted 分开观察 |
| 历史输出 | thread/read、thread/turns/list、thread/items/list | 已暴露，但当前适配器记录了版本兼容限制 | schema 存在不能证明历史读取可用，不能自动假设断线后可完整恢复 |
| 实时观察 | thread/status/changed、turn/started、turn/completed、item/started、item/completed、item/agentMessage/delta | 当前处理部分通知以维护交互状态，未提供通用增量事件查询 | 需要新增有界观察记录，并报告已订阅范围与缺口 |
| 结构化交互 | server request 与 serverRequest/resolved | requests.list/read/respond 已提供 Connector 桥接 | requests.list 不是 Codex 原生 RPC；仅覆盖当前连接收到且尚未失效的请求 |
| 归档与恢复可见性 | thread/archive、thread/unarchive | archive 已暴露；unarchive 未暴露 | 可映射为可选能力，不与销毁或中断合并 |
| 分支与订阅 | thread/fork、thread/unsubscribe | 尚未暴露 | 首阶段保留为待核对的原生扩展，不硬塞进共同最小接口 |

官方文档确认 `turn/steer` 针对当前活跃 turn，expectedTurnId 不匹配或没有活跃 turn 时失败；它不创建新一轮。该语义也与本机 `TurnSteerParams.json` 的字段说明一致。[官方说明](https://developers.openai.com/codex/app-server/)

本机 schema 中 ThreadStatus 是 notLoaded、idle、systemError、active；activeFlags 包含 waitingOnApproval、waitingOnUserInput。TurnStatus 是 inProgress、completed、interrupted、failed，Turn 可携带 error。thread 空闲和 turn 完成是不同事实；turn 完成仍不是业务目标已达成的证明。

当前 Agenvo 的 11 个原生方法为 model/list、thread/loaded/list、thread/start、thread/resume、thread/read、thread/list、thread/archive、thread/turns/list、thread/items/list、turn/start、turn/interrupt；另有三个 requests.* 桥接方法。结构化响应 schema 覆盖以下五类：

- item/commandExecution/requestApproval
- item/fileChange/requestApproval
- item/permissions/requestApproval
- item/tool/requestUserInput
- item/tool/call

最后一类要求工具结果，不是一般的审批问题。请求响应校验和权限处理必须保留其原生差异。

当前适配器的发现文案提示：0.160.1 的历史读取可能返回 `list_turns is not supported yet`，建议 metadata 读取不设置 includeTurns。本次确认了代码中的提示和 schema 中的历史接口，没有复现这一运行错误。历史模式、服务启动选项与真实线程条件下的可用性列入后续验收。

生成 schema 使用了 `--experimental`；比如新队列或删除接口即使出现，也不意味着当前产品应支持或可安全开启。`clientUserMessageId` 的存在也不能证明重复请求会去重。

## Agenvo 代码对应位置

- [适配器契约和 describe](../../src/connector/adapters/adapter.ts)：当前统一的是调用信封和方法描述，还没有统一的 Agent 管理结果。
- [Herdr 适配器](../../src/connector/adapters/herdr.ts)：方法表、服务代次、异步启动、终端观察与输入语义。
- [Codex 适配器](../../src/connector/adapters/codex.ts)：原生 RPC、交互有效期、通知处理、managed-stdio 与 attach-unix。
- [Codex 执行配置](../../src/connector/adapters/codex-execution.ts)和[导入的 schema](../../src/connector/adapters/schema/codex.json)：重构后替换旧策略模块，固定 full access，并自动响应权限请求。
- [协议](../../src/protocol/index.ts)和[MCP](../../src/relay/mcp.ts)：严格实例描述、调用交付结果与三个公开工具。

## 复现方式与证据指纹

以下操作只读取版本、源码和生成 schema，不连接已有服务。输出放在临时目录，不需要在仓库保存整套生成文件。

```sh
herdr --version
herdr agent --help
herdr workspace --help
git clone --depth 1 --branch v0.9.3 https://github.com/herdrdev/herdr.git /tmp/agenvo-interface-audit/herdr
git -C /tmp/agenvo-interface-audit/herdr rev-parse HEAD
codex --version
codex app-server generate-json-schema --experimental --out /tmp/agenvo-interface-audit/codex-schema
```

本次生成文件的 SHA-256（同名版本的不同构建仍可能不同，应以实际文件为准）：

| 文件 | SHA-256 |
| --- | --- |
| ClientRequest.json | `4a6fc883c2e84c4721bfabd6756ca5bb6e99675a8938768d8bc9cc67ff984700` |
| ServerRequest.json | `3d7bc481f84dc042984a74420e65c5a8d3c423f37a91b7d5df2365c903a12ac6` |
| ServerNotification.json | `28a42039eee1c3f45c92b6cf07111bacf6de2716f4d3365ff53ad65507fef00c` |
| v2/TurnSteerParams.json | `99f7fdff8b090065b68f36420b70870b5eafed048c024b308230aaa02f15d891` |
| v2/TurnCompletedNotification.json | `016870158603b0f84bd9f8f65f927161c9fd5128e5ec632087616462dc44e085` |

下一阶段的运行验收须使用独立测试服务和工作目录，覆盖提案中的未决项；不能拿日常会话验证竞争、中断或销毁行为。本记录证明接口设计有版本对应的依据，不证明拟议管理接口已经实现或通过生产验收。
