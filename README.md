# SU-CCB Claude Plugin

> Claude + Codex Multi-AI Collaboration Framework

SU-CCB 是一套 Claude Code 插件，将 AI 协作视为**工程管理问题**而非"智能补全工具"。它在 Claude 和 Codex 之间建立了设计-执行分离、审批门控、多轮协商、结构化回执的完整协作流程。

## Quick Start

```bash
# 1. 安装 Claude Plugin
/plugin marketplace add SU-CCB/su-ccb-claude-plugin
/plugin install ccb@SU-CCB

# 2. 安装 Codex Skills（配套仓库）
# 在 Codex 会话中执行：
$skill-installer install https://github.com/SU-CCB/su-ccb-codex-skills/tree/main/skills/ccb-execute
$skill-installer install https://github.com/SU-CCB/su-ccb-codex-skills/tree/main/skills/ccb-doc

# 3. 在项目中初始化
/ccb:su-init
```

## Commands

> 主入口是 `/ccb:su-flow`：按用户意图进入 7 个业务节点之一（需求分析 → 技术设计 → 任务拆分 → 派工 → 实施 → 审查 → 归档）。其余命令是同一流程的快捷意图入口与状态 / 维护指令。

| 命令 | 用途 |
|------|------|
| `/ccb:su-flow` | **主入口**：按意图在 7 个业务节点中推进需求分析、设计、拆分或后续执行 |
| `/ccb:su-init` | 初始化项目骨架（扫描技术栈、生成 CLAUDE.md / AGENTS.md / docs/.ccb/） |
| `/ccb:su-dispatch` | 派工意图入口：将已确认子任务异步派给执行 agent |
| `/ccb:su-review` | 审查意图入口：审执行回执、diff、验证证据，决定通过 / 返工 / replan / 升级 |
| `/ccb:su-archive` · `/ccb:su-quick-archive` | 归档意图入口：固化完成证据、风险与后续建议；低风险走快速通道 |
| `/ccb:su-materialize-requirement` | 将已审查通过的 breakdown draft 物化为子任务（dev_task） |
| `/ccb:su-revise-breakdown` · `/ccb:requirement-reanalyze` | 重写拆分草案 / 重新分析需求原文，修正理解漂移 |
| `/ccb:su-status` · `/ccb:su-resume` | 查看状态 / 从中断处恢复上下文 |
| `/ccb:su-reconcile` | AI-native 自检 docs 真相源、`.ccb` 协调件与 Console 投影漂移并按审批修复 |
| `/ccb:su-approve` · `/ccb:su-batch` | 记录审批 / 设定 autonomous-batch 授权范围与停止边界 |
| `/ccb:su-cancel` · `/ccb:su-defer` · `/ccb:su-reactivate` | Requirement / 子任务大状态控制 |
| `/ccb:su-plan` | _(deprecated alias → `/ccb:su-flow`，保留到 v1.5 grace window)_ |

## Core Features

### Design-Execution Separation
Claude 做决策（需求、设计、审查），Codex 做执行（编码、验证、文档）。角色不混淆。

### Kernel Reference Snapshot
本 plugin 自带 SU-CCB kernel snapshot。下游项目初始化后通过项目相对路径 `references/kernel/` 引用该快照；节点行为真相源是 `references/kernel/nodes/*.node.md`。

Active kernel behavior lives under `references/kernel/`; retired YAML node definitions are no longer distributed.

### Multi-Round Consultation
进入任一业务节点时 Claude 自动与 Codex 进行多轮协商：
- 收集代码现状意见、可行性分析、最优方案探讨
- 轮次与停止条件以节点 manifest / capability 为准
- 协商对用户透明，只需在审批门确认

### Approval Gates
- **Red**: 必须等用户确认（需求、设计）
- **Yellow**: 展示摘要，用户可放行（任务切片）
- **Green**: 自动进行（审查触发）

### Structured Contracts
- **Ask Contract**: 派工时传什么、不传什么
- **Receipt Contract**: Codex 回执 <2k，精简导航图
- **Consult Contract**: 协商请求/回复的结构化格式
- **Bounceback Rules**: 9 种情况 Codex 必须回抛

## Runtime

Plugin 脚本需要写 `docs/.ccb/` 真相源文件时，应先走 `lib/runtime/`，避免半截文件、并发覆盖和无审计痕迹。

Anchor dispatch 命令使用 structured JSON payload：`/ccb:<skill> --payload <json-object>`。业务字段保持原生 JSON string/object/array，不再为多行文本或嵌套对象做业务层 base64 编码。

| 函数 | 何时调用 |
|---|---|
| `safeWriteFile(path, content, options)` | 写 markdown/json/yaml 文件，支持 atomic write 与 `expectedHash` CAS |
| `acquireFileLock(path)` | 需要手动包住较长的读-改-写流程 |
| `withFileLock(path, fn)` | 推荐的读-改-写封装，自动释放 lock |
| `validateAgainstSchema(content, schemaName)` | 写前按 `references/kernel/schemas/` 选择结构校验器；业务规则由领域 lib 兜底 |
| `appendEvent(event, options)` | 写入后向 `docs/.ccb/events/journal.jsonl` 留审计事件 |

runtime 错误默认 fail-closed：`ConflictError` 需要重读再决策，`ValidationError` 不允许强写，`LockTimeoutError` 通常应升级给用户或稍后重试。

File lock 会写 `<path>.lock/owner.json`（pid、hostname、acquired_at）。再次获取锁时，如果 owner pid 已不存在，会清理一次 stale lock 后重试；如果 pid 仍存活、hostname 不同、或 owner 文件缺失/损坏，则按原 timeout 流程失败，避免误删其他活跃 anchor 的锁。

EventJournal append 在 idempotency 扫描时会跳过坏 JSON 行并打印 warning；正常行的 idempotency key 仍会去重。坏行不会阻止后续事件写入，但应由后续 reconcile/audit 清理。

### Hook Notifier

`appendEvent(event, options)` 成功写入新 EventJournal 行后，会向本机 Console 发送一次 fail-open 通知，触发 Console `scanProject` 重新投影文件真相源。重复 idempotency event 不触发通知。

默认 receiver 是 `http://127.0.0.1:3030/api/plugin-hooks/event-journal`，也可用 `ccb.config.yaml` 的 `plugin_hooks.event_journal_urls` 或环境变量 `CCB_EVENT_HOOK_URLS` 覆盖。v1.0 只允许 localhost URL；非 localhost 会被跳过并打印 warning。

hook timeout 固定为 300ms，不重试；receiver 不可用、超时或返回非 2xx 都不会回滚 EventJournal 写入。

## Dev Task State Library

`lib/state/` 是历史命名的兼容 API；当前实现读写 `docs/03_开发计划/` 的 `dev_task` 文档 frontmatter。运行时 Task 投影读取 dev_task 的 `status/current_node/node_substate/review_status`；批量授权与运行审计写 EventJournal。

任务状态写入必须走 `writeTaskState({ projectRoot, taskId, patch, expectedHash })` 兼容入口，并由 `lib/state/business-rules.mjs` 校验状态枚举、节点枚举、ISO8601 时间戳和 `updated_by` 来源。

## Reconcile Library

`lib/reconcile/` 是 `/ccb:su-reconcile` 的维护入口，不是第 8 节点。它按 ADR-0025 扫描文件真相源、EventJournal 与 Console DB projection 的漂移，生成 `docs/.ccb/drafts/reconcile/YYYY-MM/reconcile-<timestamp>.md` 报告，并在用户审批后 apply。

apply 阶段不会直接写 Console DB。`quick_archive`、`set_status`、`unset_archive` 会写 dev_task frontmatter 并追加 `state_reconciled` EventJournal；`rollup_requirement` 只触发投影刷新语义。

## Breakdown Draft Library

`lib/breakdown-draft/` 是 Phase 2a 的拆分草案唯一写入入口。涉及 `docs/.ccb/drafts/breakdown/<requirementId>.json` 的 skill 必须 import 这些函数，禁止直接 `fs.writeFile` / `fs.rm` 修改 draft 文件。

写入前会先执行 breakdown-draft 业务规则校验：`section_id` 必须使用 `prN-slug` 格式，`order` 必须从 1 连续递增并与 `section_id` 编号一致，`implementation_owner` 只能是 `claude` 或 `ccb_codex`，依赖必须引用同一 draft 内已有 section，spec markdown 不能是空壳，`review_history` 必须是数组。

| 函数 | 何时调用 |
|---|---|
| `createBreakdownDraft({ projectRoot, requirementId, draftPayload })` | 生成新拆分草案 |
| `updateBreakdownDraft({ projectRoot, requirementId, patch, expectedHash })` | 修改草案内容，必须带当前 hash |
| `transitionBreakdownDraftStatus({ projectRoot, requirementId, expectedHash, fromStatus, toStatus, ... })` | begin-review / approve / reject，必须带当前 hash |
| `readBreakdownDraft({ projectRoot, requirementId })` | 读取草案并返回 canonical hash |
| `deleteBreakdownDraft({ projectRoot, requirementId })` | 删除草案；先写 `breakdown_draft_deleted` journal，journal 失败则不删文件 |

v1.x 暂不写 tombstone 文件；删除审计以 EventJournal 为准。

## SubTask Materialization Library

`lib/subtask/` 是子任务物化入口。`/ccb:su-materialize-requirement` 必须调用 `materializeRequirement({ projectRoot, requirementId, expectedDraftHash })`，禁止直接 `fs.writeFile` 写开发任务文档。

物化规则：
- 只接受已批准的 `docs/.ccb/drafts/breakdown/<requirementId>.json`。
- `expectedDraftHash` 必须匹配用户审查过的 draft hash。
- 每个 included subtask 经 docs-structure resolver 生成一个 `docs/03_开发计划/*开发任务.md`，frontmatter 使用 `doc_type: dev_task`、`task_id`、`status/current_node/node_substate` 等字段。
- 所有 dev_task 文档都成功写入后才把 draft 标记为 `consumed`，避免“子任务没生成完但草案显示已消费”。
- 重复执行同一 draft hash 会跳过已存在 dev_task，并通过 EventJournal idempotency key 去重。

## Dependencies

| 依赖 | 类型 | 说明 |
|------|------|------|
| [su-ccb-codex-skills](https://github.com/SU-CCB/su-ccb-codex-skills) | **必需** | Codex 侧执行和文档 skills |
| CCB v6 runtime — CLI：`ccb ask`、`ccb pend`、`ccb ping`；daemon：`ccbd` | **必需** | Claude-Codex 通讯基础设施 |
| [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework) | 可选增强 | 协商和审查阶段深度分析 |
| [Superpowers](https://github.com/obra/superpowers) | 可选增强 | Codex 执行阶段能力增强 |

SuperClaude / Superpowers 缺失时 CCB 正常运行，不阻塞。

## Best For

- **Recommended**: 独立专业开发者、高级小团队、后端/平台/集成密集型项目
- **Conditionally Recommended**: 移动/全栈产品团队（裁剪协商+快速通道）
- **Not Recommended**: 原型优先、超小项目、高度视觉化探索性产品

## Development

```bash
# 本地测试（不安装，直接加载）
claude --plugin-dir ./

# 验证 plugin 结构
/plugin validate .
```

## License

MIT

## Author

**Sue** | [GitHub](https://github.com/Im-Sue) | TG: @Sue_muyu
