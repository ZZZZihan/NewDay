# Notion 结构初始化候选（COL-34）

此实现接在 [OAuth 凭据流程](./notion-oauth-operations.md) 和 [联动契约](./notion-sync-contract.md) 后。`GET /api/notion/connections/:workspaceId/structure` 只读进度；用户在「Notion 连接」中确认后，前端反复调用 `POST .../structure/advance`，每次最多提交一次远端结构变更。只有本机 API 持有 access token。尚未部署 Worker，也未对真实 Notion 工作区运行创建请求；浏览器与 API 验证使用假网关。

## 创建顺序与持久状态

1. 首次尝试前在业务 SQLite 中保存工作区、随机 128 位安装 ID 和 `NewDay (<安装 ID>)` 根标题。根页面 POST 前，持久写入 `root` 尝试记录。
2. 根页面读回标题、workspace 父级和页面 ID 后，按 Areas、Projects、Tasks、Rules 依次建立数据库及初始 data source。每张表 POST 前记录父页面 ID、精确标题、schema 指纹与尝试时间；读回 database ID、唯一 data source ID 和基础属性 ID 才推进。
3. 按 Projects.Area、Tasks.Project、Tasks.Direct Area、Tasks.Rule 的顺序添加 relation。每次 PATCH 前记录来源 data source、目标 ID 指纹；读回 relation 属性 ID 与目标 data source ID 才推进。
4. 九步全部确认后连接结构状态为 `ready`。T3 不启用任务拉取或写回；T4、T6 有各自的验收门槛。

结构记录和确认的远端 ID 进入无凭据业务备份 v6；OAuth 令牌和本机加密密钥不进入备份。恢复 v6 后连接进入 `paused_after_restore`，不能直接重复初始化或发送旧操作，需要先核对授权工作区与远端结构。

## 未知结果的处理

远端 POST/PATCH 请求可能已成功但响应丢失。持久尝试一旦存在，同一步后续调用**只读对账**：根页面按安装标记搜索所有分页并核对精确标题及 workspace 父级；数据库读取根页面的全部子块分页，再核对标题、父级、唯一 data source 和属性类型；relation 读取来源 data source 的字段与目标。即使 POST 已返回 ID，也会查询同级对象以检查重复。零个、多个、不可读或字段不符时保持 `needs_review`，不再次提交 POST/PATCH。Notion 标题搜索可能有索引延迟，零结果不能证明创建失败；稍后再次点击「重新核对」仍是只读操作。

同一 API 进程内，同工作区的初始化调用与断开操作串行执行。断开会等待已开始的单步创建结束，再移除本机凭据；如果已有结构尝试，重新授权后仍保留 `disconnected` 状态，需人工核对远端对象与映射，不能直接重放初始化。

429/529 记录 `Retry-After` 或缺省短暂退避，在时间届满前不会再次访问 Notion。401/403、schema 不符、不可读与未知请求结果分别显示为对应故障类别。任何自动重建都需要新的人工核对与单独的恢复流程；当前候选不提供清除尝试记录的快捷按钮。

## 隔离工作区验收

在真实测试前，确认使用的是专门的隔离 Notion 工作区、Public OAuth 连接拥有插入/读取/更新内容能力，且 `NEWDAY_NOTION_WORKER_ORIGIN`、本机服务密钥与本机凭据密钥已按 OAuth 运维说明配置。先在一次性本地数据库完成授权，再手动点「建立或继续结构」。逐项读回根页面、四个 database/data source、基础属性和四个 relation 的实际 ID 与目标；记录 Notion-Version `2026-03-11`、工作区 ID、请求时间及错误类别。不要将测试工作区 ID 或令牌提交进仓库。

故障验收应在隔离工作区中分别中断根页面、表、relation 的响应或进程，再重新调用进度接口，确认只读对账恢复且无副本。还要覆盖搜索暂时零结果、重复标题、字段类型或权限变化、分页未读全、限流、断开与重新授权。只通过本地假网关和 Wrangler dry run 不代表这组真实验收已完成。

回退代码时保留当前业务数据库与备份，停止继续初始化；不要通过删除尝试记录来重试远端创建。手工清理测试工作区结构应先核对每个远端 ID 和相关数据，并另行执行。
