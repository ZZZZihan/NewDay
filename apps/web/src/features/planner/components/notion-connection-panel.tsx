import type { useNotionConnection } from "../hooks/use-notion-connection";

type ConnectionState = ReturnType<typeof useNotionConnection>;

export function NotionConnectionPanel({ connection }: { connection: ConnectionState }) {
  const { status, message, busy, refresh, start, disconnect, retryRefresh } = connection;
  return (
    <section className="schedule-panel notion-panel" aria-label="Notion 连接">
      <header className="schedule-heading life-heading">
        <div>
          <p className="section-kicker">外部连接</p>
          <h1>Notion 连接</h1>
          <p className="schedule-subtitle">先完成授权，后续再启用结构初始化与任务同步。</p>
        </div>
      </header>
      {message ? <p className="planner-status" role="status">{message}</p> : null}
      {!status ? <p className="planner-status" role="status">正在读取连接状态…</p> : null}
      {status && !status.configured ? (
        <p className="planner-status">本机尚未配置 Notion OAuth Worker 和加密密钥；当前没有连接，也不会访问 Notion。</p>
      ) : null}
      {status?.configured ? (
        <div className="notion-panel__actions">
          <button type="button" className="life-primary" disabled={busy} onClick={() => void start()}>
            {status.connections.length ? "连接另一个工作区或重新授权" : "连接 Notion"}
          </button>
          <button type="button" disabled={busy} onClick={() => void refresh()}>刷新状态</button>
        </div>
      ) : null}
      {status?.connections.map((item) => (
        <article className="life-item notion-panel__connection" key={item.workspaceId}>
          <div>
            <strong>{item.workspaceName || "未命名工作区"}</strong>
            <p>{item.status === "active" ? "已授权；任务同步尚未启用" : item.status === "refresh_pending" ? "刷新结果待确认；旧令牌暂停使用" : "需要重新授权；任务同步不可用"}</p>
            <small>工作区 ID：{item.workspaceId}</small>
          </div>
          <div className="notion-panel__connection-actions">
            {item.status === "refresh_pending" ? <button type="button" disabled={busy} onClick={() => void retryRefresh(item.workspaceId)}>重试确认</button> : null}
            <button type="button" disabled={busy} onClick={() => {
              if (window.confirm("删除此工作区保存在本机的 Notion 凭据？")) void disconnect(item.workspaceId);
            }}>断开</button>
          </div>
        </article>
      ))}
    </section>
  );
}
