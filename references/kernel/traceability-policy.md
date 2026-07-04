---
doc_id: traceability-policy
title: Collaboration Trace Policy（可追溯 / 产物下限策略）
schema_version: ccb-reference-md-v1
introduced_by: 需求 yhbwmdxilidcvp0eh4mcwhud（协作流程按风险分级 · pr3）
status: active
---

# Collaboration Trace Policy

> 借鉴 `document-expression-spec` 的 R2「复杂度自适应 + 显式豁免」**模式**，提升为整个协作协议的留痕 / 产物下限语义。R2 是**表达层软规范**，本 policy 是**协议层**；本 policy 只借 R2 的模式（自适应 / 有下限 / 显式豁免），**不**把 R2 当协议 hard guard，也**不**改 R2。

## 一、原则

工程化管理的本质是**可追溯**，不是产物多。分级（`collaboration_profile`）缩的是协作仪式与产物详略，**缩不掉**三条档位无关的不变量：

1. **可追溯骨架恒定**：任何档位（含 lite）必留最小可追溯记录。
2. **详略随风险自适应、但有下限**：各产物类型设各自下限，「极小变更压到一行」合法，但**不许没有**。
3. **省略必显式豁免**：任何省略写明理由（`skip_with_provenance`），**沉默跳过不合格**。

## 二、可追溯骨架（跨档恒定 · BR9）

每个改动的 `collaboration_profile_decided` 事件必含以下骨架字段（`risk_basis` 不得吞掉其余结构化字段）：

- `actor` / `classified_by`
- `subject_id`、`change_summary`
- `ceremony_tier`、`classifier_coverage`、`pass`（planned / actual）
- `risk_basis`（判档依据，自然语言）
- `touched_surface[]`
- `negative_evidence[]`（走低档时「未触及高危面」证据，BR6；尽量由 classifier 自动生成）
- `waivers[]`（省略项 + 理由，BR11）
- `evidence_refs[]`、`verification_refs[]`
- `approver` / `authorized_by`（高风险档）
- `timestamp` / `idempotency_key`

## 三、artifact_minima（各产物下限 · BR10）

> 字段名在此冻结，供 `collaboration.profile` resolver（pr8）与节点 manifest（pr9）引用。每项取值形如 `{ floor, waivable, waiver_requires_provenance: true }`。

| product | floor（最低内容） | waivable |
|---|---|---|
| `requirement` | 一行目标 + `risk_basis` | 是（显式豁免） |
| `technical_design` | 方案取舍 + 风险；可显式豁免 | 是 |
| `dev_task` | **目标 / 范围 / 禁止 / 验收**（不可省） | 否 |
| `review` | **逐项 pass / fail / unknown** | 否 |
| `archive` | **完成证据 + 未覆盖项 + 剩余风险**（不可压一行） | 否 |

> 注：`dev_task` / `review` / `archive` 下限高于 `requirement` / `technical_design`——各产物下限**不统一**（需求 Y1-D5 / Codex round-2）。

## 四、waiver / negative_evidence / skip_with_provenance

- `waiver`：`{ action_or_artifact, reason }`——省略某动作 / 产物的显式理由。
- `negative_evidence`：`{ surface, evidence_ref }`——走低档时「未触及高危面」的证据（路径 / grep / classifier 输出）。
- `skip_with_provenance`：sc 指令或可选产物的豁免，`{ item, reason: "无需 X，因为…" }`；**沉默跳过 = 不合格**。

`skip_with_provenance` 是 anti-laundering 在留痕层的落地：与 `negative_evidence`（BR6）关联但分离，不合并成一个字段。

## 五、与 document-expression-spec R2 的边界

R2 管「单篇文档里要不要画图 / 给端到端示例」——表达层。本 policy 管「整个流程要不要留某产物 / 动作 + 留多少」——协议层。两者共享「自适应 + 有下限 + 显式豁免」的**思路**，但 R2 不被升格、不被本 policy 依赖为唯一真相源。
