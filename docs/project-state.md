# NewDay 项目状态（核对于 2026-09-22）

核对时间：2026-09-22 04:08:30 Asia/Shanghai。本文是一次可追溯快照，不声称永久实时；最新代码和任务状态分别以 [GitHub](https://github.com/ZZZZihan/NewDay) 与 [Linear · NewDay](https://linear.app/colife/project/newday-aa09602a66c8) 为准。

## 源码锚点

| 层级 | 核对结果 |
| --- | --- |
| 已合并主线 | `main` / `853898d27203e53fc38c8d289d9ae13910bfce8e`，tree `c69c0c6684657ba9eef9f84d34ce0bc6044d2240`；[PR #1～#11、#14～#20](https://github.com/ZZZZihan/NewDay/pulls?q=is%3Apr+is%3Amerged) 已合并 |
| 当前核心候选 | [PR #21 · COL-40](https://github.com/ZZZZihan/NewDay/pull/21)，分支 `codex/col-40-sync-consistency-hardening`；实现/CI 提交 `471279d93634f77996e9060e9f87472334c1de05`，加入 H04/H05 后的已验证候选 `cb2a72633ff73f84cbdea0985455a77358d92aec`、tree `8c0011ca84cd3ffeb73ca5a257a44d141f703e76`；受控红灯已由 `fb696dc…` 恢复到同一 tree，最终报告绑定提交会使 PR head 前移 |
| 历史复审基线 | `853898d27203e53fc38c8d289d9ae13910bfce8e` 只作为本批次实际 base，不用于回退或覆盖后来工作 |
| 工具与依赖 | Node `v26.7.0`、pnpm `10.29.1`、`pnpm-lock.yaml` SHA-256 `0229b4113c3d821db229ff4d885659cb518c6ace1d1a9ac245b1b994cd72ca1f` |

## 各层验收边界

| 层级 | 当前结论 | 不能据此声称 |
| --- | --- | --- |
| 已合并实现 | `main` 已包含 Next.js/Fastify/SQLite、Agent、生活管理及 Notion OAuth、结构、读取、写回、重复规则、暂停和恢复隔离实现 | 不等于用户正在运行该 SHA，也不等于部署完成 |
| COL-40 候选 | H01 已加入跨扫描/写回持久新鲜度保护，H02 已加入任务总表可见轮询与旧响应保护，H03 已加入无真实凭据 CI；H04/H05/H06 在 PR #21 继续收尾 | 合并前不是 `main`；hosted CI、独立审查、门禁和 main 验证须绑定最终 head |
| 本机工程验证 | 基线 `pnpm check`、`pnpm build`、Chrome/WebKit E2E 94/94 通过；H01/H02 定向红绿和回归通过。最终候选全套回归仍以验收报告更新为准 | fake/scripted、临时 SQLite 和本机浏览器结果不证明真实 Notion、真实模型或部署 |
| Hosted CI | 首个 run [35644683301](https://github.com/ZZZZihan/NewDay/actions/runs/35644683301) 与文档更新 run [35647517050](https://github.com/ZZZZihan/NewDay/actions/runs/35647517050) 均成功；后者在 merge checkout `e1b2708…` / tree `8c0011c…` 上通过 check 264/266/9/23、build 和 Chrome/WebKit 98/98。受控失败 run [35648673796](https://github.com/ZZZZihan/NewDay/actions/runs/35648673796) 因唯一哨兵断言失败而变红，PR 被门禁阻止 | 最终恢复 head 与 main push run 仍须在 H06 分别验证；受控失败不是产品缺陷，也不进入最终 tree |
| Notion 隔离工作区 | COL-39 的 2026-09-21 历史报告记录 A1～D1 的真实隔离 OAuth/读写/故障/恢复证据；[COL-39](https://linear.app/colife/issue/COL-39) 当前为 Done | 真实观察绑定历史执行及明确候选；未在 PR #21 重跑，也不证明个人正式工作区 |
| G3 真实模型质量 | [COL-23](https://linear.app/colife/issue/COL-23) 为 In Progress；已完成一个受控合成 H-N01 真实 pilot，人工评分仍 pending，完整 40×3 与人工评分未完成 | 单次 validated transport/output path 不是完整 G3 |
| G4 七天效果 | [COL-24](https://linear.app/colife/issue/COL-24) 为 In Progress；只有前瞻记录协议，人工基线和连续七天记录尚未开始 | 不能由历史任务状态、工程测试或 G3 pilot 倒推 G4 |
| 应用部署 | 当前实际运行版本与生产部署状态未在本批次核实；Worker build 仍是 dry run。历史隔离 OAuth Worker 不代表 NewDay 应用已部署 | 不能由 `main` SHA、构建通过或 Worker dry run 反推部署 |
| 个人正式工作区 | 本批次真实 Notion 调用为 0；未授权、读取或写入个人正式工作区 | 隔离工作区验收不授予个人数据访问权 |

## 当前后续任务

1. 在 PR #21 冻结最终 head，完成 S01–S12、U01–U08、C01–C07、D01–D06 的独立审查与最终绑定。
2. 等待移除受控失败哨兵后的候选重新绿灯；`main` 规则集已回读为 active、0 审批、固定 GitHub Actions 来源且无绕过者。
3. 正常合并 PR #21，验证实际 main push CI，并将 merge SHA/run 回填 PR、COL-40 与验收报告。合并前状态保持 `POST_MERGE_PENDING`。
4. H05 本批次只交付[恢复隔离处置设计](./notion-restore-resolution-design.md)，不开放旧操作重放或自动解除 `paused_after_restore`。
5. COL-23/COL-24 继续保持开放；它们不由 COL-40 的合并自动关闭。

## 证据入口

- [COL-40](https://linear.app/colife/issue/COL-40) 与 [PR #21](https://github.com/ZZZZihan/NewDay/pull/21)：实时执行与候选状态。
- [COL-40 验收报告](./reviews/sync-hardening-acceptance-2026-09-22.md)：命令、SHA/tree、S/U/C/D 矩阵与最终合并状态。
- [2026-09-21 Notion 历史报告](./notion-live-acceptance-2026-09-21.md)及[机器摘要](../evidence/notion-live/2026-09-21/summary.json)：历史真实隔离证据，不是当前部署状态。
- [项目管理流程](./project-management.md)：每项交付必须记录的最小信息和状态语义。
