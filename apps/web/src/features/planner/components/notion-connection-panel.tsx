import type { useNotionConnection } from "../hooks/use-notion-connection";
import type { NotionStructureProgress } from "../api/notion-api";

type ConnectionState = ReturnType<typeof useNotionConnection>;

export function NotionConnectionPanel({ connection }: { connection: ConnectionState }) {
  const { status, structures, message, busy, refresh, start, disconnect, retryRefresh, initializeStructure } = connection;
  return (
    <section className="schedule-panel notion-panel" aria-label="Notion 连接">
      <header className="schedule-heading life-heading">
        <div>
          <p className="section-kicker">外部连接</p>
          <h1>Notion 连接</h1>
          <p className="schedule-subtitle">授权后可在所选工作区建立私有页面和四张关联表。</p>
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
            {structures[item.workspaceId] ? (
              <p>{structures[item.workspaceId].state === "ready" ? "私有根页面和四张关联表已确认"
                : structures[item.workspaceId].state === "needs_review" ? reviewDescription(structures[item.workspaceId])
                  : structures[item.workspaceId].state === "paused_after_restore" ? "备份恢复后结构和授权需要重新核对"
                    : `结构初始化：${structures[item.workspaceId].completedSteps.length}/9 步已确认`}</p>
            ) : <p>结构状态未读取；可刷新状态重试。</p>}
            <small>工作区 ID：{item.workspaceId}</small>
          </div>
          <div className="notion-panel__connection-actions">
            {item.status === "active" && structures[item.workspaceId]?.state !== "ready" &&
              structures[item.workspaceId]?.state !== "paused_after_restore" ? (
                <button type="button" disabled={busy || !structures[item.workspaceId]} onClick={() => {
                  if (window.confirm(`即将在工作区 ${item.workspaceName || item.workspaceId} 建立或核对 NewDay 私有页面和四张表，继续吗？`)) {
                    void initializeStructure(item.workspaceId);
                  }
                }}>{structures[item.workspaceId]?.state === "needs_review" ? "重新核对" : "建立或继续结构"}</button>
              ) : null}
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

function reviewDescription(progress: NotionStructureProgress): string {
  const messages: Record<NonNullable<NotionStructureProgress["reviewReason"]>, string> = {
    not_found: "暂未找到已尝试创建的对象；请稍后重新核对，系统不会重复创建",
    ambiguous: "找到多个同名候选；请在 Notion 核对，系统不会自动选择",
    unreadable: "无法完整读取远端结构；请检查权限后重新核对",
    schema_mismatch: "远端字段或关联目标与预期不符；请核对结构",
    permission: "Notion 权限或授权不足；请核对连接权限",
    rate_limited: "Notion 暂时限流；请在退避时间后重新核对",
    request_unknown: "远端请求结果未确认；重新核对只读取远端，不重复创建",
  };
  return progress.reviewReason ? messages[progress.reviewReason] : "结构创建结果待核对";
}
