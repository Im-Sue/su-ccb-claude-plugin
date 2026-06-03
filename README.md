# SU-CCB Claude Plugin（`ccb`）

> **从 Vibe Coding 到 Vibe Engineering** —— Vibe Coding 解决产出速度，Vibe Engineering 解决**稳定做对**。

本仓是 **SU-CCB 框架的 Claude 侧插件**，也是整套协作的**主入口**。它把"和 AI 写代码"从一场灵感式对话，变成一个**可控、可复用、可审计的工程过程**。

## 从 Vibe Coding 到 Vibe Engineering

AI 已经很会写代码了。但做项目时我们还是常常不放心 —— 问题已经不是 **AI 能不能写**，而是 **AI 能不能持续做对**。

用 AI 写代码的人大多踩过：写得快但方向容易错、第二三轮开始跑偏、上下文漂移、改着改着和原始需求脱节、返工和 review 成本高、很难复盘"为什么这么改"。这些表面是体验问题，本质是**工程问题**。而且——

> **不是生成最贵，是"确认"最贵。** 真正烧钱的是方向走偏后的返工、上下文丢失后的重复沟通、审查时重新理解背景、团队协作时无法复盘。

**Vibe Engineering** 就是把 AI 协作当成一个**工程过程来管理**，而不是当成一个更聪明的补全工具。它要解决的不是"写得快"，而是把高风险的环节先管住，让结果**可控、可复用、可审计**：

| | 含义 |
|---|---|
| **可控** | 关键节点有审批门，避免"正确地执行了错误的目标" |
| **可复用** | 需求 / 设计 / 决策 / 状态写成结构化文档落在仓库里，可 diff、可恢复、可沿用 |
| **可审计** | 每一步都有节点、协商记录和归档证据 —— 谁、为什么、怎么验证，全程可复盘 |

## 解决什么问题，带来什么收益

| Vibe Coding 的痛点 | SU-CCB 怎么管 | 你得到的收益 |
|---|---|---|
| 方向容易错、越改越偏 | 需求 / 设计先过审批门 | 方向锁定，不再"正确地执行错误的目标" |
| 上下文漂移、和需求脱节 | 状态 / 决策落仓库文档 | 随时可恢复，断点续作不丢上下文 |
| 返工成本高 | 协商前置，想清楚再做 | 返工大幅减少，一次做对 |
| Review 成本大、看不懂改了啥 | 结构化精简回执 | 几分钟看懂一次执行，不必从头读 diff |
| 无法复盘"为什么这么改" | 全程节点 / 证据留痕 | 任何决策可追溯、可审计 |
| 多人协作混乱、责任不清 | 角色分工 + 契约 + 审批门 | 协作可治理，谁决策 / 谁执行 / 谁验证一目了然 |

**对项目管理的意义**：把原来散落在人脑里、靠人从头盯到尾兜底的 Planning / Execution / Review，变成**可重复、可约束、可审查**的流程 —— 高风险任务先被管住，团队对"AI 到底做了什么、做得对不对"有据可查。

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

## 快速开始

```bash
# 1. 安装 Claude Plugin
/plugin marketplace add Im-Sue/su-ccb-claude-plugin
/plugin install ccb@SU-CCB

# 2. 安装配套 Codex Skills（在 Codex 会话中执行）
$skill-installer install https://github.com/Im-Sue/su-ccb-codex-skills/tree/main/skills/ccb-execute
$skill-installer install https://github.com/Im-Sue/su-ccb-codex-skills/tree/main/skills/ccb-doc

# 3. 在项目中初始化
/ccb:su-init
```

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
