---
schema_version: ccb-plugin-independent-operation-v1
status: active
---

# Plugin 独立运行通用约定

本文件是各 `skills/*/SKILL.md` 中「Plugin 独立运行约定」的共享段。各 skill 仍在本地保留自己的读写对象、helper 和输出要求。

## 通用约定

1. 启动或定位上下文时，先读 `docs/00_项目总览.md`、`docs/00_文档地图.md` 和 `docs/.ccb/docs-structure-contract.yaml`。
2. Requirement、technical_design、dev_task、ADR 等业务文档落点必须经 docs-structure resolver / 目录契约定位。
3. 人读 docs、frontmatter、EventJournal、draft 和 state 文件是 plugin 业务真相源；`.ccb` 只承载 state、events、draft、report、lock、index cache、schema/config 等机器协调件。
4. 不调用 Console 业务写入接口作为业务真相源，也不通过 Console 写业务状态；Console 可作为触发器、投影展示或显式标注为 best-effort 的投影收敛加速。
