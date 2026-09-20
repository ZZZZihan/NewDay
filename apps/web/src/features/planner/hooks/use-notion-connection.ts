import { useCallback, useEffect, useState } from "react";

import { notionApi, type NotionReadStatus, type NotionStatus, type NotionStructureProgress,
  type NotionSyncStatus } from "../api/notion-api";

const oauthFragment = /^#notion-oauth=(ready|cancelled|error):([A-Za-z0-9_-]{43})(?::([A-Za-z0-9_-]{43}))?$/;

export function useNotionConnection(onReturn: () => void, onScanComplete: () => Promise<void>) {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [structures, setStructures] = useState<Record<string, NotionStructureProgress>>({});
  const [reads, setReads] = useState<Record<string, NotionReadStatus>>({});
  const [syncs, setSyncs] = useState<Record<string, NotionSyncStatus>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await notionApi.status();
      setStatus(next);
      const entries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.structure(item.workspaceId)] as const; }
        catch { return null; }
      }));
      setStructures(Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
      const readEntries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.readStatus(item.workspaceId)] as const; }
        catch { return null; }
      }));
      setReads(Object.fromEntries(readEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
      const syncEntries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.syncStatus(item.workspaceId)] as const; }
        catch { return null; }
      }));
      setSyncs(Object.fromEntries(syncEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null)));
    }
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
      .then(() => setMessage("已保存 Notion 授权。完成结构初始化后可开始只读同步。"))
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

  async function initializeStructure(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // Each API call records at most one remote structural mutation before
      // returning its readback. Keep the UI responsive across all nine steps.
      for (let index = 0; index < 9; index += 1) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 400));
        const result = await notionApi.advanceStructure(workspaceId);
        setStructures((current) => ({ ...current, [workspaceId]: result }));
        if (result.state === "ready") {
          setMessage("Notion 私有根页面、四张表和关联字段已读回确认；可开始只读扫描。");
          return;
        }
        if (result.state === "needs_review") {
          setMessage("Notion 创建结果需要核对；系统不会自动再次创建。检查该工作区后可点击重新核对。");
          return;
        }
      }
      setMessage("结构初始化已记录进度，可继续完成剩余步骤。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notion 结构初始化结果待确认，请读取状态后继续核对");
      await refresh();
    } finally { setBusy(false); }
  }

  async function scan(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage("正在读取 Notion 主线、项目和一次性任务…");
    try {
      const result = await notionApi.scan(workspaceId);
      setReads((current) => ({ ...current, [workspaceId]: result }));
      await onScanComplete();
      setMessage("Notion 扫描已完成；联动任务会显示在对应日期。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Notion 扫描失败；已有本地任务保持原样，可检查状态后重试");
      await refresh();
    } finally { setBusy(false); }
  }

  async function drain(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.drain(workspaceId);
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.operations.some((item) => item.status === "unknown")
        ? "写入结果待核对；系统已暂停后续发送，不会重复创建。"
        : result.operations.some((item) => item.status === "pending")
          ? "仍有待发送操作；请刷新状态后继续核对。"
          : "待发送操作已读回确认；可刷新 Notion 扫描。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Notion 写回未完成"); }
    finally { setBusy(false); await refresh(); }
  }

  async function reconcile(workspaceId: string, operationId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.reconcile(workspaceId, operationId);
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.operations.find((item) => item.operationId === operationId)?.status === "confirmed"
        ? "远端结果已按原操作确认；核对所有待确认项后可恢复发送。"
        : "远端结果仍无法确认；继续暂停发送并人工核对。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法确认远端操作结果"); }
    finally { setBusy(false); await refresh(); }
  }

  async function resume(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.resume(workspaceId);
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage("已恢复此工作区的待发送队列；发送前仍会逐项预读远端。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "仍有待核对操作，不能恢复发送"); }
    finally { setBusy(false); await refresh(); }
  }

  return { status, structures, reads, syncs, message, busy, refresh, start, disconnect, retryRefresh,
    initializeStructure, scan, drain, reconcile, resume };
}
