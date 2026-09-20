# Notion OAuth 候选：配置、恢复与验证

此文档对应 COL-33 的隔离候选。当前实现只处理授权、凭据和连接状态；**尚未创建 Notion 四表，也不拉取或写回任务**。本地软件测试不代表真实工作区验收。仅在指定的隔离 Notion 工作区确认范围后启用真实授权。

## 边界与配置

Cloudflare Worker 负责 Notion 公共 OAuth 的回调、令牌交换与轮换；本机 Fastify API 负责发起授权、领取结果和保存凭据。浏览器只拿到授权 URL、一次性回调票据和不含令牌的连接摘要。业务数据库及规划/Agent JSON 备份均不保存 Notion 令牌。Worker 的 SQLite Durable Object 在授权完成到本机确认期间暂存令牌，确认后清除；刷新结果最多保留 24 小时以便同一轮换尝试复取。

1. 在 Notion 建立用于**隔离测试工作区**的 Public OAuth connection，登记 Worker 的精确 HTTPS 回调 `https://<worker-origin>/oauth/callback`，按所需权限配置。确认实际 `client_id`、`client_secret` 和回调地址，勿写进仓库。
2. 将 `apps/notion-oauth-worker/wrangler.jsonc` 中的 Worker 名称调整到自己的 Cloudflare 项目。通过 Cloudflare Secret 管理 `NOTION_CLIENT_ID`、`NOTION_CLIENT_SECRET`、`NOTION_REDIRECT_URI`、`LOCAL_RETURN_ORIGIN`、`LOCAL_API_KEY`。`NOTION_REDIRECT_URI` 是上述 HTTPS 回调；`LOCAL_RETURN_ORIGIN` 是本机 Web 精确回环 origin，如 `http://127.0.0.1:3000`，没有路径。只有回调和健康检查对浏览器公开；本机 API 调用须带服务密钥。
3. 在本机分别生成两个 32 字节随机值，例如分别执行两次 `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`。一个作 Worker `LOCAL_API_KEY` 与 API 的 `NEWDAY_NOTION_WORKER_API_KEY`，另一个仅作本机 `NEWDAY_NOTION_CREDENTIAL_KEY`。不要复用，也不要将值放进 issue、PR、日志或业务备份。
4. 本机根 `.env` 中设置 `NEWDAY_NOTION_WORKER_ORIGIN`、`NEWDAY_NOTION_WORKER_API_KEY`、`NEWDAY_NOTION_CREDENTIAL_KEY`，可选设置独立的 `NEWDAY_NOTION_CREDENTIAL_PATH`。API 只接受精确 HTTPS Worker origin；缺任何一项都会拒绝部分配置。默认凭据库在 `data/notion-vault/credentials.sqlite`，与业务库 `data/newday.sqlite` 分开。根 `pnpm dev` 会加载 `.env`；单独的 `dev:api` 需通过进程环境传入。
5. 部署和授权前，在隔离工作树运行 `pnpm check`、`pnpm build`、`pnpm test:e2e`。Worker 的 `pnpm --filter @newday/notion-oauth-worker build` 是本地 dry-run，**不会部署**。真实部署后仍需用指定测试工作区执行授权、取消、重授权、轮换、断开、API 重启及浏览器回调验证，并保留可复核记录。

当前没有为 Worker 配置边缘限流或线上监控。公共回调会验证随机 state；服务端入口还要求 `LOCAL_API_KEY`。正式部署前需评估 Cloudflare 侧对恶意流量的限制和 Secret 轮换。`LOCAL_API_KEY` 泄露时更换 Worker 与本机两端的值。凭据库密钥丢失时不能从业务备份恢复令牌，应移走旧凭据库并重新授权；不要用新密钥直接打开旧库并假称连接有效。

## 授权与故障恢复

- 本机生成随机 verifier，将 SHA-256 challenge 发给 Worker。Worker 保存随机 state 10 分钟。Notion 回调成功后 Worker 将随机票据放入回环 Web 地址的 URL fragment；页面立即清除 fragment，再由本机 API 用 verifier 与票据领取令牌。Worker 在本机加密事务提交后收到 ACK 才删除暂存令牌。重复领取在 ACK 前可以重送同一结果；ACK 后拒绝重放。
- 用户在 Notion 授权页取消时，Worker 在回调中标记该 state 为取消，本机清除对应 verifier。单独调用本机 `/oauth/cancel` 只删除本机 verifier；Worker 会话到期后自行失效。断开某个已连接工作区只删除该工作区的本机凭据，不取消其他尚未完成的授权。若回调错误、过期或本机进程停止，重新开始授权；不要把未领取的会话算作已连接。
- 本机凭据库用 AES-256-GCM 保存令牌和待领取 verifier，库文件权限为 `0600`。`GET /api/notion/status` 只返回工作区摘要与 `active`、`refresh_pending` 或 `reauthorization_required` 状态。密钥、access token、refresh token 不进入 HTTP 响应、业务备份或 Agent 备份。
- 刷新使用保存在库中的固定 attempt ID。请求超时可能发生在 Notion 已轮换之后；此时状态是 `refresh_pending`，旧令牌停止供后续任务调用。页面的“重试确认”用原 attempt ID 读取 Worker 暂存的轮换结果。Worker 明确无法提供结果、缓存过期或令牌身份不匹配时进入 `reauthorization_required`，需重新授权。
- “断开”只删除指定工作区的本机凭据，不声称撤销 Notion 设置中的连接授权，也不取消尚未完成的其他授权会话。若要在 Notion 一侧撤销，也需由用户在 Notion 中移除该连接。重新连接同一工作区会替换其本机凭据；后续表映射和同步必须另行核对。

## 当前验收状态

离线 API 测试覆盖授权领取、取消、重放、备份隔离、加密落盘、断开、跨重启刷新结果复取及失败转重授权；Worker 运行时测试覆盖 state、verifier、票据、ACK、取消和同尝试刷新缓存。真实 Public connection、Cloudflare Worker 部署、Notion 工作区令牌轮换与撤销仍未验证。T2 保持 In Progress / Draft，直到真实隔离工作区验收。
