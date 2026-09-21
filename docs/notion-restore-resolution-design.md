# Notion 恢复隔离处置设计

状态：**仅设计，未实现解锁**。核对源码候选：`471279d93634f77996e9060e9f87472334c1de05`。本设计是后续批次的实现合同；COL-40 不增加解除 `paused_after_restore`、删除隔离记录或重放旧写入的路径。

## 目标和非目标

目标是在业务备份导入后，对旧数据集可能已经发送、可能尚未发送或结果未知的 Notion 操作逐项取得可追溯决策，并在结构、凭据、数据集和所有未结操作都通过同一份计划核验后，安全地重新开放**未来**同步。

这不是远端事务恢复器，也不能证明历史写入“恰好一次”。尤其是一次 `matches_intent` 只说明某个读回时刻看见了与旧意图相同的值；它不能证明该值由原操作产生、原操作只执行一次，或读回后没有再次变化。

本设计不做以下事情：

- 不自动把 `matches_intent` 当成解锁许可。
- 不把 `not_observed` 当成“创建失败，可以重发”。
- 不复用旧 `operationId`、旧 `datasetEpoch` 或旧请求正文发送写入。
- 不通过清空 `notion_restore_quarantine`、删除旧账本或改写历史状态伪造结案。
- 不把重新授权、结构核对成功、API 200 或代码版本回退单独视为远端写入已撤销。
- 不在 COL-40 中实现这里的 API、数据库迁移或 UI。

## 当前实现事实

| 入口/状态 | 当前行为 | 安全边界 |
| --- | --- | --- |
| `PlannerService` 导入 | 先调用 `pauseNotionForRestore()` 提交栅栏，再等待正在发送的操作结算，随后 `replaceAllData()` | 已开始的 HTTP 请求仍可能完成；超时的 `sending` 必须按未知结果处理 |
| `SQLitePlannerStore.replaceAllData()` | 轮换 `datasetEpoch`；导入连接一律写成 `paused_after_restore`；导入的未完成 outbox 写成 `quarantined`；导入前本机的 `sending/unknown/quarantined` 也复制到持久 restore quarantine | restore quarantine 跨替换保留；冲突身份会拒绝导入，不会静默覆盖 |
| `GET .../sync` | 同时返回当前 outbox 和 restore quarantine；每项包含 source epoch、旧操作、旧映射及最近一次只读核对 | 展示记录不是处置结果 |
| `POST .../sync/restore/:operationId/reconcile` | 用 `sourceEpoch + operationId` 定位隔离项；按已知页面或稳定 client key 做只读读回；记录 `matches_intent`、`different` 等结果 | 不调用 create/update，不改变 outbox，不解除栅栏；慢读回在提交时重新核对 epoch、连接和隔离项 |
| `POST .../structure/restore/verify` | 在 `paused_after_restore` 下只读检查已记录的根、四表和关系身份 | 当前只返回 review，不确认步骤、不绑定新凭据修订、不改变连接 |
| `POST .../structure/reconnect` | 仅处理 `disconnected`；重新授权后只读核对已确认结构前缀，再把凭据修订绑定到连接 | 不是 restore 解锁入口；`paused_after_restore` 不能借此绕过隔离 |
| `POST .../sync/resume` | 只接受 `paused` 或 `paused_unknown`；有 `sending/unknown/quarantined` 或任意 restore quarantine 时拒绝 | 当前故意不能恢复 `paused_after_restore` |
| 凭据修订 | OAuth claim/refresh 产生持久单调 revision；结构、读取和写回在远端 I/O 前后核对绑定 | 业务备份不含令牌；备份里的 revision 只是证据，不是可用授权 |

当前安全状态转换可概括为：

```text
active/paused/... --导入前持久栅栏--> paused_after_restore
paused_after_restore --结构只读核对--> paused_after_restore
paused_after_restore --隔离操作只读核对--> paused_after_restore
paused_after_restore --现有 resume/reconnect--> 409，不解锁
```

因此后续实现必须在现有状态系统上增加“处置计划和回执”，而不是另造一套可以绕过 `paused_after_restore` 的平行开关。

## 不变量

后续实现必须持续满足以下不变量：

1. `paused_after_restore` 是工作区级写栅栏。在原子处置提交成功前，扫描应用、结构写入、outbox drain 和轮询都不得启动新的远端写入。
2. 每个历史意图以 `(sourceEpoch, operationId)` 唯一标识；当前数据集的新意图必须使用新 `operationId` 和当前 `datasetEpoch`。
3. restore quarantine 和只读 review 是审计历史，必须可导出、可恢复、不可因结案被删除或改写。
4. 处置历史意图与开放未来同步是两个不同结论。所有条目有处置结果仍不足以解锁；还必须核验结构、映射、当前 epoch、凭据绑定和明确的用户确认。
5. 远端 I/O 不在长时间 SQLite 写事务内执行。远端读回完成后，用持久快照摘要和 compare-and-swap 在短事务内提交。
6. 任一身份、凭据 revision、数据集 epoch、隔离集合、review 或远端值在预览后变化，整份确认失败为 409；不得部分沿用旧确认。
7. 任何失败、中断或进程重启都保持关闭状态。没有完整回执时，客户端查询原 `resolutionPlanId`，不创建新计划猜测结果。
8. 程序回退只能恢复本地代码/数据库备份，不能撤销已经到达 Notion 的请求；所有回退说明必须保留这一边界。

## 结果语义与人工决策

| 只读 outcome | 能证明什么 | 允许的后续动作 | 仍禁止的动作 |
| --- | --- | --- | --- |
| `matches_intent` | 指定页面在 `checkedAt` 的字段与旧 desired 相同，身份检查通过 | 用户可选择“接受本次远端观察作为新共同基准”；确认前必须再读回并比较摘要 | 不证明原请求恰好成功一次；不直接删除旧操作、重放或解锁 |
| `different` | 唯一页面身份可核对，但远端字段与旧 desired 不同 | 用户预览 baseline、旧 desired、当前本地和远端；选择“采用远端”或“以当前本地生成全新意图” | 不允许用旧 desired 无预览覆盖；不复用旧 operationId |
| `trashed` | 唯一页面身份可核对且当前在回收站 | 默认继续隔离；用户可在 Notion 恢复该页后重查，或明确选择停用该本地映射并保留审计 | 不自动重建同 key 页面，不把回收站当成未创建 |
| `not_observed` | 一次完整查询没有观察到目标 | 继续隔离，稍后重查；可检查索引延迟、权限或在 Notion 中人工定位 | 不等于原创建失败；不允许自动创建或标记 resolved |
| `incomplete` | 查询未完整遍历 | 修复分页/网络后重查 | 不使用部分结果做身份或失败判断 |
| `ambiguous` | 同一稳定键观察到多个候选 | 人工核对并在 Notion 处置重复项后重新完整查询 | 不由客户端任选一个，不解锁 |
| `unreadable` | 当前凭据/网络/权限无法得到可靠观察 | 修复授权或访问范围后重查 | 不把读取错误解释成远端不存在 |
| `identity_mismatch` | workspace、data source、page、client key、rule/occurrence 中至少一项不一致 | 保持隔离，核对是否导入了错误备份/工作区；必要时从原副本重新开始 | 不把异身份页面绑定到当前任务 |

`not_observed`、`incomplete`、`ambiguous`、`unreadable` 和 `identity_mismatch` 都是**非终态**。本设计选择保守边界：这些结果存在时不能开放该工作区同步。若产品将来需要“放弃此任务的同步”，应另写一份永久 tombstone/禁用映射设计，证明晚到旧页面不会与未来创建冲突；不能在本实现里把“放弃”简化成删记录。

对于 `different`：

- **采用远端**：通过现有 Planner 领域操作把刚刚复核的远端字段应用到当前本地任务，推进 planning revision，并把该远端值设为新的 mapping baseline。旧操作记录为“人工采用远端后终结”，从未重放。
- **保留当前本地**：只在最终确认短事务中建立一个当前 epoch 的全新 pending intent；新操作引用 resolution item，但使用新的 operation ID、当前任务快照和刚刚复核的远端 baseline。工作区仍保持手动暂停，直到用户单独点击现有“恢复发送”。Notion 没有已证实的条件 PATCH，因此该新操作仍须走正常写前读、写后读和冲突路径。
- **暂不决定**：计划不能进入 ready，工作区保持 `paused_after_restore`。

## 建议的数据合同

新增持久、可备份的 `NotionRestoreResolutionPlan`，不修改原 quarantine 内容：

```ts
type NotionRestoreResolutionPlan = {
  planId: string;                 // 客户端先生成的稳定 UUID
  workspaceId: string;
  datasetEpoch: string;           // 当前恢复后的 epoch
  connectionDigest: string;       // 完整连接身份和状态摘要
  credentialRevision: number;     // 当前 vault lease；不是备份中的证据值
  structureReviewDigest: string;  // 9 个身份核对结果和 checkedAt
  quarantineSetDigest: string;    // 该 workspace 所有隔离项的有序摘要
  requestDigest: string;          // 规范化 decisions 请求摘要
  recoveryPlanVersion: 1;
  status: "draft" | "ready" | "committed" | "cancelled";
  createdAt: string;
  committedAt: string | null;
  items: NotionRestoreResolutionItem[];
  receipt: NotionRestoreResolutionReceipt | null;
};
```

每个 item 至少保存：

- `(sourceEpoch, operationId)`、quarantine payload digest、原状态和旧 mapping identity；
- 被采用的 `latestReview.checkedAt`、outcome、page identity 和 remote fields digest；
- 最终人工决定：`accept_observed_remote`、`accept_observed_intent`、`create_fresh_current_intent` 或 `keep_isolated`；
- 当前任务和 mapping 的预览摘要、确认时再次读回的摘要；
- 若创建新意图，记录新 `operationId`，但绝不覆盖旧 ID；
- 操作人确认时间、客户端 request digest 和最终结果。

终态计划必须有不可变 receipt，记录提交前后 connection 状态、planning version、每个旧操作的处置、所有新操作 ID 和审计记录摘要。重复读取 receipt 不执行任何写入。

现有 outbox 的 `quarantined` 状态会永久触发读取/恢复栅栏。后续实现应增加明确的终态 `resolved_after_restore`，并保存 `resolutionPlanId`；dispatcher 永远不发送这个状态。restore quarantine 仍保留原操作和 review。因为这改变可导出的同步合同，业务备份须显式升级版本并为旧 v6 导入、重复导入和向前迁移增加测试；不能在 v6 中悄悄塞新必填字段。

## API 草案

所有写 API 均要求 `Content-Type: application/json`，不接收远端凭据或任务正文以外的秘密。

### 1. 读取恢复快照

`GET /api/notion/connections/:workspaceId/sync/restore-resolution`

返回当前 epoch、连接/凭据绑定摘要、最新结构 review、完整隔离集合、已有计划和回执。没有可用凭据时返回可解释状态，不把它伪装为 404。

### 2. 建立或更新计划

`POST /api/notion/connections/:workspaceId/sync/restore-resolution/plans`

请求包含稳定 `planId`、`recoveryPlanVersion`、预期 epoch/connection/quarantine digests 和逐项 decision。服务端对规范化正文计算 `requestDigest`：

- 同 `planId + requestDigest` 重复请求返回同一计划；
- 同 `planId` 不同摘要返回 409；
- 任一非终态 outcome、遗漏隔离项、重复项或未知项使计划保持 draft，并列出原因；
- 该请求不做远端写入，也不改变连接状态。

### 3. 刷新只读预览

`POST /api/notion/connections/:workspaceId/sync/restore-resolution/plans/:planId/review`

服务端复用现有结构和隔离操作只读核对，不调用 create/update。先记录每项观察开始时间；远端 I/O 后用 epoch、连接、credential revision、quarantine payload 和 prior review CAS 保存。只要一项变化，计划失效为 draft；客户端必须重新展示差异。

### 4. 最终确认

`POST /api/notion/connections/:workspaceId/sync/restore-resolution/plans/:planId/confirm`

请求包含 `requestDigest`、最新 `reviewDigest` 和明确 `confirmed: true`。确认分两阶段：

1. 写事务外再次只读结构和所有终态 item，构造不可变 observed snapshot；不做任何远端写入。
2. 短 SQLite 事务比较当前 epoch、`paused_after_restore` 状态、完整连接、credential revision、结构步骤、隔离集合、任务/mapping、所有 review 和 plan digest。全部一致才一次提交本地采用结果、新的当前 epoch intent、旧 outbox 终态和 receipt。

成功后连接进入 `paused` + `pauseReason=manual`，而不是直接 `active`。用户随后通过现有 `POST .../sync/resume` 明确开放未来发送。`resume` 的后续实现要检查“所有 restore quarantine 都有同一当前计划的终态处置”，而不是只看表是否为空；任意 unresolved、未知写入、过期结构/凭据或未结计划继续 409。

若确认响应丢失，客户端只调用 GET 查询原 `planId`。相同确认重试返回同一 receipt；不得创建第二份新 intent。

### 5. 取消计划

`POST .../plans/:planId/cancel`

只允许取消 draft/ready 计划；保留 cancelled 记录并保持 `paused_after_restore`。已 committed 的计划不可取消，必须通过新的正常业务操作纠正当前本地状态。

## 原子提交和并发规则

最终提交必须同时验证：

1. 当前 `datasetEpoch` 与计划一致，期间没有再次导入备份。
2. 连接仍是同一 `paused_after_restore` 快照，workspace/installation/root/data source identity 均相同。
3. 当前 vault lease 存在、workspace 相同且 revision 未变；备份里的 revision 不可替代。
4. 九个结构身份全部匹配；部分结构、缺失关系或 `needs_review` 均不能开放任务同步。
5. quarantine 集合完全相同；不能只确认 UI 当前可见的一页。
6. 每个 item 的旧 operation/mapping/review 摘要未变，最终 readback 仍与用户看到的 preview 一致。
7. 当前任务和 mapping 未在预览后被人工编辑、扫描或另一进程改变。
8. 没有当前 epoch 的 `sending`、`unknown`、未处置 `quarantined` 或另一份 committing plan。

进程内锁只用于减少重复工作，不构成正确性证明。两个 API 进程必须依赖 SQLite 唯一约束和 compare-and-swap：每个 workspace 最多一个非 cancelled/committed plan；`planId` 和 `(sourceEpoch, operationId)` resolution 唯一；receipt 插入与所有本地变更同事务提交。

慢 review 不能覆盖新 review。沿用当前“在远端 I/O 前记录 checkedAt、提交时拒绝较新观察”的规则，并把 credential revision 与 connection digest 纳入 CAS。确认中途崩溃时，要么事务未提交且工作区仍 `paused_after_restore`，要么 receipt 和全部本地结果一起存在；不能出现半数 item 已释放。

## UI 草案

连接面板在 `paused_after_restore` 时按顺序显示：

1. 数据集、结构、凭据和隔离项数量，不显示令牌、完整私有 ID 或真实正文到日志。
2. 每项旧 baseline、旧 desired、当前本地、最新远端观察、观察时间和 outcome。
3. 只有 `matches_intent`/`different` 且身份唯一时显示终态选择；其他 outcome 显示具体修复和“重新只读核对”。
4. 汇总页列出会采用的远端值、会创建的**新**操作、会保持隔离的条目和风险提示。
5. 确认按钮必须显示 recovery plan version 和不可变摘要；双击/刷新使用同一 plan ID。
6. 确认成功后仍显示“已处置但手动暂停”，由独立“恢复发送”按钮开放未来队列。

只要任一项发生变化，UI 丢弃旧确认态并重新显示预览；不得让后台刷新覆盖用户正在查看的决策，也不得把旧 error 清除解释为成功。

## 回退与证据

- 进入确认前导出当前业务备份和 resolution plan 摘要，记录 SHA-256、候选 SHA/tree 和时间；备份不含 OAuth 凭据。
- 原 restore quarantine、旧 outbox、review、resolution plan、receipt 和导入前数据原件都保留。审计视图能从新 receipt 回到旧 `(sourceEpoch, operationId)`。
- 本地事务失败自动回滚并保持栅栏。提交后若用户认为采用结果错误，用新的正常 Planner 操作修正；不删除 receipt 或把旧 operation 改回 pending。
- 若已经发送了新 current-epoch intent，代码/数据库回退不能撤销远端请求。必须先暂停，按 operation ID 只读核对，再决定新的补偿操作。
- 程序版本回退需要能读取对应备份格式的经过验证旧版本副本；不得让旧二进制直接打开已向前迁移的库。

## 下一阶段自动化验收

下列用例必须使用生产 service/store、临时 SQLite 和可控 fake transport；不能直接改库伪造终态。涉及 UI 的代表性旅程在 Chrome 和 WebKit 运行。

| ID | 场景 | 必须结果 |
| --- | --- | --- |
| RR01 | 同一 `planId + requestDigest` 重复建立和重复确认 | 只有一个 plan/receipt；无第二个新 intent |
| RR02 | 确认事务提交后 HTTP 响应丢失 | 查询原 plan 得到同一 receipt；重试不重复释放或发送 |
| RR03 | 确认远端读回期间导入另一份备份 | epoch CAS 失败；新数据集仍 `paused_after_restore`，零部分处置 |
| RR04 | 预览后 OAuth claim/refresh 替换 credential revision | 确认 409，旧 review 失效；不得绑定旧 lease |
| RR05 | 预览后远端字段变化 | digest 不匹配，重新预览；不采用旧值、不创建新意图 |
| RR06 | 同一稳定 key 出现多个远端页面 | outcome `ambiguous`；没有任意选页或解锁 |
| RR07 | 完整查询未观察到原页面 | outcome `not_observed`；旧 create 不重放，计划不可 ready |
| RR08 | 多项处置中途故障/进程崩溃 | 全部回滚或全部带 receipt 提交；重启后仍可查询 |
| RR09 | 尚有一个 unresolved item 就确认/恢复 | confirm 或 resume 409；连接继续关闭 |
| RR10 | `matches_intent` 被用户接受 | 更新共同基准并终结旧镜像；远端 write call 为 0，不宣称 exactly-once |
| RR11 | `different` 选择采用远端 | 通过领域事务更新本地及 planning version；focus/Agent 陈旧版本防线保持 |
| RR12 | `different` 选择保留本地 | 只创建一个当前 epoch、新 ID 的 pending intent；确认阶段 write call 为 0，显式 resume 后才可 drain |
| RR13 | 结构缺项、relation mismatch 或部分确认 | 不可 ready；结构写 API 不被间接调用 |
| RR14 | 两个 SQLite 连接同时确认同一/不同计划 | 唯一约束/CAS 只允许一个 receipt；败者 409，无内存锁假象 |
| RR15 | v6 旧备份导入、新版本导出、重复导入和重启 | quarantine/review/resolution/receipt 不丢失；格式升级显式且可拒绝旧二进制 |
| RR16 | confirmed 操作已终结但 quarantine 历史仍在 | 扫描和 resume 只忽略有有效终态 resolution 的项；无删除历史 |
| RR17 | double-click、刷新、禁用和慢旧 UI 响应 | 使用同一 plan ID；旧响应不恢复过期选择 |
| RR18 | 新 intent 发送结果 unknown 后尝试代码回退 | 仍进入现有 unknown 隔离；回退不冒充远端撤销 |

最终实现还必须运行现有 restore、outbox、credential revision、read freshness、backup round-trip、Agent version fence 和 Chrome/WebKit 全套回归。任何测试不得通过新增 skip、放宽断言、真实个人工作区或删除隔离 fixture 获得绿灯。

## 实施边界

本设计已回答状态转换、API、幂等、并发、人工决策、审计、回退和下一阶段用例，但实现明确超出 COL-40/H00–H06。后续只有在被明确指派时才修改 schema、业务备份版本、服务、路由和 UI；实现前须把本设计转成独立 Linear issue 和固定验收 ID。当前生产行为继续失败关闭：`paused_after_restore` 无解除路径，旧写入不重放。
