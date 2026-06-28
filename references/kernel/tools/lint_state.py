#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CCB task state markdown lint。"""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path
from typing import Any

from lint_common import Issue, extract_frontmatter, read_text, repo_root, run_markdown_lint


REQUIRED_FIELDS = ["task_id", "status"]
HASH_RE = re.compile(r"^[0-9a-f]{64}$", re.I)
CANONICAL_TASK_STATUSES = {"reviewing", "done", "cancelled"}
POLICY_PROFILES = {"interactive-single", "autonomous-batch"}
LEGACY_POLICY_ALIASES = {"autonomous": "autonomous-batch"}
LEGACY_TASK_STATUS_ALIASES = {
    "proposed",
    "planning",
    "dispatch_ready",
    "dispatched",
    "waiting_for_user_arbitration",
    "replanning",
    "archived",
    "completed",
    "blocked",
    "epic_completed",
}
ENGINEERING_TOUCHPOINTS = {
    "U2_db_api_rename",
    "U3_task_status_derivation",
    "U5_migration_backfill",
}
REVERSIBILITY_CLASSES = {"reversible", "reversible_with_rollback"}
SCOPE_CLASSES = {"task_local", "module_local", "repo_local"}
CANONICAL_CONSISTENCY_CLASSES = {
    "projection_only",
    "api_compat_preserved",
    "existing_kernel_direction",
    "u1_u4_settled",
}
ENGINEERING_DECIDERS = {"claude", "codex_recommended", "codex-recommended"}
COLLABORATION_TIERS = {"full", "standard", "lite"}
CLASSIFIER_COVERAGE = {"full", "partial"}
COLLABORATION_PASSES = {"planned", "actual"}
SEMANTIC_OVERRIDE_TYPES = {"consult_only", "consult_plus_decision_record", "tier_floor"}
VERIFICATION_MINIMUMS = {"static", "targeted", "targeted_plus_edge", "integration", "full"}
RISK_SURFACE_TYPES = {"table", "api", "money_sink", "permission_scope"}
RISK_ENVELOPE_STATUSES = {"open", "partially_closed", "closed"}
ARTIFACT_MINIMA_FIELDS = {"requirement", "technical_design", "dev_task", "review", "archive"}
RISK_CLOSE_EVIDENCE_BY_SURFACE = {
    "table": {"migration_verified_ref", "rollback_or_compat_ref"},
    "api": {"contract_test_ref", "backward_compat_ref"},
    "money_sink": {"invariant_ref", "idempotency_ref", "reconciliation_ref"},
    "permission_scope": {"authz_matrix_ref", "privilege_negative_test_ref"},
}


def is_blank(value: Any) -> bool:
    return value is None or value == ""


def is_legacy_archived_without_hotfixes(frontmatter: dict[str, Any]) -> bool:
    # 兼容旧 docs/.ccb/state real-run；新 dev_task 不应再写 archived。
    return (
        frontmatter.get("status") == "archived"
        and "hotfixes_adopted" not in frontmatter
        and str(frontmatter.get("created", "")) <= "2026-04-22"
    )


def is_legacy_archive_container_status(frontmatter: dict[str, Any]) -> bool:
    # 兼容 v0.3.3 之前的 epic container；新 dev_task 不应再写 epic_completed。
    return (
        (frontmatter.get("current_node") or frontmatter.get("currentNode")) == "archive"
        and frontmatter.get("status") == "epic_completed"
        and frontmatter.get("kind") == "planning_container"
        and str(frontmatter.get("created", "")) <= "2026-04-23"
    )


def resolve_repo_path(root: Path, raw: Any) -> Path | None:
    if is_blank(raw):
        return None
    return (root / str(raw)).resolve()


def non_empty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and value.strip() != ""


def is_string_list(value: Any) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def lint_policy_profile(frontmatter: dict[str, Any], warn, error) -> None:
    policy_profile = frontmatter.get("policy_profile")
    if is_blank(policy_profile):
        return
    profile = str(policy_profile)
    if profile in POLICY_PROFILES:
        return
    if profile in LEGACY_POLICY_ALIASES:
        warn(
            "state_policy_profile_legacy_alias",
            f"policy_profile={profile} 是历史别名；按 {LEGACY_POLICY_ALIASES[profile]} 兼容处理",
        )
        return
    error("state_policy_profile_enum", f"policy_profile 非法: {profile}")


def lint_engineering_decidable_decisions(frontmatter: dict[str, Any], error) -> None:
    decisions = frontmatter.get("engineering_decidable_decisions")
    if decisions is None:
        return
    if not isinstance(decisions, list):
        error("state_engineering_decidable_decisions_type", "engineering_decidable_decisions 必须是数组")
        return

    for index, decision in enumerate(decisions):
        prefix = f"engineering_decidable_decisions[{index}]"
        if not isinstance(decision, dict):
            error("state_engineering_decidable_decision_type", f"{prefix} 必须是对象")
            continue

        def field(name: str) -> Any:
            return decision.get(name)

        required = [
            "id",
            "decision_ref",
            "touchpoint",
            "summary",
            "evidence_list",
            "reversibility_class",
            "scope",
            "tests_ref",
            "canonical_consistency",
            "decided_by",
            "created_at",
        ]
        missing = [name for name in required if is_blank(field(name))]
        if missing:
            error(
                "state_engineering_decidable_required_fields",
                f"{prefix} 缺少必需字段: {', '.join(missing)}",
            )

        touchpoint = field("touchpoint")
        if touchpoint not in ENGINEERING_TOUCHPOINTS:
            error("state_engineering_decidable_touchpoint", f"{prefix}.touchpoint 不在 U2/U3/U5 范围内")

        if not non_empty_list(field("evidence_list")) or len(field("evidence_list") or []) < 2:
            error("state_engineering_decidable_evidence", f"{prefix}.evidence_list 至少需要 2 条证据")

        reversibility = field("reversibility_class")
        if reversibility not in REVERSIBILITY_CLASSES:
            error("state_engineering_decidable_reversibility", f"{prefix}.reversibility_class 非法")

        scope = field("scope")
        if not isinstance(scope, dict):
            error("state_engineering_decidable_scope", f"{prefix}.scope 必须是对象")
        else:
            if scope.get("class") not in SCOPE_CLASSES:
                error("state_engineering_decidable_scope", f"{prefix}.scope.class 非法")
            if not non_empty_list(scope.get("paths")):
                error("state_engineering_decidable_scope", f"{prefix}.scope.paths 必须非空")
            if scope.get("external_contract_impact") is not False:
                error("state_engineering_decidable_scope", f"{prefix}.scope.external_contract_impact 必须为 false")

        if not non_empty_list(field("tests_ref")):
            error("state_engineering_decidable_tests", f"{prefix}.tests_ref 必须非空")

        consistency = field("canonical_consistency")
        if not isinstance(consistency, dict):
            error("state_engineering_decidable_canonical", f"{prefix}.canonical_consistency 必须是对象")
        else:
            if consistency.get("class") not in CANONICAL_CONSISTENCY_CLASSES:
                error("state_engineering_decidable_canonical", f"{prefix}.canonical_consistency.class 非法")
            if consistency.get("changes_kernel_semantics") is not False:
                error(
                    "state_engineering_decidable_canonical",
                    f"{prefix}.canonical_consistency.changes_kernel_semantics 必须为 false；否则必须升级用户",
                )
            if touchpoint == "U3_task_status_derivation" and consistency.get("class") != "u1_u4_settled":
                error("state_engineering_decidable_u3_boundary", f"{prefix} 的 U3 必须声明 U1/U4 已 settled")
            if touchpoint == "U3_task_status_derivation" and len(consistency.get("required_decision_refs") or []) < 2:
                error("state_engineering_decidable_u3_boundary", f"{prefix} 的 U3 必须引用 U1/U4 决策 ref")

        # U5 和显式 rollback 类迁移必须有 rollback_ref，否则无法满足可逆性。
        if (touchpoint == "U5_migration_backfill" or reversibility == "reversible_with_rollback") and is_blank(
            field("rollback_ref")
        ):
            error("state_engineering_decidable_rollback", f"{prefix}.rollback_ref 必须存在")

        if field("decided_by") not in ENGINEERING_DECIDERS:
            error("state_engineering_decidable_decider", f"{prefix}.decided_by 必须是 claude/codex_recommended")


def lint_collaboration_profile(frontmatter: dict[str, Any], error) -> None:
    profile = frontmatter.get("collaboration_profile")
    if profile is None:
        return
    if not isinstance(profile, dict):
        error("state_collaboration_profile_type", "collaboration_profile 必须是对象")
        return

    required = [
        "ceremony_tier",
        "classifier_coverage",
        "pass",
        "consult_required",
        "semantic_overrides",
        "artifact_minima",
        "verification_minimum",
        "risk_basis",
        "negative_evidence",
        "waivers",
        "evidence_refs",
    ]
    missing = [name for name in required if name not in profile]
    if missing:
        error("state_collaboration_profile_required_fields", f"collaboration_profile 缺少必需字段: {', '.join(missing)}")

    if profile.get("ceremony_tier") not in COLLABORATION_TIERS:
        error("state_collaboration_profile_tier", "collaboration_profile.ceremony_tier 必须是 full/standard/lite")
    if profile.get("classifier_coverage") not in CLASSIFIER_COVERAGE:
        error("state_collaboration_profile_coverage", "collaboration_profile.classifier_coverage 必须是 full/partial")
    if profile.get("pass") not in COLLABORATION_PASSES:
        error("state_collaboration_profile_pass", "collaboration_profile.pass 必须是 planned/actual")
    if not isinstance(profile.get("consult_required"), bool):
        error("state_collaboration_profile_consult_required", "collaboration_profile.consult_required 必须是 bool")
    if profile.get("verification_minimum") not in VERIFICATION_MINIMUMS:
        error("state_collaboration_profile_verification", "collaboration_profile.verification_minimum 非法")
    if not non_empty_string(profile.get("risk_basis")):
        error("state_collaboration_profile_risk_basis", "collaboration_profile.risk_basis 必须是非空字符串")

    overrides = profile.get("semantic_overrides")
    if not isinstance(overrides, list):
        error("state_collaboration_profile_overrides", "collaboration_profile.semantic_overrides 必须是数组")
    else:
        for index, override in enumerate(overrides):
            prefix = f"collaboration_profile.semantic_overrides[{index}]"
            if not isinstance(override, dict):
                error("state_collaboration_profile_override_type", f"{prefix} 必须是对象")
                continue
            if not non_empty_string(override.get("trigger")):
                error("state_collaboration_profile_override_trigger", f"{prefix}.trigger 必须是非空字符串")
            if override.get("type") not in SEMANTIC_OVERRIDE_TYPES:
                error("state_collaboration_profile_override_type", f"{prefix}.type 非法")

    artifact_minima = profile.get("artifact_minima")
    if not isinstance(artifact_minima, dict):
        error("state_collaboration_profile_artifact_minima", "collaboration_profile.artifact_minima 必须是对象")
    else:
        missing_artifacts = sorted(ARTIFACT_MINIMA_FIELDS - set(artifact_minima.keys()))
        if missing_artifacts:
            error(
                "state_collaboration_profile_artifact_minima_fields",
                f"collaboration_profile.artifact_minima 缺少字段: {', '.join(missing_artifacts)}",
            )
        for name in sorted(ARTIFACT_MINIMA_FIELDS & set(artifact_minima.keys())):
            if not non_empty_string(artifact_minima.get(name)):
                error("state_collaboration_profile_artifact_minima_value", f"artifact_minima.{name} 必须是非空字符串")

    if not is_string_list(profile.get("negative_evidence")):
        error("state_collaboration_profile_negative_evidence", "collaboration_profile.negative_evidence 必须是字符串数组")
    if not is_string_list(profile.get("evidence_refs")):
        error("state_collaboration_profile_evidence_refs", "collaboration_profile.evidence_refs 必须是字符串数组")

    waivers = profile.get("waivers")
    if not isinstance(waivers, list):
        error("state_collaboration_profile_waivers", "collaboration_profile.waivers 必须是数组")
    else:
        for index, waiver in enumerate(waivers):
            prefix = f"collaboration_profile.waivers[{index}]"
            if not isinstance(waiver, dict):
                error("state_collaboration_profile_waiver_type", f"{prefix} 必须是对象")
                continue
            if not non_empty_string(waiver.get("action_or_artifact")):
                error("state_collaboration_profile_waiver_action", f"{prefix}.action_or_artifact 必须是非空字符串")
            if not non_empty_string(waiver.get("reason")):
                error("state_collaboration_profile_waiver_reason", f"{prefix}.reason 必须是非空字符串")


def lint_risk_envelope(frontmatter: dict[str, Any], error) -> None:
    envelope = frontmatter.get("risk_envelope")
    if envelope is None:
        return
    if not isinstance(envelope, list):
        error("state_risk_envelope_type", "risk_envelope 必须是数组")
        return

    for index, item in enumerate(envelope):
        prefix = f"risk_envelope[{index}]"
        if not isinstance(item, dict):
            error("state_risk_envelope_item_type", f"{prefix} 必须是对象")
            continue

        surface = item.get("surface_ref")
        surface_type = None
        if not isinstance(surface, dict):
            error("state_risk_envelope_surface_ref", f"{prefix}.surface_ref 必须是对象")
        else:
            surface_type = surface.get("type")
            if surface_type not in RISK_SURFACE_TYPES:
                error("state_risk_envelope_surface_type", f"{prefix}.surface_ref.type 非法")
            if not non_empty_string(surface.get("id")):
                error("state_risk_envelope_surface_id", f"{prefix}.surface_ref.id 必须是非空字符串")

        if not non_empty_string(item.get("opened_by")):
            error("state_risk_envelope_opened_by", f"{prefix}.opened_by 必须是非空字符串")

        status = item.get("status")
        if status not in RISK_ENVELOPE_STATUSES:
            error("state_risk_envelope_status", f"{prefix}.status 必须是 open/partially_closed/closed")

        close_evidence = item.get("close_evidence")
        if status == "open":
            if close_evidence is not None and not isinstance(close_evidence, dict):
                error("state_risk_envelope_close_evidence", f"{prefix}.close_evidence 必须是对象")
            continue

        if not isinstance(close_evidence, dict):
            error("state_risk_envelope_close_evidence", f"{prefix}.close_evidence 在 partially_closed/closed 时必须是对象")
            continue

        required = RISK_CLOSE_EVIDENCE_BY_SURFACE.get(str(surface_type), set())
        present_required = [name for name in required if non_empty_string(close_evidence.get(name))]
        if status == "partially_closed" and required and not present_required:
            error("state_risk_envelope_partial_evidence", f"{prefix}.close_evidence 至少需要 1 条 {surface_type} 类型关闭证据")
        if status == "closed":
            missing = sorted(name for name in required if not non_empty_string(close_evidence.get(name)))
            if missing:
                error("state_risk_envelope_closed_evidence", f"{prefix}.close_evidence 缺少 {surface_type} 类型必需字段: {', '.join(missing)}")


def lint_state(path: Path, root: Path) -> list[Issue]:
    text = read_text(path)
    try:
        frontmatter, _body = extract_frontmatter(text)
    except Exception as exc:
        if "_模板_" in path.name:
            return []
        return [Issue("ERROR", "state_frontmatter_yaml", f"frontmatter YAML 解析失败: {exc}")]
    issues: list[Issue] = []
    doc_type = frontmatter.get("doc_type")
    if doc_type is not None and doc_type != "dev_task":
        return issues
    if not frontmatter:
        return issues
    legacy_exempt = is_legacy_archived_without_hotfixes(frontmatter)

    def error(rule_id: str, message: str) -> None:
        issues.append(Issue("ERROR", rule_id, message))

    def warn(rule_id: str, message: str) -> None:
        issues.append(Issue("WARNING", rule_id, message))

    missing = [field for field in REQUIRED_FIELDS if field not in frontmatter]
    if "current_node" not in frontmatter and "currentNode" not in frontmatter:
        missing.append("current_node")
    if missing:
        message = f"frontmatter 缺少必需字段: {', '.join(missing)}"
        if legacy_exempt and "spec_hash" in missing:
            warn("state_required_fields_legacy_warn", message)
        else:
            error("state_required_fields", message)

    status = frontmatter.get("status")
    current_node = frontmatter.get("current_node") or frontmatter.get("currentNode")
    legacy_archive_container = is_legacy_archive_container_status(frontmatter)

    if status not in CANONICAL_TASK_STATUSES:
        if status in LEGACY_TASK_STATUS_ALIASES:
            warn("state_status_legacy_alias", f"status={status} 是旧 task_status；新 dev_task 仅允许 reviewing/done/cancelled")
        else:
            error("state_status_enum", f"status 非法: {status}")

    spec_path = resolve_repo_path(root, frontmatter.get("spec_path"))
    if spec_path is not None and not spec_path.exists():
        error("state_spec_path_exists", f"spec_path 不存在: {frontmatter.get('spec_path')}")

    spec_hash = frontmatter.get("spec_hash")
    if not is_blank(spec_hash):
        if not HASH_RE.match(str(spec_hash)):
            error("state_spec_hash_format", "spec_hash 必须是 64 位 sha256 hex")
        elif spec_path is not None and spec_path.exists():
            actual = hashlib.sha256(spec_path.read_bytes()).hexdigest()
            if actual.lower() != str(spec_hash).lower():
                error("state_spec_hash_matches_file", "spec_hash 与 spec_path 文件内容不匹配")

    if status == "done" and current_node != "archive":
        error("state_status_current_node_consistency", "status=done 时 current_node/currentNode 必须为 archive")
    if legacy_archive_container:
        warn(
            "state_status_current_node_legacy_alias",
            f"current_node=archive 的旧容器状态 {status} 按 done 兼容处理",
        )

    if status == "done" and is_blank(frontmatter.get("archived_at")):
        warn("state_archived_at_warn", "status=done 但缺少 archived_at")
    if "hotfixes_adopted" not in frontmatter:
        warn("state_hotfixes_adopted_warn", "缺少 hotfixes_adopted；旧任务可接受，新任务建议补齐")

    lint_policy_profile(frontmatter, warn, error)
    lint_engineering_decidable_decisions(frontmatter, error)
    lint_collaboration_profile(frontmatter, error)
    lint_risk_envelope(frontmatter, error)

    return issues


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Lint CCB task state markdown")
    parser.add_argument("paths", nargs="+", type=Path, help="state 文件或目录")
    parser.add_argument("--root", type=Path, default=None, help="仓库根目录，默认自动推导")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = args.root.resolve() if args.root else repo_root()
    return run_markdown_lint(args.paths, lint_state, root)


if __name__ == "__main__":
    raise SystemExit(main())
