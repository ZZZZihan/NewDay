import { useCallback, useEffect, useRef, useState } from "react";

import { notionApi, type NotionReadStatus, type NotionStatus, type NotionStructureProgress,
  type NotionRestoreStructureReview, type NotionSyncStatus } from "../api/notion-api";

const oauthFragment = /^#notion-oauth=(ready|cancelled|error):([A-Za-z0-9_-]{43})(?::([A-Za-z0-9_-]{43}))?$/;

export function writableNotionWorkspaces(status: NotionStatus | null,
  structures: Record<string, NotionStructureProgress>, reads: Record<string, NotionReadStatus>,
  syncs: Record<string, NotionSyncStatus>) {
  return status?.connections.filter((item) => {
    const read = reads[item.workspaceId];
    const sync = syncs[item.workspaceId];
    const localWriteReady = sync?.connectionStatus === "active" ||
      (sync?.connectionStatus === "paused" && sync.pauseReason === "preflight_read");
    return item.status === "active" && structures[item.workspaceId]?.state === "ready" &&
      localWriteReady && sync?.restoreQuarantine?.length === 0 &&
      !sync.operations.some((operation) => operation.status === "quarantined") &&
      read?.sources.some((source) =>
        source.table === "tasks" && Boolean(source.watermark?.lastSuccessAt) &&
        (!source.watermark?.lastError || ["network", "remote", "rate_limited", "local"].includes(source.watermark.lastError)));
  }) ?? [];
}

export function useNotionConnection(onReturn: () => void, onScanComplete: () => Promise<void>,
  onAvailabilityChanged?: (workspaceIds: readonly string[]) => void) {
  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [structures, setStructures] = useState<Record<string, NotionStructureProgress>>({});
  const [reads, setReads] = useState<Record<string, NotionReadStatus>>({});
  const [syncs, setSyncs] = useState<Record<string, NotionSyncStatus>>({});
  const [restoreStructureReviews, setRestoreStructureReviews] = useState<Record<string, NotionRestoreStructureReview>>({});
  const [reconnectStructureReviews, setReconnectStructureReviews] = useState<Record<string, NotionRestoreStructureReview>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshRevision = useRef(0);

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    try {
      const next = await notionApi.status();
      const entries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.structure(item.workspaceId)] as const; }
        catch { return null; }
      }));
      const nextStructures = Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
      const readEntries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.readStatus(item.workspaceId)] as const; }
        catch { return null; }
      }));
      const nextReads = Object.fromEntries(readEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
      const syncEntries = await Promise.all(next.connections.map(async (item) => {
        try { return [item.workspaceId, await notionApi.syncStatus(item.workspaceId)] as const; }
        catch { return null; }
      }));
      const nextSyncs = Object.fromEntries(syncEntries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
      if (revision !== refreshRevision.current) return;
      setStatus(next);
      setStructures(nextStructures);
      setReads(nextReads);
      setSyncs(nextSyncs);
      setRestoreStructureReviews({});
      onAvailabilityChanged?.(writableNotionWorkspaces(next, nextStructures, nextReads, nextSyncs)
        .map((item) => item.workspaceId));
    }
    catch (error) {
      if (revision === refreshRevision.current) {
        setMessage(error instanceof Error ? error.message : "无法读取 Notion 连接状态");
      }
    }
  }, [onAvailabilityChanged]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(refreshIfVisible, 30_000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);

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
      .then(() => setMessage("已保存 Notion 授权。完成结构初始化后请先读取一次性任务。"))
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

  async function initializeStructure(workspaceId: string, reviewOnly = false) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (reviewOnly) {
        const current = structures[workspaceId];
        if (!current?.nextStep || !current.reviewAttemptedAt) throw new Error("当前核对步骤已过期，请刷新状态");
        const result = await notionApi.reconcileStructure(workspaceId, current.nextStep, current.reviewAttemptedAt);
        refreshRevision.current += 1;
        setStructures((value) => ({ ...value, [workspaceId]: result }));
        setMessage(result.state === "needs_review"
          ? "当前结构尝试仍待核对；不会自动重发创建请求。"
          : "本次只核对了已有结构尝试；如需继续建立后续结构，请另行点击建立或继续结构。");
        return;
      }
      // Each API call records at most one remote structural mutation before
      // returning its readback. Keep the UI responsive across all nine steps.
      for (let index = 0; index < 9; index += 1) {
        if (index > 0) await new Promise((resolve) => setTimeout(resolve, 400));
        const result = await notionApi.advanceStructure(workspaceId);
        refreshRevision.current += 1;
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
      refreshRevision.current += 1;
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
      refreshRevision.current += 1;
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.operations.some((item) => item.status === "unknown")
        ? "写入结果待核对；系统已暂停后续发送，不会重复创建。"
        : result.operations.some((item) => item.status === "pending")
          ? "仍有待发送操作；请刷新状态后继续核对。"
          : "待发送操作已读回确认；可刷新 Notion 扫描。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Notion 写回未完成"); }
    finally { setBusy(false); await refresh(); }
  }

  async function pause(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.pause(workspaceId);
      refreshRevision.current += 1;
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.operations.some((item) => item.status === "sending")
        ? "已暂停新的同步请求；已有发送仍在进行，须等待读回或按操作 ID 核对。"
        : "已暂停此工作区的新一轮自动读取与待发送队列；已开始的读取可能仍在进行。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "暂停同步失败"); }
    finally { setBusy(false); await refresh(); }
  }

  async function reconcile(workspaceId: string, operationId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.reconcile(workspaceId, operationId);
      refreshRevision.current += 1;
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.operations.find((item) => item.operationId === operationId)?.status === "confirmed"
        ? "远端结果已按原操作确认；核对所有待确认项后可恢复发送。"
        : "远端结果仍无法确认；继续暂停发送并人工核对。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法确认远端操作结果"); }
    finally { setBusy(false); await refresh(); }
  }

  async function reconcileRestore(workspaceId: string, sourceEpoch: string, operationId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.reconcileRestore(workspaceId, sourceEpoch, operationId);
      refreshRevision.current += 1;
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage("已记录此恢复前操作的远端只读观察；旧操作仍隔离，发送仍暂停。请核对远端值与原意图。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取恢复前操作的远端结果"); }
    finally { setBusy(false); await refresh(); }
  }

  async function verifyRestoredStructure(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage("正在只读核对恢复记录和远端 Notion 结构…");
    try {
      const result = await notionApi.verifyRestoredStructure(workspaceId);
      refreshRevision.current += 1;
      setRestoreStructureReviews((current) => ({ ...current, [workspaceId]: result }));
      setMessage(result.outcome === "matches"
        ? "九项结构在本次读回中一致；恢复隔离仍有效，当前不能同步。"
        : "结构记录存在差异或远端读取不完整；恢复隔离仍有效，请逐项核对。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法核对恢复后的 Notion 结构");
      await refresh();
    } finally { setBusy(false); }
  }

  async function reconnectStructure(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    setMessage("正在只读核对当前已记录的 Notion 结构…");
    try {
      const result = await notionApi.reconnectStructure(workspaceId);
      refreshRevision.current += 1;
      setStructures((current) => ({ ...current, [workspaceId]: result.progress }));
      setReconnectStructureReviews((current) => ({ ...current, [workspaceId]: result.review }));
      setMessage(result.review.outcome === "matches"
        ? result.progress.state === "ready"
          ? "原有九项结构已逐项读回一致；此工作区已恢复同步连接。"
          : `已确认的 ${result.review.checks.length} 项结构均已读回一致；可从第 ${result.progress.completedSteps.length + 1} 步继续初始化。`
        : "原有结构与当前 Notion 不完全一致；连接保持断开，请逐项检查后重试。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法核对重新授权后的 Notion 结构");
    } finally { setBusy(false); await refresh(); }
  }

  async function resume(workspaceId: string) {
    if (busy) return;
    setBusy(true);
    try {
      const result = await notionApi.resume(workspaceId);
      refreshRevision.current += 1;
      setSyncs((current) => ({ ...current, [workspaceId]: result }));
      setMessage("已恢复此工作区的待发送队列；发送前仍会逐项预读远端。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "仍有待核对操作，不能恢复发送"); }
    finally { setBusy(false); await refresh(); }
  }

  return { status, structures, reads, syncs, restoreStructureReviews, reconnectStructureReviews,
    message, busy, refresh, start, disconnect,
    retryRefresh, initializeStructure, verifyRestoredStructure, reconnectStructure, scan, drain, pause, reconcile,
    reconcileRestore, resume };
}
