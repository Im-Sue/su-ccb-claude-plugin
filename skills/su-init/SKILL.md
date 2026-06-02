---
name: su-init
description: 初始化项目级 CCB plugin 工作区，使 plugin 可脱离 Console 独立运行。
metadata:
  short-description: CCB 项目初始化
---

# /ccb:su-init

## 1. 指令意图说明

`/ccb:su-init` 用于把一个普通项目初始化为 CCB plugin 可工作的项目。它创建项目内工作记录、索引入口、agent 协作说明和必要目录，让后续 `/ccb:su-flow` 不依赖 Console 也能运行。

## 2. 节点集声明

`su-init` 不直接进入业务节点，但必须安装或校验节点 manifest：

| 节点 | Manifest |
|---|---|
| 需求分析 | `references/kernel/nodes/requirement_analysis.node.md` |
| 技术设计 | `references/kernel/nodes/technical_design.node.md` |
| 任务拆分 | `references/kernel/nodes/task_breakdown.node.md` |
| 派工 | `references/kernel/nodes/dispatch.node.md` |
| 实施 | `references/kernel/nodes/implementation.node.md` |
| 审查 | `references/kernel/nodes/review.node.md` |
| 归档 | `references/kernel/nodes/archive.node.md` |

初始化完成后，用户可直接调用 `/ccb:su-flow` 进入业务节点。

## 3. 触发约定

```text
/ccb:su-init
/ccb:su-init project=<name>
```

运行时先扫描当前目录，确认是否已有 `docs/.ccb/` 和 agent 说明文件。已有文件不得静默覆盖；命中覆盖用户文件时跳过并在摘要中报告。

### init lib 调用契约

收到本指令后必须调用 plugin lib 或同等 CLI，不得手写一套脚手架流程：

```js
import { initProjectScaffold } from "../../lib/su-init/index.mjs";

const result = await initProjectScaffold({ projectRoot });
```

CLI 形式：

```bash
node <plugin>/skills/su-init/scripts/init.mjs --project-root <projectRoot>
```

## 4. Plugin 独立运行约定

初始化的目标是让项目没有 Console 也能工作。至少创建或校验：

1. `docs/00_项目总览.md`
2. `docs/01_架构设计/` ~ `docs/06_决策记录/`、`docs/99_归档/`
3. 各 docs 目录下的 `_模板_*.md`
4. `docs/.ccb/docs-structure-contract.yaml`
5. `docs/.ccb/index/`
6. `docs/.ccb/events/journal.jsonl`
7. `docs/.ccb/locks/`
8. `docs/.ccb/drafts/breakdown/`
9. `docs/.ccb/schemas/`
10. `docs/.ccb/config/`
11. `CLAUDE.md` / `AGENTS.md` / `.claude/settings.json` 协作说明，按项目实际存在情况处理

`docs/00_文档地图.md` 由 indexer 自动生成，`su-init` 不手填。

不得调用 Console 业务写入接口初始化业务状态。

## 5. 强协商与 sc 要求

`su-init` 是管理指令，不强制进入业务节点协商。但如果初始化过程中需要决定项目结构、覆盖文件、引入外部服务或改变用户已有配置，必须按必问清单问用户。

建议使用：

1. `/sc:analyze --focus project-structure .`
2. `/sc:research <项目技术栈>`（需要判断技术栈时）

sc 不可用时，说明替代扫描方式。

## 6. 用户可见输出

输出初始化摘要、创建/保留/跳过的文件、未覆盖原因、下一步建议和可直接运行的 `/ccb:su-flow` 示例。
