# Changelog

## v1.2.1 - 2026-06-12

CCB v1.2.1 — 四仓发版对齐（patch）：文档澄清。

### Changed
- 明确 system-level plugin 安装说明。

## v1.2.0 - 2026-06-10

CCB v1.2 — 合并 gate 按需求隔离收口，并加强 root canonical 写入锁。

### Added
- `withCanonicalRepoLock`：root canonical 写操作增加仓库级锁，降低并行 closeout 时的 git 写入竞争。
- 需求资产 dirty classifier：`docs/.ccb/assets/requirements/<reqId>/` 中合法单层图片资产按需求归属纳入 owner canonical sync。

### Changed
- mgsync 合并洁净度按需求隔离：跨需求 docs / 协调件不再互相阻断 owner 合并，TOLERATE 只放行、不 stage、不删除。
- dirty-gate 三态 classifier 收口：对 requirement-bound docs、evergreen docs、state/config/schema/contract、需求资产统一判定 OWN / TOLERATE / FOREIGN。
- association gate 外层与 gitlink executor 内层复用同一 classifier，保留正在同步的 submodule pathspec 容忍。

### Fixed
- 未跟踪的 state/config/schema/contract 与未声明机器产物保持 FOREIGN，避免无归属机器层变更被放行。
- 删除/改名的资产与 docs 仍视为 FOREIGN，防止 closeout 误提交或掩盖外部脏状态。

## v1.1.0 - 2026-06-08

CCB v1.1 — multispace worktree 运行时 + su-init 分层架构生成 + 文档表达规范 v1。

### Added
- Multispace worktree 运行时：多空间（含 submodule）需求的 worktree 编排——`expand requirement spaces on ensure` / `orchestrate multispace closeout` / multispace runtime data layer / sync submodule gitlinks。
- `su-init` 分层架构生成：检测架构候选、architecture scope metadata、layered architecture 生成流程。
- `document-expression-spec` v1：文档表达规范 + 4 个 node manifest 接入。

### Changed
- Requirement archive 生命周期拆分：merged 与手动 archive 分离，merged requirement 暂停等待人工归档。
- 拍板项闭环规则修订（kernel / 模板 / SKILL / 闸门）——对话闭环后才落档。

### Fixed
- worktree submodule 清理失败处理；plugin cancel 流程加固。

## v1.0.0 - 2026-05-22

CCB v1.0 plugin sovereignty 正式发布。Plugin 是主系统，Console 是可选 UI。

### Added (Phase 0-4 累计)
- `/ccb:su-reconcile` with drift detection, markdown reports, project-level locking, approval-gated apply, and `reconcile_*` / `state_reconciled` EventJournal events.
- `lib/state/` and `task-state-v0.1` schema: runtime task status/progress updates write to `docs/.ccb/state/<task_id>.md` instead of mutating subtask specs.
- `lib/runtime/` Phase 1 primitive runtime (safeWriteFile / withFileLock / validateAgainstSchema / appendEvent / errors).
- `lib/breakdown-draft/` Phase 2a + `lib/subtask/` Phase 2b: plugin direct file writes for plan domain.
- `lib/dispatch-parser/` ADR-0031: JSON structured payload (replaces `*_b64` business-layer hack).
- `lib/runtime/hook-notifier.mjs`: fail-open notification bridge to Console with localhost-only / 300ms timeout / debounced scanProject.
- Generated cross-runtime validators from `references/kernel/schemas/*.schema.yaml` for ADR-0026 field-ownership baseline.

### Changed
- Subtask spec schema documentation now states that dynamic status fields are initial-state fallback only; runtime projection is overridden by task-state files.
- Manual `business-rules.mjs` files now delegate to `generated-validator.mjs` (handwritten layer marked deprecated for v1.x removal).
- Console sovereignty cleanup: retired scheduler/outbox/drift write paths, projected plugin EventJournal into Console history, wired business state edits through anchor dispatch / generated validators.

### Removed (v1.0 clean start)
- Console scheduler / ProjectionOutbox / drift / transition-consumer-wrapper / ReactiveScheduler runtime modules.
- Status-repair endpoints (moved to plugin reconcile apply).
- `*_b64` business-layer encoding (replaced by structured JSON payload).
- Deprecated Prisma fields (stateHashProjection / stateRevisionSeen / step / legacyKind / generatedTaskId / planRevision / etc).

### Migration notes
- Console DB clean start: SQLite schema preserved, business data wiped on first start; indexer projects from `docs/.ccb/` files.
- Phase 1 `lib/runtime/` `appendEvent` is the canonical EventJournal write path; Console DB `EventJournal` is a projection, not a truth source (ADR-0027).
- ADR-0026 field ownership lint (`pnpm run lint:schema-ownership`) is fail-on-violation in CI.

## v0.10.0 - 2026-05-22

### Added
- Added fail-open EventJournal hook notifications to localhost Console, including the hook envelope schema and `scanProject` rescan receiver integration.

## v0.9.2 - 2026-05-22

### Added
- Added `anchor-dispatch` structured JSON payload schema and plugin dispatch parser.

### Changed
- Anchor dispatch examples now use `/ccb:<skill> --payload <json-object>` and reject feedback stays as native JSON instead of business-layer base64 encoding.

## v0.9.1 - 2026-05-22

### Changed
- Separated retired kernel YAML files from active kernel registries so stale files are not mistaken for current truth sources.

## v0.9.0 - 2026-05-22

### Added
- Added Phase 2b SubTask materialization library under `lib/subtask/`, including business-rule validation, deterministic subtask spec paths, EventJournal idempotency, and retry-safe handling for already-written specs.
- Added `subtask-spec` runtime schema documentation and validation support for `schema_version: subtask-spec-v0.1` markdown.

### Changed
- `transitionBreakdownDraftStatus` now supports the approved → consumed transition used after all materialized subtask specs are written.
- `/ccb:su-materialize-requirement` now documents the `lib/subtask.materializeRequirement` contract and forbids direct file writes.

## v0.8.2 - 2026-05-22

### Fixed
- Added breakdown-draft business rule validation for section ids, order continuity, owner values, dependencies, markdown quality, and review history before writes.
- `updateBreakdownDraft` now rejects sensitive status and lifecycle fields so state changes stay on `transitionBreakdownDraftStatus`.
- Runtime ISO8601 validation now rejects loose dates and normalized invalid dates while accepting UTC and offset datetimes.
- Schema YAML files now document that runtime structure checks and breakdown business rules are enforced in code.

## v0.8.1 - 2026-05-22

### Fixed
- Closed Phase 2a breakdown-draft runtime contract gaps: SKILL.md files now name the `lib/breakdown-draft` calls and forbid direct draft writes.
- `transitionBreakdownDraftStatus` now requires `expectedHash` and rejects stale status transitions.
- File locks now detect stale same-host owners left by dead processes and clean them once before retrying.
- File lock `owner.json` metadata is now written atomically through `safeWriteFile` to avoid owner write races.
- EventJournal idempotency scanning now skips malformed JSON lines with a warning instead of blocking append.
- `deleteBreakdownDraft` now writes the delete journal event before removing the draft file.

## v0.8.0 - 2026-05-21

### Added
- Phase 1 minimal write runtime under `lib/runtime/`: atomic safe writes, CAS conflict checks, file locks, schema validation, EventJournal append, and shared runtime error classes.
- Runtime schemas for `requirement-md-frontmatter` and `breakdown-draft`.
- Node.js runtime tests covering normal and failure paths for all five runtime capabilities.

### Changed
- `requirement-reanalyze` apply script now writes frontmatter through runtime lock + CAS + schema validation and appends a `file_written` EventJournal entry.
- `requirement-reanalyze` smoke test now verifies frontmatter and EventJournal integration.

## v0.6.0 - 2026-05-16

### Added
- `su-quick-archive` skill: thin facade for ADR-0021 status-repair primitive quick_archive path. Skips canonical review→archive transition, marks `reviewStatus='skipped_via_quick_archive'`. Suitable for fast-path maintenance.
- `su-status` skill: read-only status query. Compares DB fields vs spec/state .md frontmatter, highlights drift items. Does not call any write API.

### Context
- Implements ADR-0021 Phase 3 (CLI thin facade layer).
- Both skills are Layer 2 callers of the centralized status-repair primitive (`POST /api/tasks/:taskId/status-repair`).
- Companion server-side work: drift detector + Health panel UI + codex receipt bridge + AI tool registry.

## v0.5.0 - 2026-05-09

### Added
- Kernel hierarchy protocol for Requirement -> Epic -> SubTask.
- `task_kind`, `epic_status`, and `requirement_status` enums in `state-schema.yaml`.
- Task hierarchy fields: `kind`, `requirement_id`, `parent_epic_id`, `spec_section_id`, `implementation_owner`, `epic_status`, and migration audit fields.
- `applicable_kinds` in `node-manifest-schema.yaml`; all seven node manifests declare `[subtask]`.
- Epic and Requirement lifecycle manifests.
- `task_breakdown` hierarchy steps: `detect_planning_mode`, `create_epic_when_needed`, `create_subtask_batch`.
- Hierarchy capabilities, guards, transitions, templates, upgrade guide, and version matrix.

### Changed
- Plugin protocol version bumps to v0.5.0.
- Epic and Requirement no longer enter the seven-node workflow.
- SubTasks created from Epic planning inherit plan artifacts and start at `dispatch`.

### Breaking
- Downstream projects must refresh kernel snapshots before consuming console hierarchy work.
- Task consumers must become kind-aware (`epic` vs `subtask`).
