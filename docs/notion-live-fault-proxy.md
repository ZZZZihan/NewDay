# Notion 真实故障代理验收

`tooling/notion-live-fault-proxy.mjs` 只用于隔离工作区的人工验收。它监听回环地址，把未命中的请求转发到固定上游 `https://api.notion.com`，并按一次性规则在真实请求前或真实响应后注入故障。

代理不记录 Authorization 值、请求正文、响应正文或原始远端 ID。JSONL 证据只保留请求/响应摘要、脱敏路径、是否带 Bearer、Notion 版本、上游是否已确认返回、上游是否为 2xx、状态码、故障规则和下游结果。证据文件创建为 `0600`。

## 启动边界

1. 使用独立 Notion 验收工作区和独立 SQLite/凭据库。
2. 把规则与原始 JSONL 放在仓库外的私有目录，并把规则文件设为 `0600`。
3. API 仅在本次人工验收进程中设置：

   ```sh
   NEWDAY_NOTION_ACCEPTANCE_PROXY=1
   NEWDAY_NOTION_API_BASE_URL=http://127.0.0.1:3012
   ```

   API 配置拒绝远程地址、`localhost`、HTTPS 代理、带路径或凭据的 URL，也拒绝未显式开启验收模式的覆盖。
4. 启动代理：

   ```sh
   pnpm notion:acceptance:proxy -- \
     --rules /private/path/rules.json \
     --evidence /private/path/evidence.jsonl \
     --port 3012
   ```

5. 每个场景使用新的规则和证据文件；先记录业务数据库和远端对象计数，再触发一个操作，最后同时核对代理 JSONL、本地状态和真实 Notion 读回。

## 规则格式

规则按数组顺序匹配。`pathPattern` 必须是完整锚定的正则；`times` 默认为 1，最大 20；`after` 可跳过前 N 个同路径请求，最大 50。

```json
{
  "schemaVersion": 1,
  "rules": [
    {
      "id": "w2_create_response_loss",
      "method": "POST",
      "pathPattern": "^/v1/pages$",
      "action": "drop_after_upstream",
      "times": 1
    }
  ]
}
```

支持的动作：

| 动作 | 含义 | 可证明的边界 |
| --- | --- | --- |
| `drop_before_upstream` | 请求不发到 Notion，直接断开本地连接 | 明确的写前网络失败 |
| `drop_after_upstream` | 仅在 POST/PATCH 收到 Notion 2xx 完整响应后丢弃下游连接；非 2xx 原样透传 | 真实上游已确认写入成功，但本地未收到结果 |
| `respond_status` | 在上游前返回 403、404、429 或 529，可带 `retryAfter` | 权限、对象不可读和限流处理；证据明确标记未到上游 |
| `partial_pagination_after_upstream` | 把一次 POST 查询的上游页大小收窄为 1；真实上游返回有效下一页游标后透传第一页，并在 SDK 请求下一页时断开 | 真实第一页已返回、后续页失败时必须保持旧数据和水位 |
| `schema_missing_properties_after_upstream` | 先取得真实 data source，再移除响应中的 `properties` | schema 故障必须失败关闭 |

`drop_after_upstream` 的通过条件不能只看客户端报错。JSONL 必须同时出现 `upstreamReached=true`、`upstreamSucceeded=true`、2xx `upstreamStatus`、`faultSatisfied=true` 和 `downstream=connection_dropped`，随后还要用稳定 Key 或结构标记从真实 Notion 对账，证明没有重复创建。401、403、429 或 5xx 会记为 `faultSatisfied=false` 并透传，不能作为“写入成功但响应丢失”的证据。

`partial_pagination_after_upstream` 的有效证据由同一规则的两条记录组成：第一条为 `upstreamSucceeded=true`、`downstream=partial_page_forwarded`；第二条为 `upstreamReached=false`、`downstream=pagination_followup_dropped`。如果真实列表没有第二页游标，代理会原样透传并写入 `faultSatisfied=false`，该次运行不能计入 R2。
