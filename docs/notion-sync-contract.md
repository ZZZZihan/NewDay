# Notion 联动契约 v1（COL-32 候选）

审阅基线：PR #1 `61be91776160e2aa6028f75840d2cd26bea39df0`、PR #2 `1a64aed1e9928d4491ef92eb439a0352081879bc`。本文件定义待实现行为；这两个 PR 都不含 Notion 联动。2026-09-20 的官方文档核对与代码基线测试见文末。真实 Notion 工作区、OAuth、条件写入及数据恢复尚未验收。

## 1. 数据归属和阶段

NewDay 继续以本机 API/SQLite 执行任务命令。Notion 管理主线、项目和新增的联动重复规则；NewDay 读取其名称、关系与链接。已关联的一次性任务和重复实例只共享标题、计划日期范围及完成状态。备注、今日重点、偏好、Agent 记录和本地资料留在 NewDay。已有本地任务与重复规则不自动迁移，也不因连接成功回传。

M2 只读读取，联动任务的本地修改入口禁用；M3 才启用经过故障验收的双向写回。用户在 NewDay 新建的联动一次性任务先有本地 UUID，即使离线且本机 API 仍运行，也可以在同一 SQLite 事务中保存待发送操作。API 停止时浏览器不能假装保存成功。断开连接后新建任务为纯本地任务。

## 2. 远端版本、权限和结构

- 固定 `Notion-Version: 2026-03-11`；计划使用精确版本 `@notionhq/client@5.23.0`，创建连接时显式传 `notionVersion`。2026-09-20 检查了已发布 npm 包：`ClientOptions` 支持 `notionVersion` 与 `retry: false`，`Client.defaultNotionVersion` 仍为 `2025-09-03`；类型含 `initial_data_source`、`data_source_id`、`in_trash` 与查询响应的 `request_status`。原候选 5.12.0 的查询响应类型没有 `request_status`，不足以类型安全地识别已到结果上限的不完整扫描。因此不能依赖 SDK 默认版本，也不能只检查 `has_more`。正式同步客户端禁用 SDK 自动重试，由应用按本契约记录尝试、读取 `Retry-After` 并做有界重试。上线前仍须用项目安装后的 SDK 类型检查及真实隔离工作区读写再次验证。
- 公共 OAuth 的 client secret 只在 Worker；浏览器不接收长期 access/refresh token。Worker 只处理回调、code 交换、刷新和一次性安全领取，本机 API 存储凭据且与业务备份隔离。每次授权绑定不可重放的 `state`、本机安装会话和明确的回调目标；令牌轮换须原子替换。
- 公共连接可在用户的 Private 区域创建 workspace 级根页面。首次发送创建请求前，在本地持久化随机的 128 位安装标记和固定根标题 `NewDay (<标记>)`，并记录该标记的 POST 尝试；同一标记最多自动发送一次。标记位于**标题**，因为 Notion Search 按标题查询，不能按页面正文查找。若创建响应丢失，用同一 OAuth 工作区凭据按标记搜索并读完搜索分页；仅在本地确认此前只有一次创建尝试、结果中恰有一条标题完全相同且父级为 workspace 的页面时绑定。零条或多条均进入待核对，不能直接再次创建。Notion Search 有索引延迟且不保证完整枚举；即使已绑定，后来发现第二条同标记根页面也须暂停并提示人工核对。零条尤其不能证明创建失败；可稍后重试查询或由用户核对，不自动发第二次 POST。
- 结构顺序：根页面、Areas、Projects、Tasks、Rules 基础结构、关系属性、逐项读回。四张表逐一创建。**每张表在 POST 前**，以同一 SQLite 事务持久化工作区 ID、根页面 ID、步骤名、预期标题及 schema 指纹、`attempted` 状态；每个步骤最多自动发送一次 POST。进程重启时，只要该步骤存在 `attempted` 而没有已读回确认的 ID，就先分页读完已知根页面的子块，再读取候选 database/data source 与属性：恰好一张父级、精确标题、schema 指纹及关系目标均匹配的表才绑定其 `database_id`、`data_source_id` 与属性 ID。零张、多张、读不完整或属性不符均进入待核对，绝不因本地缺少响应或未存 ID 而重复 POST。持久化尝试后、请求真正发出前崩溃也会停在待核对；需要人工确认未创建后才能显式重新开始该步骤。关系属性等后续非幂等结构操作同样先记录尝试、重启先读回对账。每步只在读回确认后推进本地初始化状态。
- 每张表同时保存 `database_id` 与 `data_source_id`。创建表使用 database API 的 `initial_data_source.properties`；查询行、创建行的父级和关系指向具体 data source。保存每个实际属性 ID，后续按 ID 读写；重命名属性不靠名称猜测。字段类型或关系目标改变时暂停相关行处理并报错。

### 四张表的 v1 属性

表中名称是首次创建时的显示名；运行时使用创建后读回的属性 ID。

| 表 | 属性（Notion 类型） | 规则 |
| --- | --- | --- |
| Areas | `Name`（title） | Notion 页面 ID 是主线身份；NewDay 只读名称和页面链接。 |
| Projects | `Name`（title）、`Area`（relation → Areas） | 恰好一个可访问主线；异常关系不取第一项，标记待核对。 |
| Tasks | `Name`（title）、`Plan Date`（date）、`Completed`（checkbox）、`Project`（relation → Projects）、`Direct Area`（relation → Areas）、`NewDay Key`（rich_text）、`Rule`（relation → Rules）、`Occurrence Key`（rich_text） | `Plan Date` 可空；项目至多一个。有项目时从项目派生主线，否则使用至多一个直接主线。`NewDay Key` 仅由 NewDay 创建的页填写；`Rule`/`Occurrence Key` 仅重复实例填写。 |
| Rules | `Name`（title）、`Active Dates`（date）、`Pattern`（select: `daily`/`weekdays`/`weekly`/`monthly`）、`Weekdays`（multi_select: ISO 1～7）、`Month Day`（number）、`Excluded Dates`（rich_text，JSON 日期数组） | Notion 编辑。`Active Dates.start` 必填，`end` 可空；不同模式只读取对应参数。排除日期必须是有效且去重的 date-only 值。 |

`NewDay Key` 是安装 ID 与本地任务 UUID 派生的稳定标识；远端不强制唯一，所以写入响应丢失时须扫描并核对：恰好一条可用则绑定，多条或查询不完整则暂停并呈现待核对。重复实例的 `Occurrence Key` 由规则页面 ID 与原始发生日期生成，改期不改变该键。`Rule` 关系用于区分实例与一次性任务；不允许把实例字段误写成规则变更。

对 `Area`、`Project`、`Direct Area` 与 `Rule` 关系，先确认属性类型和关系目标；`has_more: true` 时通过页面属性接口读完全部关系，读不全就暂停该行，不能根据截断的前 25 项判断唯一性。关系意外为空时先检查目标数据源的读取权限；不能把不可访问的主线或项目解释成“没有归属”。标题及稳定键若含可能被截断的页面/用户引用，同样读完整属性后再解释。

远端 `Name` 为空、只含空白或超出现有任务/规则模型的 200 字符上限时，暂停该行并显示字段错误，不截断、删行或编造标题。规则 `weekly` 要有至少一个去重的 ISO 1～7 星期值，`monthly` 的 `Month Day` 必须是整数 1～31；其他模式的无关参数不改变生成结果。`Active Dates` 的结束日若提供则含当天且不得早于开始日。规则字段不合法时保留已完成实例和现有映射，停止该规则后续生成，等待 Notion 修正。

## 3. 日期、可见性和身份

`Plan Date` 的 `start`/`end` 都必须是 `YYYY-MM-DD`，单日为相同值；空 `end` 按单日解释。区间首尾均包含，且结束不早于开始。带时间或时区的输入不按服务器 UTC 偷换日期：该行暂停同步并显示字段错误，等待用户在 Notion 修正。仅用于实例的日期必须是单日。

远端无日期任务在首次扫描时可保留远端索引，但不进入每日清单、逾期、重点或 Agent 候选。已关联任务清空日期时保留同一个本地任务 ID、远端映射、资料链接和历史；计划范围改为整体空值，清除当前重点可见性，退出所有每日投影。当前 `Task` 模型要求非空 `startDate/endDate`，因此实现必须将两端作为同时为 null 或同时有效的配对，并更新 day-plan、Agent 快照、任务总表与备份校验；不能用“今天”占位。纯本地任务仍须有日期。

远端 `Completed` 勾选不提供实际完成时间。首次读到已完成，或由未完成变为已完成时，`completedAt` 与 `completedOn` 均保持 `null`，并将这次变化记为观察事件，不把扫描日写成完成日或 Agent 历史成果。已有可信的本地完成时间在重复读取同一完成状态时保留；重复读取不改写完成时间或 plannerRevision。重开清空两者。

主线、项目、任务、规则与实例的本地 ID 与 Notion 页面 ID 分开保存，以 `(workspace_id, data_source_id, remote_page_id)` 唯一约束映射。重复规则以其远端页面 ID 派生 `logicalSeriesId`，现有规则段可以更换 `seriesId` 而不改变逻辑规则身份。实例键沿用 `logicalSeriesId:occurrenceDate`；`occurrenceDate` 是原始发生日，改期只改变实际计划日。窗口是用户时区的今天至今天＋31 天，含首尾。已完成实例和有明确例外的实例不能被规则刷新覆盖。

## 4. 原子写入、冲突和恢复

业务任务变更走 core 命令或经过等价校验的服务事务，不能只改 `tasks.payload`。本地任务变更、映射状态及 outbox 记录同一 SQLite 事务提交；外部 HTTP 在事务外。真正改变任务内容时，同一事务推进一次 `plannerRevision`，使旧 Agent 提案在采纳时返回版本冲突；仅水位、令牌或同步时间变化不推进该版本。整库替换沿用 `datasetEpoch`，旧提案和旧 outbox 不能跨 epoch 执行。

每个关联任务按安装/工作区/任务串行发送。outbox 保存稳定操作 ID、目标字段、期望共同基准、业务版本、重试状态；同一任务较早的待发送日期变更被后续日期意图合并或废止，不能晚到覆盖新值。远端拉取不得再生成相同待发送操作。发送后读回并核对实际属性、页面 ID 与当前意图，未知结果保持待核对。撤销须新增相反业务意图并经过同一队列，不能只撤销本地数据库。

以**最后一次已成功核对的逐字段值**为共同基准，`Name`、完整 `Plan Date` 区间、`Completed` 分别比较。两端只改不同字段时合并；同一字段两端都改时 Notion 值优先，记录共同基准、两端值、决议和时间，用户可见。日期区间是一个原子字段，绝不拼接两端。尚未验证 Notion 对本接口提供适用的条件写入能力；T5/T6 在真实隔离工作区实测前不得宣称任意并发下零覆盖。若不能条件写入，采用写前读、只发送目标属性、写后读及冲突审计；有无法判断的竞态则暂停该操作，产品文案明确为“可检测范围内冲突处理与最终收敛”。

只有明确读取到目标页面 `in_trash: true` 才自动归档对应本地关联任务，保留映射、资料关联和历史，不硬删。普通数据源查询默认不返回已归档页面，所以要对已知映射逐页核对或明确查询回收站，不能把它从普通扫描中消失视为删除。单次查询缺失、404、403、schema 改动、分页失败和网络错误都进入待核对；不批量归档。v1 从 NewDay 删除联动任务时只提供去 Notion 处理的说明，不能复用本地永久删除命令静默删远端；恢复/取消归档需重新核对远端。

备份恢复先设置持久化的发送栅栏，阻止新 HTTP 写入取得发送资格，再暂停拉取。每次发送在 HTTP 前持久化所属 `datasetEpoch`、操作 ID 及 `sending` 尝试；恢复要等已知在途请求完成并核对远端结果，才能提交整库替换。如果请求超时、进程退出或结果未知，恢复可以进入暂停态，但绝不能把这些请求当作已取消：旧 epoch 的发送器即使醒来也不得再派发；未知的远端结果必须记录并与旧操作一起隔离。恢复后核对对应远端页面及字段，在未知结果消除前禁止自动发送同一映射的新意图；若无法排除较晚生效的旧请求，保持暂停并要求人工处理。没有远端条件写入或可取消请求的保证时，本契约不承诺消除所有极端晚到覆盖。

现有业务备份 v5 没有联动数据；T5 首次加入映射时须将业务备份升级为 v6，旧 v1～v5 导入全部视为纯本地数据，不能根据标题、日期或 UUID 推断 Notion 关联。v6 增加 `notionSync` 版本化部分，至少保存来源安装 ID、工作区 ID、根页面/四表的 database 和 data source ID、实际属性 ID、外部映射、逐字段共同基准、冲突记录、同步水位及未完成 outbox 的操作 ID/意图/状态/所属 datasetEpoch。备份的任务、映射和 outbox 引用须完整且唯一；重复远端映射、悬空本地任务或未知版本直接报校验错误，不做部分恢复。

业务备份不得包含 access/refresh token、client secret、OAuth state 或领取凭证。导入 v6 后，即使本机仍有旧凭据，也先进入 `paused_after_restore`：替换导入产生新 `datasetEpoch`，所有恢复来的 outbox 一律标为隔离，原来源安装 ID 仅用于识别旧 `NewDay Key`，不自动当作当前安装身份。先核对授权工作区、schema、映射、远端当前值和逐字段基准，再按远端现状重新形成或舍弃本地意图；未完成核对不得发送旧 outbox。没有匹配凭据时重新授权；换工作区必须新建命名空间，不按同名对象复用旧 ID。恢复后的第一次成功完整扫描之前，不因远端缺项自动归档本地任务。

## 5. 扫描、水位和可见故障

每张 data source 分页扫描，每页先校验类型、属性和关系；只有整个扫描窗口成功后推进应用自己的完成水位。`next_cursor` 只在本次分页调用中使用，不作为永久增量日志位置。查询还须检查每页 `request_status`：单次查询达到 10,000 行上限时，即使 `has_more` 为 `false` 也可能标记 `incomplete`。此时用稳定的 `created_time` 排序与重叠窗口分段读全、按页面 ID 去重；若同一时间片无法继续拆分，暂停并显示不完整，绝不推进水位。`last_edited_time` 可用于增量候选筛选，但不能作为全量分页的稳定分段键；增量扫描保留重叠窗口，定期以 `created_time` 分段做完整对账，防止编辑中的行移动造成永久漏读。重启或中断重新扫描未完成窗口；主线和项目独立刷新。应用远端变更时不产生回写回环。显示最后尝试、最后成功、失败类别和手动重试；“尚未成功同步”不能显示为“没有任务”。

429、529 遵守 `Retry-After` 秒数，并在再次失败时做有上限的退避和抖动；401/403、schema 错误、404 与可重试网络/服务错误分开。只有授权有效、API 运行、固定测试规模且无持续限流时才验收 5 分钟内反映变更。API 关闭、备份恢复和暂停状态明确告知用户。

## 6. 验收矩阵与未关闭问题

| 场景 | 必须证明 |
| --- | --- |
| 同日/跨日/空日期/清空日期/带时间日期 | 区间语义、无日期不进入今日、清空不失历史、带时间不静默转换 |
| 同页重复扫描、重启、部分分页失败 | 一条映射；失败不推进水位或触发批量归档 |
| 查询结果达到 10,000 行上限、关系 `has_more: true` | 不把截断结果当完整；分段或读完整属性，无法读全则暂停且水位不变 |
| POST/PATCH 成功但响应丢失 | 用稳定键和读回对账；不盲目创建第二页 |
| 根页面/四表创建响应丢失，搜索零条或多条，表创建后重启 | POST 前持久化尝试；用标题标记或已知根页面子块及 schema 核对；结果不完整时暂停，不自动再次创建 |
| 本地改日期而 Notion 改标题、双方改同一字段 | 分字段合并；同字段 Notion 优先并显示三方值 |
| 日期区间两端并发修改 | 原子解决，不能组成无效范围 |
| 429/529、401/403、404、网络中断 | 正确退避/待核对/暂停，无误归档、无无限重试 |
| Agent 建议生成后同步修改候选任务 | 旧建议返回版本冲突，重点不变 |
| 备份恢复、换工作区、旧 outbox、仍在途的 HTTP 写入 | 恢复前阻止新发送；已发请求完成或保持未知并隔离，校验命名空间，未对账前不让新意图越过旧操作 |
| v1～v5 旧备份、v6 重复映射或未知版本 | 旧备份仍为本地数据；无效 v6 原子拒绝，不能部分导入 |
| 规则月末/改期/停止/恢复 | 实例键稳定，不重复生成，不覆盖已完成历史 |

COL-32 的交付范围是本契约、字段表、故障矩阵、API/SDK 文档核对与合成 fixture；这些文档经审阅并完成一致性检查后可作为 T1 契约交付。真实隔离 Notion 工作区的结构与关系读回归 T3 验收；条件写入能力、日期与回收站响应及实际冲突行为归 T5/T6 验收。规则变更后，已发送到 Notion 的未来未完成实例如何收敛须在 T7 的故障测试中冻结处理；在此之前不可自动删除或重建这些远端页。上述运行行为未验收前，不可把整条 COL-31 标为完成。

## 7. 证据入口

- [Notion API 版本及 SDK 兼容性](https://developers.notion.com/reference/versioning)、[2026-03-11 升级指南](https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11)、[@notionhq/client 5.23.0 包](https://www.npmjs.com/package/@notionhq/client/v/5.23.0)。SDK 包核对命令为 `npm view @notionhq/client@5.23.0 version --json` 与 `npm pack @notionhq/client@5.23.0`；同时对照检查了 5.12.0。只做本地包内容检查，没有发起 Notion API 请求。
- [公共 OAuth 与令牌刷新](https://developers.notion.com/guides/get-started/authorization)、[Private 区域结构创建](https://developers.notion.com/guides/get-started/preparing-for-users)、[标题搜索](https://developers.notion.com/reference/post-search)及[索引限制](https://developers.notion.com/reference/search-optimizations-and-limitations)。
- [database/data source 升级指南](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)、[大数据源查询上限与分段](https://developers.notion.com/guides/data-apis/query-large-data-sources)、[页面属性截断](https://developers.notion.com/reference/page-property-values)、[数据源查询与归档过滤](https://developers.notion.com/reference/filter-data-source-entries)、[更新页面](https://developers.notion.com/reference/patch-page)、[请求限制](https://developers.notion.com/reference/request-limits)。
- 本地代码：`packages/core/src/domain/planner-model.ts`、`packages/core/src/application/day-plan.ts`、`packages/core/src/application/recurrence-generation.ts`、`apps/api/src/storage/sqlite-planner-store.ts`、`apps/api/src/services/planner-service.ts`、`packages/core/src/contracts/planner-backup.ts`。
