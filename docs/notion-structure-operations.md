# Notion 结构初始化候选（COL-34）

此实现接在 [OAuth 凭据流程](./notion-oauth-operations.md) 和 [联动契约](./notion-sync-contract.md) 后。`GET /api/notion/connections/:workspaceId/structure` 只读进度；用户在「Notion 连接」中确认后，前端反复调用 `POST .../structure/advance`，每次最多提交一次远端结构变更。`needs_review` 的“重新核对”改用 `POST .../structure/reconcile`，携带当前步骤和尝试时间；服务端拒绝过期视图，不会借一次旧按钮点击创建下一步骤。只有本机 API 持有 access token。2026-09-21 已在独立测试工作区完成九步真实创建、响应丢失后的只读对账和重新授权后的安全恢复；结果与限制见 [真实验收报告](./notion-live-acceptance-2026-09-21.md)。

## 创建顺序与持久状态

1. 首次尝试前在业务 SQLite 中保存工作区、随机 128 位安装 ID 和 `NewDay (<安装 ID>)` 根标题。根页面 POST 前，持久写入 `root` 尝试记录。
2. 根页面读回标题、workspace 父级和页面 ID 后，按 Areas、Projects、Tasks、Rules 依次建立数据库及初始 data source。每张表 POST 前记录父页面 ID、精确标题、schema 指纹与尝试时间；读回 database ID、唯一 data source ID 和基础属性 ID 才推进。
3. 按 Projects.Area、Tasks.Project、Tasks.Direct Area、Tasks.Rule 的顺序添加 relation。每次 PATCH 前记录来源 data source、目标 ID 指纹；读回 relation 属性 ID 与目标 data source ID 才推进。
4. 九步全部确认后连接结构状态为 `ready`。T3 不启用任务拉取或写回；T4、T6 有各自的验收门槛。

结构记录和确认的远端 ID 进入无凭据业务备份 v6；OAuth 令牌和本机加密密钥不进入备份。恢复 v6 后连接进入 `paused_after_restore`，不能直接重复初始化或发送旧操作，需要先核对授权工作区与远端结构。

## 备份恢复后的只读结构核对

在「Notion 连接」中对已重新授权的恢复隔离工作区点击「只读核对恢复结构」，调用 `POST /api/notion/connections/:workspaceId/structure/restore/verify`，body 为 `{}`。本机 API 只使用当前工作区的有效凭据读取远端对象；它不会创建页面或表、修改业务 SQLite、确认初始化步骤、扫描任务、发送 outbox 或解除 `paused_after_restore`。

结果逐项显示根页面、四张表和四个关联：恢复记录必须含原有已确认步骤和精确 ID、父级、标题与 schema 指纹；远端根页面须仍在 workspace 下且不在回收站；每张表须有原 database ID、父页面 ID、唯一 data source ID、基础字段类型及原属性 ID，数据源响应自身的 ID 须匹配请求，父对象须是对应 database；每个关联须有原属性 ID 和目标 data source ID。远端读取失败、权限不足、限流、记录缺失和任何不一致都返回待核对项；遇到权限或限流错误后，其余远端步骤标为未读取，不继续请求。即使九项全部一致，也只证明本次逐项读回的结构状态，不证明任务映射或恢复前发送结果安全，更不恢复同步。

读回期间如果本机数据集被再次替换、连接或步骤记录改变、授权令牌改变，API 返回 409，丢弃本次结果。界面仅暂存本次检查；刷新连接状态后须重新检查。真实 Notion 工作区的响应和恢复流程仍需隔离工作区验收。

## 重新授权后的只读恢复

断开或凭据失效后重新授权同一工作区时，OAuth 凭据可以恢复，但业务连接仍保持 `disconnected`。界面显示“核对并重新连接”，调用 `POST /api/notion/connections/:workspaceId/structure/reconnect`，body 为 `{}`。服务端复用九项结构核对规则，并额外要求：

1. 当前业务连接仍是 `disconnected`，且本机凭据属于同一工作区。
2. 根页面、四张表、四个 relation 的确认记录、远端 ID、父级、标题、schema 指纹、属性 ID 和 relation 目标全部一致。
3. 核对期间 dataset epoch、连接记录、九步记录、workspace/bot 身份和 access token 均未变化。

全部满足后，只在本机事务中把连接改为 `active`；远端请求只有 GET/查询，不调用页面或 data source 的 POST/PATCH。任一项缺失、权限不足、限流、回收站或不一致时返回逐项结果并保持 `disconnected`。该入口不能用于 `paused_after_restore`，恢复备份仍使用上一节的只读核对并保留隔离。

## 未知结果的处理

远端 POST/PATCH 请求可能已成功但响应丢失。持久尝试一旦存在，同一步后续调用**只读对账**：根页面按安装标记搜索所有分页并核对精确标题及 workspace 父级；数据库读取根页面的全部子块分页，再核对标题、父级、唯一 data source 和属性类型；relation 读取来源 data source 的字段与目标。即使 POST 已返回 ID，也会查询同级对象以检查重复。零个、多个、不可读或字段不符时保持 `needs_review`，不再次提交 POST/PATCH。Notion 标题搜索可能有索引延迟，零结果不能证明创建失败；稍后再次点击「重新核对」仍是只读操作。

同一 API 进程内，同工作区的初始化调用与断开操作串行执行。断开会等待已开始的单步创建结束，再移除本机凭据；如果已有结构尝试，重新授权后仍保留 `disconnected` 状态，需人工核对远端对象与映射，不能直接重放初始化。

429/529 记录 `Retry-After` 或缺省短暂退避，在时间届满前不会再次访问 Notion。401/403、schema 不符、不可读与未知请求结果分别显示为对应故障类别。任何自动重建都需要新的人工核对与单独的恢复流程；当前候选不提供清除尝试记录的快捷按钮。

## 隔离工作区验收

在真实测试前，确认使用的是专门的隔离 Notion 工作区、Public OAuth 连接拥有插入/读取/更新内容能力，且 `NEWDAY_NOTION_WORKER_ORIGIN`、本机服务密钥与本机凭据密钥已按 OAuth 运维说明配置。先在一次性本地数据库完成授权，再手动点「建立或继续结构」。逐项读回根页面、四个 database/data source、基础属性和四个 relation 的实际 ID 与目标；记录 Notion-Version `2026-03-11`、工作区 ID、请求时间及错误类别。不要将测试工作区 ID 或令牌提交进仓库。

故障验收应在隔离工作区中分别中断根页面、表、relation 的响应或进程，再重新调用进度接口，确认只读对账恢复且无副本。还要覆盖搜索暂时零结果、重复标题、字段类型或权限变化、分页未读全、限流、断开与重新授权。2026-09-21 的 A3 使用真实 Notion 2xx 后丢失下游响应，三个故障步骤只读恢复且最终 9/9 ready；A1 重新授权先因根页面权限不足保持断开，补充隔离根页面 connection 后 9/9 核对恢复 active。后续代码、权限或 API 版本变化仍须重新执行，不能以本地假网关和 Wrangler dry run 代替。

回退代码时保留当前业务数据库与备份，停止继续初始化；不要通过删除尝试记录来重试远端创建。手工清理测试工作区结构应先核对每个远端 ID 和相关数据，并另行执行。
