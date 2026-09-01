# NewDay

NewDay 是一个本地优先的个人日计划与时间块应用。任务可以先留在“待安排”，再拖入当天时间轴；也可以在编辑器里直接设置开始时间和时长。

## MVP 功能

- 按日期管理任务，支持快速添加、编辑、完成和恢复
- 待安排列表与 07:00–23:00 当天时间轴左右分栏
- 拖入时间轴、移动和拉伸时间块，统一按 15 分钟吸附
- 允许时间块重叠，并同时标记所有冲突项
- 表单手动设置开始时间和时长，手机端无需拖拽也能完成安排
- 将未完成任务一键移到下一天，并清除原时间块
- 最近一次安排、移动、拉伸、取消安排或完成操作可撤销
- 版本化 JSON 导入/导出；替换导入前自动下载当前数据备份
- 数据保存在当前浏览器的 IndexedDB 中，无需账号

技术探针保留在 `/spike`，用于独立验证 FullCalendar 交互。

## 本地开发

要求：Node.js 20+、pnpm 10+。

```bash
pnpm install
pnpm dev
```

打开 <http://localhost:3000>。

## 验证

```bash
# ESLint + TypeScript + Vitest
pnpm check

# Chrome 与 Safari WebKit 端到端测试
pnpm test:e2e

# 生产构建
pnpm build
```

首次运行端到端测试时，如本机尚未安装 Playwright 浏览器：

```bash
pnpm exec playwright install chrome webkit
```

## 架构

核心代码位于 `src/modules/planner/`：

- `domain/`：`Task`、`TimeBlock`、偏好设置及 Zod 领域校验
- `application/`：`PlannerCommand` 类型与命令执行、当日计划查询、冲突计算、备份与恢复
- `adapters/`：Dexie/IndexedDB Store 与内存测试 Store
- `ui/`：真实 Day Planner 和独立时间轴探针

FullCalendar 只是时间轴 UI Adapter，不直接拥有业务数据。所有修改都通过 `PlannerCommand` 进入 Store，并在 Dexie 事务中执行。底层模型支持 `Task 1:N TimeBlock`；MVP 界面暂时限制每个任务一个时间块。

领域词汇和边界记录在 [`CONTEXT.md`](./CONTEXT.md)。

## 数据与备份

NewDay 不会把计划上传到服务端。清除浏览器站点数据会删除本地计划，因此建议定期使用右上角“导出”。

导入文件会先经过 Zod 完整校验，再以单个事务替换现有任务、时间块和偏好设置。替换前会自动下载一份 `newday-before-import-*.json` 安全备份。
