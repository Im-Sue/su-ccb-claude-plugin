---
name: su-batch
description: 建立 autonomous-batch 授权范围和停止边界的指令入口。
metadata:
  short-description: 批量自治授权
---

# /ccb:su-batch

## 1. 指令意图说明

`/ccb:su-batch` 用于让用户授权 AI 团队在明确范围内连续推进多个节点或多个子任务。它的核心不是“省人工点击”，而是定义自治范围、停止边界和升级条件。

## 2. 节点集声明

可覆盖完整 7 节点集，但每个节点仍按自己的 manifest 执行：

| 节点 | Manifest |
|---|---|
| 需求分析 | `references/kernel/nodes/requirement_analysis.node.md` |
| 技术设计 | `references/kernel/nodes/technical_design.node.md` |
| 任务拆分 | `references/kernel/nodes/task_breakdown.node.md` |
| 派工 | `references/kernel/nodes/dispatch.node.md` |
| 实施 | `references/kernel/nodes/implementation.node.md` |
| 审查 | `references/kernel/nodes/review.node.md` |
| 归档 | `references/kernel/nodes/archive.node.md` |

## 3. 触发约定

```text
/ccb:su-batch scope=requirement requirement_id=<id>
/ccb:su-batch scope=subtasks requirement_id=<id> count=<n>
/ccb:su-batch 允许这个需求下的子任务连续推进
/ccb:su-batch --payload {"subject":"requirement","scope":"subtasks","requirement_id":"<id>","task_ids":["<subtaskId>"],"policy_profile":"autonomous-batch","stop_policy":{"on_subtask_failure":"stop_and_report"}}
```

用户必须知道授权范围和停止条件。AI 不得把一次 batch 授权解释成无限期全项目自治。

### subtask set 轻量 coordinator 契约

当 payload `scope="subtasks"` 且包含 `task_ids` 时，本指令就是一次轻量批量推进：

1. 先读取 `requirement_id`、`task_ids` 对应的需求文档、dev_task 文档、拆分草案和 EventJournal，确认全部属于同一需求。
2. 自行判断执行顺序；如果依赖关系或当前状态与 task set 冲突，停止并报告原因，不要跳过出错项继续推进。
3. 对每个子任务派工给执行 agent 前，按 dev_task 的 `code_workspace` 调用 `ensureRequirementWorktree({ projectRoot, requirementId, codeWorkspace })`；同一 requirement 重复调用必须视为幂等 no-op，确保 ask 发出前 codeRoot 已存在。
4. 对每个子任务逐个子任务走 `implementation` → `review` → `archive`。实施可调用执行 agent；review 轻重由当前上下文和风险自判，但归档前必须有 review 通过或明确风险授权。
5. 每个子任务完成后让文件真相源落地，Console 通过现有 per-subtask 状态投影展示进度；本轻量契约不维护独立 batch 进度条。
6. 失败即停：任一子任务 implementation/review/archive 失败时，停止后续子任务，报告已 done、未 done、失败子任务和原因。`stop_policy.on_subtask_failure="stop_and_report"` 是默认且唯一支持策略。
7. 本档不做精细 cursor 断点续跑；恢复时必须重新读取 dev_task frontmatter 和 EventJournal，再向用户说明可安全继续的范围。
8. 当最后一个 scope 成员归档完成后，AI 执行 requirement 收尾判断；scope 以 batch 授权文件
   EventJournal 批量授权事件里的 `members.task_key` / `execution_order` 为准，不用 DB 查询扩大范围。满足交付条件时由
   `requirement.finalize` capability outcome 写 requirement md `status: delivered`；不满足则拒绝并说明原因。
9. **投影收敛（不依赖 watcher）**：每个子任务归档后、以及 finalize 后，best-effort 主动触发一次 Console 投影刷新（本地 Console 在跑时 `POST /api/projects/<projectId>/scan`），并校验关键投影（子任务 `current_node/status`、需求 `status`）与 canonical 文件一致。WSL2 watcher 会漏文件事件，故不得只依赖它异步跟上；Console 不可达或投影与 canonical 不一致时，明确告知用户需手动 scan，不得在投影未确认收敛时声称"已交付且界面一致"。

使用 helper 时从 plugin lib 引入：

```js
import { ensureRequirementWorktree } from "../../lib/worktree/index.mjs";
```

## 4. Plugin 独立运行约定

batch 授权写入 EventJournal。`members.task_key` 是后续
`dev_task_scope_terminal` evidence 的授权 scope 来源，`members.task_id` 仅用于和
Console/DB 投影做一致性观察。后续节点推进仍由 plugin 文件真相源驱动，不调用 Console
业务写入接口。

## 5. 强协商与 sc 要求

建立 batch 前必须：

1. 让 Codex 协商授权范围是否清楚。
2. 扫描必问项，尤其是成本、隐私、合规和不可逆工程动作。
3. 写 4 锚点反思。
4. 记录停止条件：遇到用户必问项、协商无新增信息、验证失败、范围冲突或外部服务风险。

## 6. 用户可见输出

输出授权范围、预计会经过的节点、停止条件、用户仍需拍板的事项和 batch 记录路径。
