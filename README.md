# NewDay

NewDay 是一个在本机运行的每日任务清单，只关注“哪几天需要看到这件事”，不提供小时级时间轴。项目采用独立的 Next.js 前端和 Fastify 后端，任务保存在后端 SQLite 中；前端通过 HTTP 读写任务。可选的规划助手根据当天目标和限制，从已有任务中建议今日重点，由用户预览和确认后应用。

## 项目管理

需求、进度和验收统一放在 [Linear · NewDay](https://linear.app/colife/project/newday-aa09602a66c8)，代码、分支、提交与 PR 放在 [GitHub · ZZZZihan/NewDay](https://github.com/ZZZZihan/NewDay)。后续开发先关联 Linear issue，再以 `COL-编号` 串起分支、提交和 PR；具体步骤见 [Linear + Git 工作流](./docs/project-management.md)。

## 交付状态（2026-09-20 快照）

以下功能说明对应尚未合并的候选分支，不代表 `main`、已部署服务或个人真实数据已经验收。实时状态以各 PR 与 Linear 为准。

| 层级 | 候选与已核实结果 | 尚需完成 |
| --- | --- | --- |
| `main` | `1de8e6c088f08f229e49b21b3469f6259e51bcdb`；仍是基础前端版本 | 本页描述的 API/SQLite、Agent 和生活管理候选尚未合入 |
| [PR #1 · COL-22](https://github.com/ZZZZihan/NewDay/pull/1) | `61be91776160e2aa6028f75840d2cd26bea39df0`，Next.js/Fastify/SQLite 重构与 Agent 软件链路；隔离复跑 `pnpm check`、`pnpm build`、Chrome/Safari WebKit E2E 56/56 通过 | 代码与数据恢复审查、人工流程验收、用户批准合并 |
| [PR #2 · COL-26～30](https://github.com/ZZZZihan/NewDay/pull/2) | `1a64aed1e9928d4491ef92eb439a0352081879bc`，收集箱、任务总表及资料库候选；相同命令隔离复跑，E2E 62/62 通过 | 依赖 PR #1；备份恢复和撤销后的跨视图刷新修复见 [PR #4](https://github.com/ZZZZihan/NewDay/pull/4) `c4c00da`，该修复候选独立复跑 Chrome/WebKit E2E 66/66；按 PR #1 实际合并结果整理分支后重验并获批准合并 |
| [PR #3 · COL-32](https://github.com/ZZZZihan/NewDay/pull/3) | Notion 联动契约及合成 fixture 候选，见 [契约说明](./docs/notion-sync-contract.md) | OAuth、真实隔离工作区、同步与恢复尚未实现或验收 |
| [COL-23](https://linear.app/colife/issue/COL-23) / [COL-24](https://linear.app/colife/issue/COL-24) | Agent 的真实模型 G3 与连续七天使用 G4 尚未执行 | 分别按冻结协议和真实记录验收；软件测试不能替代 |

以上复跑使用独立工作树、端口 `3100/3002` 和临时 SQLite；GitHub 当前未返回候选 Check Runs 或审查结论。替换导入前下载安全备份及 JSON 备份恢复属于候选实现，尚未在个人真实数据上试用。NewDay/Notion 联动的完整进度由 [COL-31](https://linear.app/colife/issue/COL-31) 跟踪，T1～T8 分项为 COL-32～COL-39。COL-33 的 OAuth 隔离候选配置与未验收边界见 [Notion OAuth 运维说明](./docs/notion-oauth-operations.md)。

## 核心功能

- 桌面端采用左右分栏：左侧显示大号当前时钟，右侧专注每日任务
- 周日期导航紧跟时钟与日期，下方保留当日待办/完成概览和固定寄语
- 支持亮色与暗色模式：首次跟随系统，手动切换后在当前浏览器中记住选择
- 使用左右箭头按天切换，也可以通过日期选择器直接跳转
- 任务只保留开始日期和截止日期，两个日期默认都是当前选中的当天
- 任务会显示在开始日期到截止日期之间的每一天，日期范围包含首尾两天
- 支持快速添加、编辑、完成、恢复和删除任务
- 今天会继续显示逾期未完成任务，并可选最多三项“今日重点”
- 支持每天、工作日、每周指定星期和每月重复；每月 29/30/31 日自动夹到月末
- 重复实例可以单独编辑或改期，也可以从当前实例开始更新或停止后续重复；规则变更只影响生效日期及以后
- 停止后续重复前会预览受影响的普通实例、重点记录和保留实例
- 完成、恢复、删除、改期、更新或停止重复后可在 10 秒提示窗口内撤销
- 导入与导出收纳在右上角“更多”菜单中；替换导入前自动下载当前数据备份
- 数据保存在后端 SQLite 中，刷新页面、更换浏览器或重启服务后仍可读取同一份任务
- 无需账号，当前面向本机单人使用
- 兼容旧版浏览器数据：首次连接空服务端时迁移，旧版单日任务转换为开始日期和截止日期相同的任务
- 旧浏览器数据支持单独下载备份，下载后可手动清除旧 IndexedDB

## 今日规划助手

页面中的“帮我定今日重点”入口可填写当天目标、精力、可承担数量、明确任务限制和偏好。首次使用需确认规划时区；浏览器只提供建议，保存后才成为后端计算“今天”的依据。未提供的信息保持未知，任务的展示截止日期不会自动成为外部硬承诺。

助手只建议 **1–3 件已有、当天可执行的未完成任务**。可执行候选包含逾期工作；明确等待他人或条件满足的任务不可采纳。必要时最多澄清一轮、提出两个问题。没有可执行任务、明确休息或必选条件无法同时满足时，可以返回无动作，保留已有重点。

建议生成不修改任务。用户可调整最终集合，查看新增、保留、移除的重点预览，再确认采纳。后端在一个事务中检查日期、数据集及版本，替换今日重点最终集合，并保存执行回执。任务或当天输入已变化时会拒绝旧提案，要求重新生成。新增、完成、删除、改期和重复规则仍由手动功能完成；首版不提供周期调度、关闭页面后的主动规划或外部工具执行。

执行响应丢失时，页面保留原 `operationId` 查询结果，不会用新标识盲目重试。同一标签页刷新可用 `sessionStorage` 恢复运行、澄清请求和待确认操作的标识；关闭标签页后的浏览器会话恢复不在保证范围内。服务端的运行记录和执行账本保存在 SQLite，可以跨 API 重启查询。未完成的模型运行在服务重启后标为中断，不会自动续跑。

“恢复采纳前的重点”使用持久执行记录，仅在同日、同数据集、版本和任务状态仍符合条件时可用。它只恢复该次重点集合；手动操作的 **10 秒撤销** 仍是另一套绑定页面实例的短期回执，不能跨刷新或 API 重启使用。历史保留当时建议、最终选择、反馈和已有事件；当日结果只依据采纳后同日的记录，缺失结果标为未知。

软件集成、真实模型质量和实际使用效果分别验收；当前交付进度与验证证据见 [Agent 开发执行记录](./docs/agent-development-status.md)。

## 本地开发

要求：**Node.js 24+、pnpm 10+**。后端使用 Node 内置的 `node:sqlite`，无需单独安装数据库服务。

```bash
pnpm install
pnpm dev
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。根目录的 `pnpm dev` 同时启动两个独立进程：

| 服务 | 工作区 | 默认地址 | 职责 |
| --- | --- | --- | --- |
| Web | `apps/web` | `http://127.0.0.1:3000` | 页面、交互、同源 `/api` 转发 |
| API | `apps/api` | `http://127.0.0.1:3001` | 请求校验、业务执行、SQLite 持久化 |

前后端也可以在两个终端分别运行：

```bash
# 终端一
pnpm dev:api

# 终端二
pnpm dev:web --hostname 127.0.0.1 --port 3000
```

需要自定义端口或数据库路径时，将 [`.env.example`](./.env.example) 复制为根目录 `.env`。`pnpm dev` / `pnpm start` 的统一启动器会读取这个文件；`dev:web` / `dev:api` / `start:web` / `start:api` 直接运行各工作区，**不会自动加载根目录 `.env`**，需要通过进程环境传入配置。

## 构建与启动

```bash
pnpm build
pnpm start
```

`build` 构建两个服务，`start` 同时启动构建后的 API 和 Web。也可以使用 `pnpm start:api`、`pnpm start:web --hostname 127.0.0.1 --port 3000` 分别启动。

Next.js 的 `/api` 转发目标 `NEWDAY_API_ORIGIN` 会写入生产构建。如果修改了 API 地址，必须在 **构建前** 设置该变量并重新构建。根目录 `pnpm build` 不读取根 `.env`，例如：

```bash
NEWDAY_API_ORIGIN=http://127.0.0.1:3001 pnpm build
```

当前没有账号、身份认证或租户隔离，默认统一启动器只监听本机回环地址。前端需要连接后端才能保存任务，目前没有离线写入队列。

## 模型配置与发送范围

模型生成默认关闭：`NEWDAY_AGENT_PROVIDER=disabled`。手动清单保持可用，界面会提示尚未配置模型。按 [`.env.example`](./.env.example) 配置 API 进程后，可启用兼容 Chat Completions 结构化输出的服务：

```dotenv
NEWDAY_AGENT_PROVIDER=openai-compatible
NEWDAY_AGENT_BASE_URL=https://api.openai.com/v1
NEWDAY_AGENT_MODEL=your-approved-model-id
NEWDAY_AGENT_API_KEY=replace-me
NEWDAY_AGENT_TIMEOUT_MS=30000
NEWDAY_AGENT_MAX_OUTPUT_TOKENS=1200
```

服务地址默认使用 HTTPS；本机回环地址允许 HTTP。已有局域网中转可用 `NEWDAY_AGENT_ALLOW_HTTP_ORIGIN` 明确许可一个精确的 HTTP 来源（协议、主机和端口，不含路径），必须与服务地址匹配；该许可不跟随重定向。`NEWDAY_AGENT_REASONING_EFFORT` 可选为 `none`、`low`、`medium`、`high`，仅对支持此参数的模型配置，未设置时不发送。密钥只交给 API 进程，不写入浏览器响应、Agent 记录或备份。`scripted` 是受隔离数据库限制的端到端测试替身，不能用作真实模型效果的证据。

需要模型生成时，会把规划快照发送到所配置服务：候选任务的 ID、标题、备注、日期和状态，已有重点，当天目标及明确限制，时区和显式偏好，以及相关版本和采样时间。允许参考历史时还包含当前数据集最近的已记录任务结果和用户反馈原文；关闭该选项后不提供这些历史内容。澄清续轮会一并发送问题与用户答案。任务备注和反馈按数据处理，不具有改变执行权限的作用。

单次模型请求默认最长 **30 秒**，每轮最多 **3 次调用**，包括澄清续轮及最多一次格式修复；不会无限重试。每次响应的输出 token 上限默认 `1200`。这些是请求级限制，不是总金额预算；真实试验前需确定服务、模型、可发送数据范围和费用预算。模型未返回用量时记录为未知，不按零计。真实调用与建议质量的验收状态以 [开发执行记录](./docs/agent-development-status.md) 为准。

配置后可以显式执行一次隔离的真实生成验证：

```bash
# 仅检查配置，不发送模型请求
pnpm agent:smoke --preflight

# 默认最多一次真实请求；不在 check 或 E2E 中自动运行
pnpm agent:smoke
```

该命令读取根 `.env`（可用 `--env /path/to/file` 指定），另建系统临时 SQLite，只发送三个合成任务，不读取开发任务库或保留评测集，不采纳建议。输出 `report.json` 与摘要，记录真实出站次数、模型返回 ID、用量、耗时、提案及生成前后任务/重点/账本不变的比较。仅这个合成验证脚本会保存有大小限制、已脱敏的模型响应诊断；生产 API 不记录原始响应包。`headersMs` 是等待响应头耗时，`elapsedMs` 包含诊断读取响应体的时间。默认一次请求额度也包含失败请求；即使运行层尝试格式修复，也不会再发第二次请求。明确需要更多时可用 `--max-calls 2` 或 `3`。报告中的调用次数不是金额，费率未知时费用保持未知；一次连通性验证不代替 G3 模型质量评测。

## 验证

```bash
# ESLint（含目录边界）+ TypeScript + 单元测试 + API/SQLite 测试
pnpm check

# 生产构建
pnpm build

# Chrome 与 Safari WebKit 端到端测试
pnpm test:e2e
```

首次运行端到端测试时，如本机尚未安装 Playwright 浏览器：

```bash
pnpm exec playwright install chrome webkit
```

端到端测试使用独立端口 `3100` / `3002` 和系统临时目录中的 SQLite，测试结束后清理；不复用开发服务，也不重置开发数据库。

## 架构

```text
apps/
  web/                     Next.js 前端
    src/app/               路由、布局和错误边界
    src/features/planner/  components、hooks、api、lib、migration
    src/features/agent/    规划输入、建议预览、会话恢复、历史与反馈
    src/features/theme/    主题偏好与切换
    src/shared/http/       两个功能共用的 HTTP 请求与错误转换
    src/styles/            页面样式
  api/                     Fastify 后端
    src/http/              HTTP 路由与请求校验
    src/services/          业务调用编排、撤销归属与有效期
    src/agent/             受限模型接口、提示词、输出校验与 provider
    src/storage/           SQLite 表、索引与事务
    tests/                 API 集成与真实 SQLite 测试
packages/
  core/src/
    domain/                任务模型、日期与重复规则
    application/           命令、查询、撤销和存储接口
    contracts/             任务备份、Agent 规划与独立备份的合同和校验
tests/                     单元测试、测试替身、架构边界与浏览器 E2E
tooling/                   双服务启动器与 ESLint 架构规则
docs/                      架构说明
data/                      运行时 SQLite，已被 Git 忽略
```

`core/application` 在 API 进程中执行业务，前端只能导入其类型；前后端可以共享 `domain` 和 `contracts`。任务命令、重复实例生成、每日分组查询、瞬时撤销、备份与恢复都经后端执行，SQLite Store 负责事务提交。

各目录职责、依赖图、API 清单和修改入口见 [架构说明](./docs/architecture.md)。依赖方向由 ESLint 与架构测试执行检查。

领域词汇记录在 [`CONTEXT.md`](./CONTEXT.md)。

## 数据与备份

任务的权威副本是后端 SQLite，默认路径为仓库根目录下的 `data/newday.sqlite`，可用 `NEWDAY_DATABASE_PATH` 指定其他路径。清除浏览器站点数据不再删除服务端任务，但会清除该浏览器的主题偏好和旧版浏览器任务。使用右上角“导出”保存可恢复的 JSON 备份。

导入备份会替换服务端全部规划数据，不做合并；前端会先下载当前服务端数据作为安全备份。请保留下载文件。

旧版 `newday` IndexedDB 的迁移读取不升级、不修改原数据库。服务端为空且尚未记录旧数据迁移时才接收；服务端已有数据时会提示冲突，并保留浏览器原数据供下载。迁移本身不会自动删除旧库；“下载旧浏览器备份”后可使用“清除旧浏览器数据”，仅清除此浏览器的旧任务库。

新版导出格式版本为 `4`，包含任务、分段重复规则和今日重点记录。导入仍兼容旧版 `1`、`2` 与 `3` 格式：旧任务会补齐日期范围与完成日期字段，旧重复系列会补齐稳定逻辑标识和规则段边界。

任务备份 v4 不包含 Agent 数据。Agent 上下文、偏好、运行、提案、反馈、事件和回执有单独的 `newday-agent` v1 JSON 格式，目前通过 `/api/agent/backup` API 导出和导入。独立导入保留来源数据集的只读历史及原始归档，不按同名任务 ID 关联当前任务，不重建可执行操作，也不激活导入的当天上下文。可明确选择是否导入偏好；导入后生成新数据集 epoch，使原活动提案和恢复资格失效，任务数据保持原样。

`DELETE /api/agent/history` 可清除 Agent 展示历史和上下文，保留任务、显式偏好，以及操作 ID、请求摘要、数据集归属和执行终态组成的最小去重账本。已清理操作仍返回 `details_deleted` 终态，不能因删除详情而重新执行。关闭历史参考与清除历史是两项独立操作；详细接口见 [架构说明](./docs/architecture.md)。
