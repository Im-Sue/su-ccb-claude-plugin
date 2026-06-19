---
name: su-defer
description: 暂缓 Requirement 的大状态指令入口。
metadata:
  short-description: CCB 暂缓入口
---

# /ccb:su-defer

## 1. 指令意图说明

`/ccb:su-defer` 用于把某个 Requirement 暂时搁置，同时保留已有分析、设计、draft、执行和审计证据。

## 2. 节点集声明

defer 不属于单个节点，但会暂停当前节点推进。恢复时通过 `/ccb:su-resume` 判断应回到哪个节点 manifest。

| 当前状态 | 可能恢复节点 |
|---|---|
| 分析中 | `references/kernel/nodes/requirement_analysis.node.md` |
| 设计中 | `references/kernel/nodes/technical_design.node.md` |
| 拆分中 | `references/kernel/nodes/task_breakdown.node.md` |
| 执行中 | `references/kernel/nodes/implementation.node.md` |
| 审查中 | `references/kernel/nodes/review.node.md` |

## 3. 触发约定

```text
/ccb:su-defer requirement_id=<id> reason="优先级降低"
```

`requirement_id` 入口必须走下方受治理 lib。子任务路径暂不支持：`task_id` 入口当前没有 `subtask.defer` capability outcome；不得直接改 dev_task frontmatter 或 state 文件，必须停止并升级为需要补齐子任务暂缓契约。

## 4. Lib 调用契约

Requirement 暂缓必须调用：

```js
import { deferRequirement } from "../../lib/requirement-cancel/index.mjs";

const result = await deferRequirement({
  projectRoot,
  requirementId: payload.requirement_id,
  reason: payload.reason,
  sourceActor: "ccb_claude",
  dispatchRef
});
```

`deferRequirement` 通过 `requirement.defer:deferred` capability outcome 写 canonical requirement md，保留 CAS、EventJournal、must-ask 授权和 guard 拒绝事件。严禁在 skill 内用 `fs.writeFile`、`writeTaskState`、Console API 或手写 frontmatter 直接把 Requirement/dev_task 改成 `deferred`。

## 5. Plugin 独立运行约定

遵循 `references/kernel/registries/plugin-independent-operation.md`。

lib 返回后可 best-effort 调用 Console `POST /scan` 加速投影收敛；Console 缺席、端口不可达或扫描失败都只记录在回执中，不改变暂缓结果。不得调用 Console 业务写入接口。

## 6. 错误处置

| code / 场景 | 处置 |
|---|---|
| `GUARD_FAILED` | 报告拒绝原因；delivered/cancelled Requirement 不得覆盖。 |
| `MUST_ASK_APPROVAL_MISSING` | 停止，不补造授权；要求从 Console 确认弹窗重新派发。 |
| `CAS_CONFLICT` | 停止并报告需重派；不得手工绕过锁或直接改 frontmatter。 |
| `LOCK_TIMEOUT` / retry exhausted | 报告稍后重试；不得手工绕过锁。 |

## 7. 强协商与 sc 要求

暂缓通常是用户决策；如暂缓会影响其他子任务、成本或交付承诺，应找 Codex 协商影响范围并向用户复述。

## 8. 用户可见输出

输出 `result.ok`、暂缓对象、原因、保留文件、恢复入口、失败 code/issues、Requirement/journal 关键路径，以及是否已触发 best-effort scan。
