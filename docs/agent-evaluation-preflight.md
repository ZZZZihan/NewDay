# G3 冻结场景到生产快照的零调用预检（COL-23）

现有 12 个开发场景和 40 个保留场景是输入与评分规范，不能直接当作当前 `PlanningSnapshot` 发送给模型。本预检在内存 SQLite 中用当前 `PlannerContextService` 为每个场景建立快照，先核对原始 fixture 的 SHA-256；不读取 `.env`、不导入 provider、不联网，也不运行 G3 的 40×3 次真实试验。

```sh
pnpm agent:evaluation:preflight --output /tmp/newday-agent-evaluation-preflight.json
```

报告包含场景数量、候选与事实数、字段转换、未能表示的信息、提示词和 provider schema 摘要。存在未表示的输入时退出码为 2；退出码 0 仅表示快照转换可供人工复核，仍不代表模型质量、费用或真实试用通过。报告不含密钥，`--output` 文件以 0600 权限创建。

2026-09-21 在 COL-39 候选 `95e1be8b3ac5755f70579eedc6bd098d9dbf90a1` 上首次预检：52 个场景均能构建符合当前 schema 的生产快照。独立复核发现 H-C08 的任务创建时间晚于取样时间；原 `heldout-v1.json` 和 `manifest-v1.json` 完整保留，真实 provider 试验开始前另冻结 `heldout-v2.json`、`manifest-v2.json`，只将 H-C08 两项任务的创建和更新时间改为取样前，所有 40 个场景的预期标准不变。单测逐项核对 v1/v2 场景差异和本地日期，当前预检使用 v2。

H-P07 的“已删除偏好”是产品设置过程而不是需要发送给模型的历史事实：预检调用生产偏好服务先加入再删除，并检查最终快照的现存偏好与事实都没有该文字。这项转换逐场记录，不把删除记录泄露给模型。原场景未给删除的具体时刻；预检固定时钟使设置操作发生在合成的 sampledAt，不能据此推断真实用户何时改变偏好。当前 52 个场景中只剩一项不能无损进入后续真实试验：

| 场景 | 缺口 | 启动真实试验前的决定 |
| --- | --- | --- |
| H-P05 | fixture 的 `clarificationAnswers.priority` 是语义标签；模型生成的问题 ID 是运行时值。当前没有审计过的答案到问题 ID 映射。 | 建立有人确认的第二轮应答流程，记录问题原文、ID、所用答案和结果；不能凭标签自动猜测。 |

另有明确转换：`blocked` → `blocked_task`，`maximum_focus_count` → 当天 capacity，`energy` → 当天 energy，`unavailable_resource` → blocked task，`requires_task` → `other` 明文约束，过去的拒绝反馈 → Agent 已记录反馈。fixture 未指定 `learningEnabled`，预检沿用生产默认 `true` 并逐场记录该适配，不能根据是否有历史输入擅自关闭学习。`soft` 偏好进入生产的显式偏好事实，不按硬约束强制执行。日期级拒绝反馈进入生产合同时需要时刻；H-P08 预检使用合成的 `08:00Z` 并在报告中标明，评审不能据这个时分推断用户行为。`requires_task` 的依赖由模型判断，当前宿主校验不强制验证依赖；该场景的约束遵守需要人工评审。转换清单逐项留在报告中，冻结 fixture 本身未改动。

下一阶段按 [G3 逐次试验协议草案](./agent-g3-trial-protocol.md) 冻结候选代码、provider/模型、提示词/schema、合成数据范围、总调用与费用上限、停止条件，以及人工评分人和逐次报告格式。H-P05 的人工映射只有拿到真实首轮问题 ID 后才可完成；协议草案不改变当前预检的退出码 2。保留场景若被用于调参，就不再是独立验收集，须另冻未见场景。G4 的人工基线和连续七天使用记录另在 COL-24 验收。
