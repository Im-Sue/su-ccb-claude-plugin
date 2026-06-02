---
name: su-quick-archive
description: 对低风险已通过审查事项执行快速归档，但仍保留证据和审计。
metadata:
  short-description: 快速归档入口
---

# /ccb:su-quick-archive

## 1. 指令意图说明

`/ccb:su-quick-archive` 用于低风险、已 review pass 的事项快速收尾。它不是跳过 archive 节点，而是使用 archive 节点的轻量路径，仍必须保留证据、风险和协商记录。

## 2. 节点集声明

主要进入：

| 节点 | Manifest |
|---|---|
| 归档 | `references/kernel/nodes/archive.node.md` |

如果 review 不存在或未通过，先回到 `references/kernel/nodes/review.node.md`。

## 3. 触发约定

```text
/ccb:su-quick-archive task_id=<id>
/ccb:su-quick-archive 当前已通过 review 的小任务
```

只适用于低风险事项。若命中必问项或仍有 unknown 验收，不得 quick archive。

## 4. Plugin 独立运行约定

定位上下文时先读 `docs/00_项目总览.md`、`docs/00_文档地图.md` 和 `docs/.ccb/docs-structure-contract.yaml`。归档对象的业务文档落点必须经 docs-structure resolver / 目录契约定位；退役文档按契约移入 `docs/99_归档/`，`.ccb` 只承载协调和审计件。

快速归档仍必须先执行 worktree 生命周期收尾：对带 `code_workspace` 的任务调用 `archiveRequirementWorktree({ projectRoot, requirementId, codeWorkspace })`，只 merge 到运行态记录的 `target_branch`。helper 返回升级信号时停止 quick archive，保留 worktree+分支并报告原因。

快速归档直接写对应业务文档 / `.ccb` 协调件和 EventJournal，不调用 Console 业务写入接口修状态。

## 5. 强协商与 sc 要求

即使 quick archive，也至少完成：

1. Codex 确认低风险理由。
2. 4 锚点反思。
3. 简短完成证据和未覆盖风险记录。

sc 可按 archive 节点推荐使用；不可用时说明替代方式。

## 6. 用户可见输出

输出归档路径、低风险理由、review pass 证据和后续无动作说明。
