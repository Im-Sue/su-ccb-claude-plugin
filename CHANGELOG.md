# Changelog

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
