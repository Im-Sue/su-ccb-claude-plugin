---
name: su-cancel
description: 取消 Requirement 或子任务的大状态指令入口。
metadata:
  short-description: CCB 取消入口
---

# /ccb:su-cancel

## 1. 指令意图说明

`/ccb:su-cancel` 用于记录用户取消某个 Requirement 或子任务的决定。取消是大状态指令，不应该塞进某个节点的小 transition。

## 2. 节点集声明

取消可能影响所有节点，但不替代它们：

| 影响对象 | 关联节点 |
|---|---|
| 规划中 Requirement | requirement_analysis / technical_design / task_breakdown |
| 待派工子任务 | dispatch |
| 执行中子任务 | implementation / review |
| 已完成事项 | archive |

对应 manifest 见 `references/kernel/nodes/*.node.md`。

## 3. 触发约定

```text
/ccb:su-cancel --payload {"subject":"requirement","requirement_id":"<id>","reason":"用户放弃该需求"}
/ccb:su-cancel --payload {"subject":"subtask","task_id":"<id>","reason":"用户放弃该子任务"}
/ccb:su-cancel --payload {"subject":"requirement","requirement_id":"<id>","action":"breakdown_draft_delete"}
```

如果取消会级联影响多个子任务，必须向用户复述影响范围。

### breakdown-draft delete 契约

当 `payload.action=breakdown_draft_delete` 时，只允许调用 lib 删除 draft：

```js
import { deleteBreakdownDraft } from "../../lib/breakdown-draft/index.mjs";

await deleteBreakdownDraft({ projectRoot, requirementId });
```

`deleteBreakdownDraft` 会先写 `breakdown_draft_deleted` EventJournal，再删除文件；journal 失败时不得删除。`ConflictError` 按当前 draft 冲突处理；`ValidationError` 表示 draft 结构非法；`LockTimeoutError` 表示另一个 anchor 正在写。严禁用 `fs.rm` / `fs.unlink` / `fs.writeFile` 直接处理 `docs/.ccb/drafts/breakdown/*.json`。

### requirement worktree discard 契约

取消带 `code_workspace` 的 requirement / 子任务时，取消路径必须调用 worktree helper 丢弃代码隔离现场：

```js
import { discardRequirementWorktree } from "../../lib/worktree/index.mjs";

await discardRequirementWorktree({
  projectRoot,
  requirementId,
  codeWorkspace
});
```

`discardRequirementWorktree` 只执行 `git worktree remove --force` + `git branch -D`，不 merge、不回流代码。discard 完成后再写 cancelled 状态和取消审计；失败时保留现场并升级，不要用 Console 旧 worktree API 兜底。

## 4. Plugin 独立运行约定

定位上下文时先读 `docs/00_项目总览.md`、`docs/00_文档地图.md` 和 `docs/.ccb/docs-structure-contract.yaml`。Requirement / dev_task 等业务文档落点必须经 docs-structure resolver / 目录契约定位；`.ccb` 只承载 state、events、draft、report、lock、index cache 等机器协调件。

取消记录直接写入 state、相关业务文档或 draft 的状态段和 EventJournal。不得调用 Console 业务写入接口改状态。

## 5. 强协商与 sc 要求

取消前应找 Codex 协商影响范围，尤其是执行中、已 review、已 archive 的子任务。命中业务规则或用户权利时必须问用户。

## 6. 用户可见输出

输出取消对象、级联影响、保留证据、后续可 reactivate/resume 的条件和写入路径。
