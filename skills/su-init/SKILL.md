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

### 旧项目架构生成

`initProjectScaffold()` 返回的 `summary.architectureCandidate` 是旧项目架构生成的唯一入口判定。不得在 skill 内复制 eligibility 算法；需要复核时直接从 lib 导入 `detectArchitectureCandidate`。

处理流程：

1. 先完成 init lib 三步脚手架，再读取 `summary.architectureCandidate`。
2. 如果 `architectureCandidate.eligible === false`，不得生成架构文档；回执说明跳过原因：
   - `no_source`：未检测到足够源码。
   - `multiple_source_roots`：检测到多源码根 / monorepo 信号，需用户手写或指定范围。
   - `architecture_exists`：`docs/01_架构设计/` 下已有非模板 `.md`，不得覆盖。
   回执同时带上 lib 返回的 `sourceRoots` / `existingArchitectureDocs`（非空时）。
3. 如果 `architectureCandidate.eligible === true`，进入 agent 层证据门槛。必须同时满足：
   - 能拿到项目目录树。
   - 至少有 1 类 grounding 源：README、依赖 manifest、入口文件。
   - 至少能填出「概述」「技术栈」「项目结构」「核心模块 / 入口」四块。
4. 证据门槛不满足时，不生成文件；回执使用 `evidence_insufficient`，说明证据不足、建议手写，并列出缺少哪类证据。
5. 证据足够时，优先使用 `/sc:analyze` + `/sc:index-repo` 获取结构证据；SC 不可用时，直接读取 README、入口文件、依赖 manifest 和目录树兜底。
6. 按 `templates/docs/01_架构设计/_模板_架构.md` 的章节结构渲染架构文档，只填有据章节：
   - 技术栈来自依赖 manifest。
   - 项目结构来自目录树。
   - 核心模块来自顶层目录、入口文件和 import 关系，必要时标为 inferred。
   - 概述来自 README 或等价项目说明。
7. 推不出的章节直接省略，包括部署拓扑、外部服务、权限模型、关键数据流、历史意图。正文不得写 TODO、待校正、也不得用 hedge 文本代替证据。
8. 生成文档 frontmatter 只写：

```yaml
---
doc_type: architecture
updated: YYYY-MM-DD
generated_by: su-init-ai
human_verified: false
---
```

不得写 `status` 字段，不得生成 02_需求、04_模块规格等其它文档。

写盘纪律：

1. 写盘前必须二次检测：

```js
import { detectArchitectureCandidate } from "../../lib/su-init/index.mjs";

const latest = await detectArchitectureCandidate({ projectRoot });
```

2. 若 `latest.eligible !== true`，按最新 `reason` 跳过并回执，不写文件。
3. 若仍 eligible，只能写 `latest.targetPath`。目标路径是项目内相对路径，写盘时拼到 `projectRoot` 下。
4. 必须使用 final path 独占创建，例如：

```js
await writeFile(targetPath, content, { encoding: "utf8", flag: "wx" });
```

或等价的 `open(targetPath, "wx")`。禁止使用 `safeWriteFile` 或任何 temp + rename helper，因为 final rename 可能覆盖竞态文件。
5. 如果写盘返回 `EEXIST`，放弃生成并回执提示目标文件已存在，不得覆盖或重试改名。

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

若触发旧项目架构生成流程，回执还必须包含：

- 生成时：醒目标明「AI 生成、建议 review、要改直接对话」，列出写入路径和 evidence sources 摘要（目录树、README、manifest、入口文件、SC 结果等实际使用项）。
- 跳过时：列出跳过原因。eligibility 失败使用 `architectureCandidate.reason`，并带上 `sourceRoots` / `existingArchitectureDocs`（非空时）；证据不足使用 `evidence_insufficient` 并列缺少哪类证据；目标文件竞态存在时说明 `EEXIST` / 已存在且未覆盖。
