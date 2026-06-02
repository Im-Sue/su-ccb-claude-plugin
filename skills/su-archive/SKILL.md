---
name: su-archive
description: 在 review 通过后固化完成证据、风险和后续建议。
metadata:
  short-description: CCB 归档入口
---

# /ccb:su-archive

## 1. 指令意图说明

`/ccb:su-archive` 用于把已通过 review 的任务沉淀成可追溯历史。归档不是“结束任务”四个字，而是写清完成内容、证据、未覆盖项、风险和后续建议。

## 2. 节点集声明

主要进入：

| 节点 | Manifest |
|---|---|
| 归档 | `references/kernel/nodes/archive.node.md` |

如果 review 未通过，必须回到 `references/kernel/nodes/review.node.md`，不得普通归档。

## 3. 触发约定

```text
/ccb:su-archive task_id=<subtaskId>
/ccb:su-archive requirement_id=<requirementId>
/ccb:su-archive 当前已通过 review 的任务
```

可带 `risk_accepted=true`，但只有用户明确授权带风险归档时才可使用。

## 4. Plugin 独立运行约定

归档记录直接写入 plugin 域文件：

1. `docs/05_经验沉淀/`（需要沉淀经验时）
2. `docs/03_开发计划/*开发任务.md`
3. `docs/.ccb/events/journal.jsonl`

归档写 dev_task 终态前必须先调用 worktree helper：

```js
import { archiveRequirementWorktree } from "../../lib/worktree/index.mjs";

const worktreeArchive = await archiveRequirementWorktree({
  projectRoot,
  requirementId,
  codeWorkspace
});
```

`archiveRequirementWorktree` 只 merge 到运行态记录的 `target_branch`，绝不 fallback `main`。若返回 `status: "escalated"`（例如 target 缺失、主仓/工作区 dirty、当前分支不匹配、merge 冲突），必须保留 worktree+分支并停止普通归档，不得继续写 `status: done`。

归档子任务时，任务状态真相写入 dev_task frontmatter。写入终态，例如：

```js
await writeTaskState({
  projectRoot,
  taskId,
  title,
  patch: {
    status: "done",
    current_node: "archive",
    node_substate: "archived",
    review_status: "passed"
  },
  updatedBy: "ai_session"
});
```

归档必须以 `docs/03_开发计划/` 的 dev_task 文档为任务真相；`status/current_node/node_substate/review_status` 只能通过受治理写入更新。

归档子任务后，如果该子任务是 requirement 授权 scope 内最后一个待归档项，必须进入
AI 判断式 requirement 收尾：以 EventJournal 批量授权事件的 `members.task_key` /
`execution_order` 为 scope 真相源（DB `Task.requirementId` 只做一致性校验），确认
scope 全部 dev_task 都是 `status: done`、`current_node: archive` 且 `review_status: passed`，并确认无
遗留必要工作或未决 must_ask。没有 EventJournal 批量授权事件或等价的显式 task_keys scope 时，不做
DB fallback、不声明 delivered，必须先报告 scope 不明确。满足时通过
`applyCapabilityOutcome()` 声明：

```js
await applyCapabilityOutcome({
  projectRoot,
  capabilityId: "requirement.finalize",
  outcomeType: "delivered",
  subjectRef: {
    subject_type: "requirement",
    subject_id: requirementId,
    canonical_path: requirementMarkdownPath,
    base_hash: requirementMarkdownHash
  },
  expectedHash: requirementMarkdownHash,
  evidence: [{
    kind: "C",
    check_id: "dev_task_scope_terminal",
    params: {
      requirement_id: requirementId,
      authorization_event_id: batchAuthorizationEventId,
      task_keys: taskKeys,
      dev_task_paths: devTaskPaths
    }
  }]
});
```

如果 scope 未完成、review 未通过、hash 已变、需求已 cancelled/deferred 或 AI 判断仍有
必须处理事项，不得声明 delivered；输出拒绝原因。

不得调用 Console 业务写入接口改业务状态。Console 只负责展示归档投影。

归档 / finalize 写完 canonical 后，**best-effort 主动触发一次 Console 投影刷新**（本地 Console 在跑时 `POST /api/projects/<projectId>/scan`），并校验投影（子任务 `current_node/status`、需求 `status`）与 canonical 一致，不要只依赖 watcher 异步跟上（WSL2 会漏文件事件）；Console 不可达或投影不一致时，告知用户需手动 scan。

## 5. 强协商与 sc 要求

归档前必须：

1. 确认 review pass 或用户授权带风险归档。
2. 使用 archive 节点推荐 sc 指令，或说明替代方式。
3. 找 Codex 检查归档完整性。
4. 写 4 锚点反思。
5. 明确是否有敏感信息、后续任务或公开风险。

## 6. 用户可见输出

输出归档路径、完成摘要、验证证据、未覆盖风险、后续建议和是否继续下一个 DeliveryUnit。
