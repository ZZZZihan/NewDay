# NewDay 的 Linear + Git 工作流

从 2026-09-08 起，Linear 管理需求、优先级、进度、验收和阻塞，Git/GitHub 保存代码版本与审查记录。下次继续开发时，先查看 Linear 和 Git 当前状态，再确定本次工作范围。

## 固定入口

| 项目 | 入口或标识 |
| --- | --- |
| Linear 项目 | [NewDay](https://linear.app/colife/project/newday-aa09602a66c8) |
| Linear 项目 ID | `3456fad5-6548-4edb-8cb4-d5448e7df87c` |
| 团队 | CoLife，issue 前缀 `COL` |
| 团队 ID | `e56da74f-a8d0-495b-ad01-e995818a3328` |
| GitHub | [ZZZZihan/NewDay](https://github.com/ZZZZihan/NewDay) |
| Git remote | `origin` → `https://github.com/ZZZZihan/NewDay.git` |
| 当前状态入口 | [`docs/project-state.md`](./project-state.md)，带核对时间并链接实时来源 |
| 架构与验证 | [`docs/architecture.md`](./architecture.md)，已随 COL-22 及后续主线提交收录 |
| Agent 阶段与既有证据 | [`docs/agent-development-status.md`](./agent-development-status.md)，历史执行记录；当前结论见状态入口 |

这些文档已进入 Git 历史。仍须区分某个提交内的 dated snapshot 与 GitHub/Linear 实时状态；本地未提交文件也仍不能冒充已发布内容。

项目已添加 GitHub 资源链接。原生 GitHub 集成的安装和自动状态同步尚未核实；在确认前，由开发者或获授权的 agent 显式维护 issue 与 PR 的双向链接及状态。

## 一项开发工作的流程

1. 在 NewDay 项目中查找相同需求，优先继续已有 issue。新 issue 写清目标、范围、可检验的完成条件和已知依赖；尚未确定的日期、预算或负责人保持未设置。
2. 查看 `git status --short`、当前分支、暂存区、远端和相关 PR。辨明已有改动归属，确认本次要提交的范围。不要用当前 HEAD 代替含未提交文件的工作树版本。
3. 真正开始实现时将 issue 改为 `In Progress`。新分支采用 `codex/col-<number>-<short-description>`；继续已有工作可沿用原分支并在 issue 记录，不为改名丢弃或混入改动。
4. 按项目架构实施，按明确文件或差异块暂存，审查暂存 diff 后提交。提交消息和 PR 标题包含完整 issue 标识，例如 `feat(COL-22): establish planner integration baseline`。个人 `.env`、运行数据库、日志和密钥不进入提交。
5. 在本次范围要求的验证通过后推送交付分支，创建或更新 PR。PR 使用 [模板](../.github/pull_request_template.md)，填写 Linear URL、候选 SHA、行为变化、检查结果和仍待验收的部分。不要把整个脏工作区直接打包提交。
6. 将 PR 链接、候选 SHA、验证命令及结果回填到 Linear，进入 `In Review`。结果必须对应审查中的候选版本；候选变化后，按影响补跑验证并更新证据。
7. 合并沿用用户在当前任务中的授权。合并且满足该 issue 的验收条件后设为 `Done`；合并记录、部署完成、真实模型质量和实际使用效果分别核验。文档或管理类事项可在具体交付物核验后完成。

PR 正文直接保留 Linear issue URL，issue 直接保留 PR URL。自动关联或状态变更只有观察到实际结果后才算生效。

每项开发在 PR、Linear 或验收报告中至少记录：目标、范围、验收 ID、实际运行证据、候选 SHA，以及仍未解除的阻塞或范围外事项。候选变化后更新绑定；不能用另一 SHA 的绿灯、合并事件或部署状态替代当前候选验收。

## 状态约定

| 状态 | 使用条件 |
| --- | --- |
| Backlog | 已记录，尚未安排执行 |
| Todo | 已准备好作为后续工作，但尚未开始 |
| In Progress | 正在实施 |
| In Review | 候选代码与相关验证已提供，等待审查或合并 |
| Done | 满足本 issue 的完成条件；代码事项还要求已合并 |
| Canceled / Duplicate | 明确取消，或关联到实际继续执行的重复事项 |

有阻塞时记录具体依赖和解除条件；不要因为等待输入就把工作标为完成。团队当前没有独立的 Blocked 状态。

## 验证记录

一般实现执行 `pnpm check` 与 `pnpm build`；涉及 HTTP、持久化或浏览器行为时运行相关 `pnpm test:e2e` 场景，并遵守 [AGENTS.md](../AGENTS.md) 与架构说明。纯文档变更检查 diff、链接和事实一致性即可。

记录准确的命令、退出结果、候选 SHA，以及未运行的必要检查及原因。浏览器测试使用隔离端口 `3100/3002` 与一次性 SQLite；执行替换导入场景前仍须核实候选版本的实际测试配置。现有测试记录只证明其记录的版本与范围；scripted、smoke、一次真实 pilot 或同步验收都不能替代完整 G3/G4。

## 首批跟踪事项

| Issue | 范围 |
| --- | --- |
| [COL-21](https://linear.app/colife/issue/COL-21) | 建立 Linear + Git 项目协作流程 |
| [COL-22](https://linear.app/colife/issue/COL-22) | 整理现有重构与规划助手的 Git 交付基线 |
| [COL-23](https://linear.app/colife/issue/COL-23) | G3：验证今日规划助手的真实模型质量 |
| [COL-24](https://linear.app/colife/issue/COL-24) | G4：收集人工基线与七天实际使用效果 |

这张表只提供入口，实时状态以 Linear 为准。

以下两段仅是 **2026-09-08 流程初始化的历史证据**，不描述当前主线；当前结论见[项目状态入口](./project-state.md)。当时当前分支为 `feature/simple-daily-planner`，HEAD 为 `f7d8ccf6c7d36f3a7284fa87e082de18df0122b7`。原工作区有尚未提交的架构拆分与 Agent 实现；另有本地集成快照 `888d915e29f6b43b1f4a3acc130ea1e2ce0e2484`，其后工作区又有变化。COL-22 负责将这些状态核对为可审查的 Git 交付，本次流程初始化保留原分支、HEAD、暂存区及既有改动。

初始化时，GitHub 默认分支是 `main`，内容早于当前功能分支；仓库为 public。后续操作先实时核实，不在本次流程设置中改变默认分支或仓库可见性。
