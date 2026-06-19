---
name: su-reactivate
description: 重新激活 cancelled/deferred Requirement 的大状态指令入口。
metadata:
  short-description: CCB 重新激活入口
---

# /ccb:su-reactivate

## 1. 指令意图说明

`/ccb:su-reactivate` 用于让已取消或暂缓的 Requirement 重新进入可推进状态。它必须保留历史取消/暂缓原因，不得抹掉审计。

## 2. 节点集声明

重新激活后应根据 Requirement 上下文回到合适节点：

| 情况 | 建议节点 |
|---|---|
| 需求可能已过期 | `references/kernel/nodes/requirement_analysis.node.md` |
| 技术方案可能失效 | `references/kernel/nodes/technical_design.node.md` |
| 拆分草案需调整 | `references/kernel/nodes/task_breakdown.node.md` |
| 已有子任务可直接继续 | `references/kernel/nodes/dispatch.node.md` 或 `implementation.node.md` |

## 3. 触发约定

```text
/ccb:su-reactivate requirement_id=<id>
```

`requirement_id` 入口必须走下方受治理 lib。子任务路径暂不支持：`task_id` 入口当前没有 `subtask.reactivate` capability outcome；不得直接改 dev_task frontmatter 或 state 文件，必须停止并升级为需要补齐子任务重新激活契约。

## 4. Lib 调用契约

Requirement 重新激活必须调用：

```js
import { reactivateRequirement } from "../../lib/requirement-cancel/index.mjs";

const result = await reactivateRequirement({
  projectRoot,
  requirementId: payload.requirement_id,
  reason: payload.reason,
  sourceActor: "ccb_claude",
  dispatchRef
});
```

`reactivateRequirement` 通过 `requirement.reactivate:planning` capability outcome 将 `cancelled/deferred` Requirement 写回 `planning`；当前已为 `planning` 时 no-op；`drafting/delivering/delivered` 由 guard 拒绝。该路径保留 CAS、EventJournal、must-ask 授权和 guard 拒绝事件。严禁在 skill 内用 `fs.writeFile`、`writeTaskState`、Console API 或手写 frontmatter/state 直接改状态。

## 5. Plugin 独立运行约定

遵循 `references/kernel/registries/plugin-independent-operation.md`。

lib 返回后可 best-effort 调用 Console `POST /scan` 加速投影收敛；Console 缺席、端口不可达或扫描失败都只记录在回执中，不改变重新激活结果。不得调用 Console 业务写入接口。

## 6. 错误处置

| code / 场景 | 处置 |
|---|---|
| `GUARD_FAILED` | 报告拒绝原因；不得用 reactivate 降级 active/terminal Requirement。 |
| `MUST_ASK_APPROVAL_MISSING` | 停止，不补造授权；要求从 Console 确认弹窗重新派发。 |
| `CAS_CONFLICT` | 停止并报告需重派；不得手工绕过锁或直接改 frontmatter。 |
| `LOCK_TIMEOUT` / retry exhausted | 报告稍后重试；不得手工绕过锁。 |

## 7. 强协商与 sc 要求

重新激活必须找 Codex 协商“旧结论是否仍有效”。如果需求、技术环境或业务优先级变化，应先回到需求分析或技术设计。

## 8. 用户可见输出

输出 `result.ok`、重新激活对象、历史原因、仍有效的内容、需要重新分析的内容、下一节点、失败 code/issues、Requirement/journal 关键路径，以及是否已触发 best-effort scan。
