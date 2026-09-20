import { useCallback, useEffect, useState } from "react";

import { notionApi, type NotionStatus } from "../api/notion-api";

const oauthFragment = /^#notion-oauth=(ready|cancelled|error):([A-Za-z0-9_-]{43})(?::([A-Za-z0-9_-]{43}))?$/;

export function useNotionConnection(onReturn: () => void) {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setStatus(await notionApi.status()); }
    catch (error) { setMessage(error instanceof Error ? error.message : "无法读取 Notion 连接状态"); }
  }, []);

  useEffect(() => {
    const match = window.location.hash.match(oauthFragment);
    if (!match) { queueMicrotask(() => { void refresh(); }); return; }
    // The ticket is a one-time browser handoff. Remove it from the address bar
    // before making any asynchronous request or rendering a connection result.
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    queueMicrotask(onReturn);
    const [, result, state, ticket] = match;
    if (result !== "ready" || !ticket) {
      void notionApi.cancel(state).catch(() => undefined);
      queueMicrotask(() => {
        setMessage(result === "cancelled" ? "已取消 Notion 授权" : "Notion 授权未完成，请重试");
        void refresh();
      });
      return;
    }
    queueMicrotask(() => setBusy(true));
    void notionApi.claim(state, ticket)
      .then(() => setMessage("已保存 Notion 授权。远端结构和任务同步尚未启用。"))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "授权结果领取失败，请重新授权"))
      .finally(() => { setBusy(false); void refresh(); });
  }, [onReturn, refresh]);

  async function start() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const { authorizationUrl } = await notionApi.start();
      window.location.assign(authorizationUrl);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法开始 Notion 授权");
      setBusy(false);
    }
  }

  async function disconnect(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await notionApi.disconnect(workspaceId);
      await refresh();
      setMessage("本机凭据已删除。若要撤销 Notion 中的连接授权，也请到 Notion 设置中移除连接。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "断开失败，请重试");
    } finally { setBusy(false); }
  }

  async function retryRefresh(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await notionApi.refresh(workspaceId);
      await refresh();
      setMessage("Notion 凭据刷新结果已确认。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法确认 Notion 凭据刷新结果");
      await refresh();
    } finally { setBusy(false); }
  }

  return { status, message, busy, refresh, start, disconnect, retryRefresh };
}
