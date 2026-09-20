import { useState, type FormEvent } from "react";
import { Check, ChevronDown, ChevronRight, FileText, Folder, FolderPlus, Inbox, Link2, Plus, Search, Trash2 } from "lucide-react";
import type { InboxItem, LifeFolder, LifeResource, LifeWorkspace } from "@newday/core/domain/life-model";
import type { Task } from "@newday/core/domain/planner-model";
import { lifeApi, type ResourceInput } from "../api/life-api";

export type LifeView = "inbox" | "tasks" | "library";

type Props = {
  view: LifeView;
  today: string;
  workspace: LifeWorkspace | null;
  error: string | null;
  busy: boolean;
  mutate: (operation: () => Promise<unknown>) => Promise<boolean>;
  refresh: () => Promise<void>;
  onOpenTask: (task: Task) => void;
  onCompleteTask: (task: Task) => Promise<boolean>;
  onScheduleTask: (task: Task, date: string) => Promise<boolean>;
  onViewChange: (view: LifeView) => void;
};

export function LifePanel(props: Props) {
  const [captureTitle, setCaptureTitle] = useState("");
  const [captureNotes, setCaptureNotes] = useState("");
  const [classifyId, setClassifyId] = useState<string | null>(null);
  const [classifyAs, setClassifyAs] = useState<"task" | "resource">("task");
  const [classifyDate, setClassifyDate] = useState(props.today);
  const [classifyFolder, setClassifyFolder] = useState("");
  const [classifyKind, setClassifyKind] = useState<"note" | "link">("note");
  const [classifySource, setClassifySource] = useState("");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskStatus, setTaskStatus] = useState<"all" | "open" | "completed">("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState(props.today);
  const [folderFilter, setFolderFilter] = useState("all");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [resourceQuery, setResourceQuery] = useState("");
  const [resourceSort, setResourceSort] = useState<"updated" | "created" | "title">("updated");
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [newResource, setNewResource] = useState(false);

  const data = props.workspace;
  const folders = data?.folders ?? [];
  const resources = data?.resources ?? [];
  const tasks = data?.tasks ?? [];
  const notionByTaskId = data?.notionByTaskId ?? {};
  const links = data?.resourceTaskLinks ?? [];
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const selectedTask = selectedTaskId ? taskById.get(selectedTaskId) : undefined;
  const selectedResource = selectedResourceId ? resourceById.get(selectedResourceId) : undefined;

  const filteredTasks = tasks.filter((task) => {
    if (taskStatus !== "all" && task.status !== taskStatus) return false;
    const query = taskQuery.trim().toLocaleLowerCase();
    return !query || `${task.title} ${task.notes}`.toLocaleLowerCase().includes(query);
  }).sort((a, b) => (a.startDate ?? "9999-12-31").localeCompare(b.startDate ?? "9999-12-31") || a.createdAt.localeCompare(b.createdAt));

  const filteredResources = resources.filter((resource) => {
    if (folderFilter === "uncategorized" && resource.folderId !== null) return false;
    if (folderFilter !== "all" && folderFilter !== "uncategorized" &&
      resource.folderId !== folderFilter && folderById.get(resource.folderId ?? "")?.parentId !== folderFilter) return false;
    const query = resourceQuery.trim().toLocaleLowerCase();
    return !query || `${resource.title} ${resource.content} ${resource.source} ${folderPath(resource.folderId, folderById)}`.toLocaleLowerCase().includes(query);
  }).sort((a, b) => resourceSort === "title"
    ? a.title.localeCompare(b.title, "zh")
    : resourceSort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt));

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = captureTitle.trim();
    if (!title) return;
    if (await props.mutate(() => lifeApi.capture(title, captureNotes))) {
      setCaptureTitle(""); setCaptureNotes("");
    }
  }

  async function classify(item: InboxItem) {
    const saved = classifyAs === "task"
      ? await props.mutate(() => lifeApi.toTask(item.id, classifyDate, classifyDate))
      : await props.mutate(() => lifeApi.toResource(item.id, classifyFolder || null, classifyKind, classifySource));
    if (saved) setClassifyId(null);
  }

  async function createFolder(parentId: string | null) {
    const name = window.prompt(parentId ? "二级文件夹名称" : "一级文件夹名称")?.trim();
    if (!name) return;
    if (await props.mutate(() => lifeApi.createFolder(parentId, name)) && parentId) {
      setExpandedFolders((current) => new Set(current).add(parentId));
    }
  }

  async function renameFolder(folder: LifeFolder) {
    const name = window.prompt("重命名文件夹", folder.name)?.trim();
    if (name && name !== folder.name) await props.mutate(() => lifeApi.renameFolder(folder.id, name));
  }

  const title = props.view === "inbox" ? "收集箱" : props.view === "tasks" ? "任务总表" : "资料库";
  const subtitle = props.view === "inbox" ? "先记下来，再决定是任务还是资料。"
    : props.view === "tasks" ? "所有任务与今天使用同一份清单。" : "把笔记与链接放在自己的文件夹里。";

  return (
    <section className="schedule-panel life-panel" aria-label={title}>
      <header className="schedule-heading life-heading">
        <div><p className="section-kicker">生活管理</p><h1>{title}</h1><p className="schedule-subtitle">{subtitle}</p></div>
        <p className="schedule-meta">{props.view === "inbox" ? `${data?.inboxItems.length ?? 0} 条待整理` : props.view === "tasks" ? `${tasks.length} 项任务` : `${resources.length} 份资料`}</p>
      </header>
      {props.error ? <div className="life-error" role="alert">{props.error} <button type="button" onClick={() => void props.refresh()}>重试</button></div> : null}
      {!data && !props.error ? <p className="life-empty" role="status">正在读取生活管理数据…</p> : null}

      {props.view === "inbox" && data ? <>
        <form className="life-capture" onSubmit={(event) => void capture(event)}>
          <label htmlFor="life-capture-title">快速收集</label>
          <div className="life-capture-row"><input id="life-capture-title" value={captureTitle} maxLength={200} placeholder="想到什么，先写下来" onChange={(event) => setCaptureTitle(event.target.value)} />
            <button type="submit" disabled={props.busy || !captureTitle.trim()}><Plus size={16} />收集</button></div>
          <textarea aria-label="收集备注" value={captureNotes} maxLength={10000} rows={2} placeholder="补充说明（可选）" onChange={(event) => setCaptureNotes(event.target.value)} />
        </form>
        <div className="life-list">
          {data.inboxItems.length === 0 ? <Empty icon={<Inbox size={22} />} text="收集箱已清空" /> : data.inboxItems.map((item) => <article className="life-item" key={item.id}>
            <div className="life-item-head"><div><strong>{item.title}</strong><small>{formatTime(item.createdAt)}{item.sourceResourceId ? " · 来自资料" : ""}</small></div>
              <button type="button" className="life-icon-button" aria-label={`丢弃：${item.title}`} disabled={props.busy} onClick={() => void props.mutate(() => lifeApi.discard(item.id))}><Trash2 size={16} /></button></div>
            {item.notes ? <p>{item.notes}</p> : null}
          {classifyId === item.id ? <div className="life-classify">
              <div className="life-segment" role="group" aria-label="整理为"><button type="button" className={classifyAs === "task" ? "active" : ""} onClick={() => setClassifyAs("task")}>任务</button><button type="button" className={classifyAs === "resource" ? "active" : ""} onClick={() => setClassifyAs("resource")}>资料</button></div>
              {classifyAs === "task" ? <label>计划日期<input aria-label="计划日期" type="date" value={classifyDate} onChange={(event) => setClassifyDate(event.target.value)} /></label> : <>
                <label>资料类型<select aria-label="资料类型" value={classifyKind} onChange={(event) => setClassifyKind(event.target.value as "note" | "link")}><option value="note">笔记</option><option value="link">链接</option></select></label>
                <label>放入文件夹<FolderSelect folders={folders} value={classifyFolder} onChange={setClassifyFolder} /></label>
                <label>来源 / 链接<input aria-label="来源或链接" value={classifySource} maxLength={1000} onChange={(event) => setClassifySource(event.target.value)} /></label>
              </>}
              <div className="life-actions"><button type="button" onClick={() => setClassifyId(null)}>取消</button><button type="button" className="life-primary" disabled={props.busy || (classifyAs === "task" && !classifyDate)} onClick={() => void classify(item)}>确认整理</button></div>
            </div> : <button type="button" className="life-text-button" onClick={() => { setClassifyId(item.id); setClassifyAs("task"); setClassifyDate(props.today); }}>整理为任务或资料 <ChevronRight size={15} /></button>}
          </article>)}
        </div>
      </> : null}

      {props.view === "tasks" && data ? <>
        <div className="life-toolbar"><label className="life-search"><Search size={16} /><input aria-label="搜索任务" value={taskQuery} placeholder="搜索标题或备注" onChange={(event) => setTaskQuery(event.target.value)} /></label>
          <select aria-label="任务状态" value={taskStatus} onChange={(event) => setTaskStatus(event.target.value as typeof taskStatus)}><option value="all">全部状态</option><option value="open">待办</option><option value="completed">已完成</option></select></div>
        <div className="life-list">{filteredTasks.length === 0 ? <Empty icon={<Check size={22} />} text="没有符合条件的任务" /> : filteredTasks.map((task) => <article key={task.id} className={`life-item life-task ${task.status === "completed" ? "life-task--done" : ""}`}>
          <button type="button" className="life-task-main" onClick={() => setSelectedTaskId(selectedTaskId === task.id ? null : task.id)} aria-expanded={selectedTaskId === task.id}><strong>{task.title}</strong><small>{task.startDate ?? "未安排日期"}{task.endDate && task.endDate !== task.startDate ? ` → ${task.endDate}` : ""} · {task.archived ? "Notion 已归档" : task.status === "completed" ? "已完成" : "待办"}{notionByTaskId[task.id] ? " · Notion 联动" : ""}{links.some((link) => link.taskId === task.id) ? " · 有关联资料" : ""}</small></button>
          {selectedTaskId === task.id ? <div className="life-detail"><p>{task.notes || "暂无备注"}</p>{notionByTaskId[task.id] ? <p>归属：{[notionByTaskId[task.id].areaName, notionByTaskId[task.id].projectName].filter(Boolean).join(" / ") || "未设置"}{notionByTaskId[task.id].url ? <> · <a href={notionByTaskId[task.id].url!} target="_blank" rel="noopener noreferrer">在 Notion 查看任务</a></> : null}{notionByTaskId[task.id].projectUrl ? <> · <a href={notionByTaskId[task.id].projectUrl!} target="_blank" rel="noopener noreferrer">查看项目</a></> : null}</p> : null}<h3>关联资料</h3>
            <div className="life-chips">{links.filter((link) => link.taskId === task.id).map((link) => resourceById.get(link.resourceId)).filter((value): value is LifeResource => Boolean(value)).map((resource) => <button type="button" key={resource.id} onClick={() => { setSelectedResourceId(resource.id); setFolderFilter("all"); props.onViewChange("library"); }}>{resource.title}</button>)}{!links.some((link) => link.taskId === task.id) ? <span>暂无关联资料</span> : null}</div>
            <LinkSelector resources={resources.filter((resource) => !links.some((link) => link.taskId === task.id && link.resourceId === resource.id))} onChoose={(resourceId) => void props.mutate(() => lifeApi.link(resourceId, task.id))} />
            {task.startDate === null && notionByTaskId[task.id] ? <div className="life-actions"><label>安排日期<input type="date" aria-label={`安排日期：${task.title}`} value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} /></label><button type="button" disabled={props.busy || !scheduleDate} onClick={() => void (async () => { if (await props.onScheduleTask(task, scheduleDate)) await props.refresh(); })()}>安排</button></div> : null}
            <div className="life-actions"><button type="button" disabled={props.busy} onClick={() => void (async () => { if (await props.onCompleteTask(task)) await props.refresh(); })()}>{task.status === "completed" ? "恢复任务" : "标为完成"}</button><button type="button" className="life-primary" disabled={task.startDate === null} onClick={() => props.onOpenTask(task)}>编辑任务</button></div>
          </div> : null}
        </article>)}</div>
        {selectedTask && links.some((link) => link.taskId === selectedTask.id) ? <p className="life-hint">在资料库中可查看和编辑关联资料。</p> : null}
      </> : null}

      {props.view === "library" && data ? <>
        <div className="life-folder-toolbar"><button type="button" onClick={() => void createFolder(null)} disabled={props.busy}><FolderPlus size={16} />新建一级文件夹</button><button type="button" className="life-primary" onClick={() => { setNewResource(true); setSelectedResourceId(null); }}><Plus size={16} />新建资料</button></div>
        <div className="life-library-layout"><nav className="life-folders" aria-label="资料文件夹">
          <button type="button" className={folderFilter === "all" ? "selected" : ""} onClick={() => setFolderFilter("all")}>全部资料 <small>{resources.length}</small></button>
          <button type="button" className={folderFilter === "uncategorized" ? "selected" : ""} onClick={() => setFolderFilter("uncategorized")}>待整理 <small>{resources.filter((resource) => resource.folderId === null).length}</small></button>
          {folders.filter((folder) => folder.parentId === null).map((folder) => {
            const children = folders.filter((child) => child.parentId === folder.id);
            const open = expandedFolders.has(folder.id);
            return <div key={folder.id} className="life-folder-group"><div className="life-folder-row">
              <button type="button" className="life-expand" aria-label={`${open ? "折叠" : "展开"}${folder.name}`} onClick={() => setExpandedFolders((current) => { const next = new Set(current); if (open) next.delete(folder.id); else next.add(folder.id); return next; })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button type="button" className={folderFilter === folder.id ? "selected" : ""} onClick={() => setFolderFilter(folder.id)}><Folder size={14} />{folder.name}<small>{resources.filter((resource) => resource.folderId === folder.id || children.some((child) => child.id === resource.folderId)).length}</small></button>
              <button type="button" className="life-expand" aria-label={`新建${folder.name}的子文件夹`} onClick={() => void createFolder(folder.id)}><Plus size={14} /></button>
            </div>{open ? <div className="life-folder-children">{children.map((child) => <div key={child.id} className="life-folder-row"><button type="button" className={folderFilter === child.id ? "selected" : ""} onClick={() => setFolderFilter(child.id)}><Folder size={14} />{child.name}<small>{resources.filter((resource) => resource.folderId === child.id).length}</small></button><button type="button" className="life-expand" aria-label={`重命名${child.name}`} onClick={() => void renameFolder(child)}>···</button></div>)}<button type="button" className="life-rename" onClick={() => void renameFolder(folder)}>重命名“{folder.name}”</button></div> : null}</div>;
          })}
        </nav><div className="life-library-main"><div className="life-toolbar"><label className="life-search"><Search size={16} /><input aria-label="搜索资料" value={resourceQuery} placeholder="搜索标题、内容、来源和路径" onChange={(event) => setResourceQuery(event.target.value)} /></label><select aria-label="资料排序" value={resourceSort} onChange={(event) => setResourceSort(event.target.value as typeof resourceSort)}><option value="updated">最近更新</option><option value="created">最近创建</option><option value="title">按标题</option></select></div>
          <div className="life-list">{filteredResources.length === 0 ? <Empty icon={<FileText size={22} />} text="这里还没有资料" /> : filteredResources.map((resource) => <article key={resource.id} className="life-item"><button type="button" className="life-task-main" onClick={() => { setSelectedResourceId(resource.id); setNewResource(false); }}><strong>{resource.kind === "link" ? <Link2 size={15} /> : <FileText size={15} />}{resource.title}</strong><small>{folderPath(resource.folderId, folderById)} · 更新于 {formatTime(resource.updatedAt)}</small></button></article>)}</div>
        </div></div>
        {(newResource || selectedResource) ? <ResourceEditor key={selectedResource?.id ?? "new"} resource={newResource ? undefined : selectedResource} folders={folders} tasks={tasks} links={links.filter((link) => link.resourceId === selectedResource?.id).map((link) => link.taskId)} busy={props.busy} mutate={props.mutate} onOpenTask={props.onOpenTask} onInboxCreated={() => props.onViewChange("inbox")} onSaved={(resource) => { setNewResource(false); setSelectedResourceId(resource.id); }} onClose={() => { setNewResource(false); setSelectedResourceId(null); }} /> : null}
      </> : null}
    </section>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="life-empty">{icon}<p>{text}</p></div>;
}

function FolderSelect({ folders, value, onChange }: { folders: LifeFolder[]; value: string; onChange: (value: string) => void }) {
  return <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">待整理</option>{folders.filter((folder) => folder.parentId === null).map((folder) => <optgroup label={folder.name} key={folder.id}><option value={folder.id}>{folder.name}</option>{folders.filter((child) => child.parentId === folder.id).map((child) => <option value={child.id} key={child.id}>{folder.name} / {child.name}</option>)}</optgroup>)}</select>;
}

function LinkSelector({ resources, onChoose }: { resources: LifeResource[]; onChoose: (id: string) => void }) {
  const [value, setValue] = useState("");
  return <div className="life-link-picker"><select aria-label="选择关联资料" value={value} onChange={(event) => setValue(event.target.value)}><option value="">选择资料…</option>{resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.title}</option>)}</select><button type="button" disabled={!value} onClick={() => { onChoose(value); setValue(""); }}>关联</button></div>;
}

function ResourceEditor({ resource, folders, tasks, links, busy, mutate, onOpenTask, onInboxCreated, onSaved, onClose }: {
  resource?: LifeResource; folders: LifeFolder[]; tasks: Task[]; links: string[]; busy: boolean;
  mutate: Props["mutate"]; onOpenTask: Props["onOpenTask"]; onInboxCreated: () => void;
  onSaved: (resource: LifeResource) => void; onClose: () => void;
}) {
  const [form, setForm] = useState<ResourceInput>({ folderId: resource?.folderId ?? null, kind: resource?.kind ?? "note", title: resource?.title ?? "", content: resource?.content ?? "", source: resource?.source ?? "" });
  const [taskId, setTaskId] = useState("");
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.title.trim()) return;
    let saved: LifeResource | undefined;
    if (await mutate(async () => { saved = resource ? await lifeApi.updateResource(resource.id, form) : await lifeApi.createResource(form); })) {
      if (saved) onSaved(saved);
    }
  }

  return <section className="life-resource-editor" aria-label={resource ? `编辑资料：${resource.title}` : "新建资料"}><div className="life-editor-head"><h2>{resource ? "资料详情" : "新建资料"}</h2><button type="button" onClick={onClose}>关闭</button></div>
    <form onSubmit={(event) => void save(event)}><div className="life-form-grid"><label>标题<input aria-label="资料标题" value={form.title} maxLength={200} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></label><label>类型<select aria-label="资料类型" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "note" | "link" })}><option value="note">笔记</option><option value="link">链接</option></select></label></div>
      <label>文件夹<FolderSelect folders={folders} value={form.folderId ?? ""} onChange={(value) => setForm({ ...form, folderId: value || null })} /></label>
      <label>内容<textarea aria-label="资料内容" value={form.content} maxLength={10000} rows={4} onChange={(event) => setForm({ ...form, content: event.target.value })} /></label>
      <label>来源 / 链接<input aria-label="资料来源" value={form.source} maxLength={1000} onChange={(event) => setForm({ ...form, source: event.target.value })} /></label>
      {resource ? <p className="life-hint">路径：{folderPath(resource.folderId, folderById)} · 创建于 {formatTime(resource.createdAt)} · 更新于 {formatTime(resource.updatedAt)}</p> : null}
      <div className="life-actions"><button type="submit" className="life-primary" disabled={busy || !form.title.trim()}>{resource ? "保存资料" : "创建资料"}</button></div>
    </form>
    {resource ? <div className="life-resource-links"><h3>关联任务</h3><div className="life-chips">{links.map((id) => tasks.find((task) => task.id === id)).filter((task): task is Task => Boolean(task)).map((task) => <span key={task.id}><button type="button" onClick={() => onOpenTask(task)}>{task.title}</button><button type="button" aria-label={`取消关联：${task.title}`} onClick={() => void mutate(() => lifeApi.unlink(resource.id, task.id))}>×</button></span>)}{links.length === 0 ? <span>暂无关联任务</span> : null}</div>
      <div className="life-link-picker"><select aria-label="选择关联任务" value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">选择任务…</option>{tasks.filter((task) => !links.includes(task.id)).map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select><button type="button" disabled={!taskId || busy} onClick={() => void (async () => { if (await mutate(() => lifeApi.link(resource.id, taskId))) setTaskId(""); })()}>关联</button></div>
      <button type="button" className="life-text-button" disabled={busy} onClick={() => void (async () => {
        if (await mutate(() => lifeApi.capture(resource.title, resource.content, resource.id))) onInboxCreated();
      })()}>从这份资料创建任务 → 收集箱</button>
    </div> : null}
  </section>;
}

function folderPath(id: string | null, folders: Map<string, LifeFolder>) {
  if (!id) return "待整理";
  const folder = folders.get(id);
  if (!folder) return "待整理";
  return folder.parentId ? `${folders.get(folder.parentId)?.name ?? "?"} / ${folder.name}` : folder.name;
}

function formatTime(instant: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}
