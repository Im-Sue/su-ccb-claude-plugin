# SU-CCB Claude Plugin（`ccb`）

> **一套把"和 AI 写代码"约束成工程过程的协作协议** —— 双 agent 分权（Claude 想清楚、Codex 做出来）、关键节点设审批门、全程留痕。

本仓是 **SU-CCB 框架的 Claude 侧插件**，也是整套协作的**主入口**。

AI 写代码已经够快，但项目做久了大多会遇到同一类问题：写得快却方向容易错，第二三轮开始跑偏，上下文漂移、和原始需求脱节，返工和 review 成本高，事后还很难复盘"为什么这么改"。这些表面是使用体验问题，本质是**工程问题** —— 缺的是一套能管住协作的流程和护栏。

SU-CCB 就是补上这层护栏。它建立在一个判断上：

> **这套协作里真正消耗成本的是"确认"，不是"生成"。** 方向走偏后的返工、上下文丢失后的重复沟通、审查时重新理解背景，加起来远超敲代码本身。所以这套插件不去优化"写得多快"，而是先把高风险的环节管住。

它把这件事落到三个机制上：

- **决策与执行分权**：Claude 只负责想清楚（需求、技术方案、任务切片、审查把关），Codex 只负责做出来（实现、验证、回执），边界清晰到谁决策、谁执行、谁签字一目了然。
- **关键节点设审批门**：像 code review 的签字。需求和设计必须你确认才放行，任务切片展示摘要即可通过，审查自动进行 —— 该停的地方停，不该挡的地方不挡。
- **执行方主动回抛**：Codex 遇到模糊边界不硬猜，把不确定性抛回来再确认，免得埋头做完才暴露方向已经偏了。

全程的需求、设计、决策、状态都落成仓库里的结构化文档，可 diff、可恢复、可复盘。这就是 **Vibe Coding** 与 **Vibe Engineering** 的差别：前者让你写得快，后者让你持续做对。

## 适合谁用

| | 场景 |
|---|---|
| **✅ 推荐** | 独立专业开发者、高级小团队，后端 / 平台 / 集成密集型，跨模块改动、接口 / Schema 变更、遗留系统改造、需要复盘审计的项目 |
| **🟡 有条件** | 移动 / 全栈产品团队（裁剪协商、保留快速通道） |
| **❌ 不推荐** | 原型优先、超小项目、一次性脚本、高度视觉化探索性产品 |

判断标准一句话：**只要"方向错一次"的成本很高，就值得上这套；改回来很便宜的小事，留快速通道。**

## 做了哪些工程化管理

SU-CCB 的本质，是把**人类工程团队成熟的管理实践**搬到 AI 协作上：

- **角色分工**：Claude 是决策者（需求理解、技术方案、任务切片、审查把关），Codex 是执行者（落地实现、验证、回执）。谁想清楚、谁做出来、谁在关键节点停下来确认 —— 边界越清晰越工程化，而不是把一个 agent 当全能。
- **审批门（sign-off）**：像 code review 的签字。🔴 需求 / 设计必须用户确认 · 🟡 任务切片展示摘要可放行 · 🟢 审查触发自动进行。
- **协商前置（design review）**：实施前先让执行方质疑方案。进入业务节点时 Claude 自动与 Codex 多轮协商现状、可行性、最优方案，对用户透明，只在审批门确认。
- **主动回抛（escalation）**：Codex 遇到边界不硬猜，主动把不确定性抛回，而不是做完才发现前提错。
- **结构化回执（handoff）**：执行完先给一份像 PR 描述的精简结论 —— 改了什么 / 为什么 / 怎么验证 / 有什么风险，审查者不必从头读 diff。
- **全程留痕（audit trail）**：需求、设计、决策、状态、证据都落在 `docs/` 与 `docs/.ccb/`，可 diff、可恢复、可复盘。

> 一句话：**没有协议，AI 协作只是高级聊天；有了协议（节点 / 审批门 / 回抛 / 回执），才开始像工程。** prompt 和 skills 提升能力上限，工作流与协议才解决协作稳定性。

## 业务流程

`/ccb:su-flow` 是主入口，按用户意图在 **7 个业务节点**中推进，每个节点有进入条件、硬约束和完成判定：

```text
需求分析 → 技术设计 → 任务拆分 → 派工 → 实施 → 审查 → 归档
```

一个任务在 Claude 与 Codex 之间的流转：

```text
用户提出
  → Claude 判断是否需要协商 / 勘探现状
  → Codex 协商（consult）/ 勘探现状与风险
  → Claude 确认方案与任务切片  ……（审批门）
  → Codex 实施 + 验证
  → Codex 精简回执
  → Claude 审查把关
  → 归档证据（可复盘）
```

<a id="install"></a>

## 快速开始

先在**系统级** Claude Code 安装 plugin，再启动 CCB / Oriel；CCB 会把系统级 `~/.claude/settings.json` 投影进每个 slot，让派生 agent 也能使用已启用的 `ccb@SU-CCB`。

```bash
# 1. 在系统级 Claude Code 安装 Claude Plugin
/plugin marketplace add Im-Sue/su-ccb-claude-plugin
/plugin install ccb@SU-CCB

# 2. 在项目中初始化
/ccb:su-init
```

配套 Codex Skills 请按 [su-ccb-codex-skills README 安装说明](https://github.com/Im-Sue/su-ccb-codex-skills#install) 安装；这里不复制命令，避免多处漂移。

> **前置必装**：底层运行时 [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)（`ccb` / `ccbd`，提供 Claude↔Codex 桥接）。从 [Releases](https://github.com/SeemSeam/claude_codex_bridge/releases) 下载后 `./install.sh install`，或源码 clone。**仅支持 WSL 与 macOS**（原生 Windows 走 WSL）。

## 命令

> 主入口是 `/ccb:su-flow`；其余命令是同一流程的快捷意图入口与状态 / 维护指令。

| 命令 | 用途 |
|------|------|
| `/ccb:su-flow` | **主入口**：按意图在 7 个业务节点中推进需求、设计、拆分或后续执行 |
| `/ccb:su-init` | 初始化项目骨架（扫描技术栈、生成 CLAUDE.md / AGENTS.md / docs/.ccb/） |
| `/ccb:su-dispatch` · `/ccb:su-review` | 派工 / 审查意图入口 |
| `/ccb:su-archive` · `/ccb:su-quick-archive` | 归档：固化证据、风险与后续建议；低风险走快速通道 |
| `/ccb:su-materialize-requirement` | 将已审查通过的 breakdown draft 物化为子任务 |
| `/ccb:su-revise-breakdown` · `/ccb:requirement-reanalyze` | 重写拆分草案 / 重新分析需求，修正理解漂移 |
| `/ccb:su-status` · `/ccb:su-resume` | 查看状态 / 从中断处恢复上下文 |
| `/ccb:su-reconcile` | 自检 docs 真相源、`.ccb` 协调件与 Console 投影漂移并修复 |
| `/ccb:su-approve` · `/ccb:su-batch` | 记录审批 / 设定 autonomous-batch 授权范围与停止边界 |
| `/ccb:su-cancel` · `/ccb:su-defer` · `/ccb:su-reactivate` | Requirement / 子任务大状态控制 |
| `/ccb:su-plan` | _(deprecated alias → `/ccb:su-flow`)_ |

## 依赖

| 依赖 | 类型 | 说明 |
|------|------|------|
| [su-ccb-codex-skills](https://github.com/Im-Sue/su-ccb-codex-skills) | **必需** | Codex 侧执行和文档 skills |
| [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) | **必需** | `ccb` / `ccbd` 多 agent 桥接运行时（v7+，仅 WSL / macOS） |
| [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework) · [Superpowers](https://github.com/obra/superpowers) | 可选增强 | 协商 / 审查深度分析、执行能力增强；缺失不阻塞 |

---

## 开发者参考

> 日常使用不需要看这里。核心约束：**所有对 `docs/.ccb/` 真相源的写入都走 `lib/`**（atomic write + CAS + lock + schema 校验 + 审计），禁止直接 `fs.writeFile`；anchor dispatch 用 structured JSON payload `/ccb:<skill> --payload <json>`。

- **`lib/runtime/`** — 写入底座：`safeWriteFile`（atomic + `expectedHash` CAS）、`withFileLock`、`validateAgainstSchema`、`appendEvent`（写 `docs/.ccb/events/journal.jsonl` 并 fail-open 通知本机 Console 重投影）。错误 fail-closed（`ConflictError` 重读、`ValidationError` 不强写、`LockTimeoutError` 升级或重试）。
- **`lib/state/`** — dev_task 状态读写，走 `writeTaskState(... expectedHash)`，`business-rules.mjs` 校验枚举 / ISO8601 / 来源。
- **`lib/breakdown-draft/`** — 拆分草案唯一写入入口（CAS hash 必带），校验 `section_id`/`order`/`owner`/依赖/非空壳。
- **`lib/subtask/`** — `materializeRequirement(... expectedDraftHash)` 把已批准 draft 物化为 `docs/03_开发计划/*开发任务.md`，全部写成功才标 `consumed`。
- **`lib/reconcile/`** — `/ccb:su-reconcile` 维护入口：扫描文件真相源 / EventJournal / Console projection 漂移，生成报告、审批后 apply。
- 节点行为真相源：`references/kernel/nodes/*.node.md`（plugin 自带 kernel snapshot）。
- 本地：`claude --plugin-dir ./` 加载、`/plugin validate .` 校验。

## 交流与讨论

有问题、想法，或想参与共建？扫码加微信（备注 **CCB**），拉你进讨论群：

<img src="assets/wechat.jpg" alt="微信二维码" width="220" />

GitHub [@Im-Sue](https://github.com/Im-Sue) · Telegram [@Sue_muyu](https://t.me/Sue_muyu)

## License

MIT · **Sue**
