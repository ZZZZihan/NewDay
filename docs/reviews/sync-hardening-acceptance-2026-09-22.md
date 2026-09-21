---
batch: newday-sync-consistency-hardening
status: IN_PROGRESS
reviewed_base_sha: 853898d27203e53fc38c8d289d9ae13910bfce8e
actual_base_sha: 853898d27203e53fc38c8d289d9ae13910bfce8e
source_candidate_sha: 471279d93634f77996e9060e9f87472334c1de05
source_candidate_tree: a0dc094e94dbb7c76b95584b8978ff5171a9d5bf
latest_verified_candidate_sha: cb2a72633ff73f84cbdea0985455a77358d92aec
latest_verified_candidate_tree: 8c0011ca84cd3ffeb73ca5a257a44d141f703e76
final_candidate_sha: null
final_candidate_tree: null
node_version: v26.7.0
pnpm_version: 10.29.1
lockfile_sha256: 0229b4113c3d821db229ff4d885659cb518c6ace1d1a9ac245b1b994cd72ca1f
pr_url: https://github.com/ZZZZihan/NewDay/pull/21
hosted_run_url: https://github.com/ZZZZihan/NewDay/actions/runs/35647517050
hosted_checkout_sha: e1b27085f48066aa9a1c0b34e00e3f1ca1db2eb0
hosted_checkout_tree: 8c0011ca84cd3ffeb73ca5a257a44d141f703e76
hosted_event: pull_request
controlled_failure_sha: 7583b25bc2bd544b6abe3de1fddecd065a325716
controlled_failure_run_url: https://github.com/ZZZZihan/NewDay/actions/runs/35648673796
independent_review: REVIEW_PENDING
admin_gate: ACTIVE_RULESET_VERIFIED
standing_authorization: NEWDAY_AUTONOMOUS_V2
execution_state: FINAL_VERIFICATION
native_goal_status: active
state_sync: NATIVE_GOAL_ACTIVE
merged_sha: null
main_hosted_run_url: null
main_push_validation: POST_MERGE_PENDING
real_notion_calls: 0
real_model_generation_calls: 0
g3_acceptance: OUT_OF_SCOPE_STILL_OPEN
g4_acceptance: OUT_OF_SCOPE_STILL_OPEN
---

# COL-40 同步一致性与交付可信度验收

本报告绑定 H00–H06。本页首次写入时实现候选为 `471279d…`；报告和设计文档的后续提交只改变文档，最终 PR head、tree、hosted checkout、独立复核、门禁、merge SHA 与 main run 必须在 H06 再回填。提交不能在自身内容里可靠引用自己的 SHA，因此最终精确绑定同时记录在 PR #21 和 COL-40。

原始测试日志保存在仓库外的受控 `col-40-sync-hardening` evidence bundle；仓库仅保存去敏结论、日志文件名和可复现命令，不提交 `.env`、凭据、运行数据库、真实任务正文或机器身份信息。本批次测试使用 fake/scripted provider、端口 `3100/3002` 和一次性 SQLite；真实 Notion/模型调用均为 0。

## H00 基线

| 项目 | 结果 |
| --- | --- |
| base | `853898d27203e53fc38c8d289d9ae13910bfce8e`，tree `c69c0c6684657ba9eef9f84d34ce0bc6044d2240` |
| 隔离 | 托管 worktree；用户原始脏工作树未 reset、clean、stash 或写入 |
| 冻结安装 | `pnpm install --frozen-lockfile`，exit 0 |
| baseline check | `pnpm check`，exit 0；Vitest 260、API 256、Worker 9、Agent integration 23 |
| baseline build | `pnpm build`，exit 0；API、Next.js、Worker dry run |
| baseline E2E | `pnpm test:e2e --project=chrome --project=safari-webkit`，exit 0；94/94 |
| 外部业务调用 | 真实 Notion 0、真实模型生成 0、部署 0 |
| 任务映射 | [COL-40](https://linear.app/colife/issue/COL-40)；关联 COL-28/COL-36/COL-37/COL-39/COL-23/COL-24 |

## H01：S01–S12

修复前后成对证据为 `h01-confirmed-race-red.log` 与 `h01-confirmed-race-green.log`。原基线在生产 `PlannerService` + `NotionOutboxDispatcher` 真正确认后允许旧 Tasks 快照落库，新用例稳定失败为 `Missing expected rejection`；修复后同一调度通过。实现提交 `1de33e8` 未改变 SQLite schema、业务备份版本或远端协议，也未在网络 I/O 期间持有写事务。

| ID | 自动化/断言 | 当前结果 |
| --- | --- | --- |
| S01 | `a cloned stale task scan cannot overwrite a local edit after the real dispatcher confirms it`：深拷贝旧 rows 后挂起，真实 dispatcher confirmed，旧响应拒绝且水位不前进 | PASS |
| S02 | 同一测试覆盖标题、完成、重开、改期，并比较写回后任务、focus、mapping baseline 与事件 | PASS |
| S03 | 既有 pending 用例，加上 sending/unknown/quarantined fence 定向子测试；无重放、水位不推进 | PASS |
| S04 | `separate SQLite readers persistently reject an older task response that finishes last`，两个 service/连接交错 | PASS |
| S05 | `dataset epoch rotation rejects an in-flight task response...` 与既有凭据替换中断测试 | PASS |
| S06 | 完整扫描与完全相同重复扫描；无重复任务/事件且成功水位可推进 | PASS |
| S07 | areas/projects/rules 本轮先提交后 Tasks 正常落库，不被自己的前置更新误判 | PASS |
| S08 | incomplete/permission/unknown missing/explicit trash 既有和扩展测试 | PASS |
| S09 | 旧扫描拒绝后新扫描成功，未永久暂停或死锁 | PASS |
| S10 | `a confirmed A-to-B-to-A edit still invalidates a value-identical stale task response` | PASS |
| S11 | S04 使用两条真实 SQLite 连接，证明不是对象内 tail 锁 | PASS |
| S12 | `a valid task sync invalidates an older Agent proposal before it can be applied` 返回版本冲突且 focus 不变 | PASS |

定向边界命令及全量 `pnpm check` 均 exit 0；H01 后 check 为 Vitest 260、API 266、Worker 9、Agent integration 23。最终候选仍须重跑完整门禁。

## H02：U01–U08

修复前后证据为 `h02-polling-red.log`（旧 hook 4 项中 3 项失败）与 `h02-polling-green.log`（4/4 通过）。实现提交 `d83c7b8`；30 秒仅前台轮询，重新可见/聚焦时立即刷新，generation + abort 双重拒绝旧响应，错误时保留数据。表单与筛选仍由 `LifePanel` 本地状态持有。

| ID | 自动化/断言 | 当前结果 |
| --- | --- | --- |
| U01 | Hook fake clock 与双浏览器 `the open task table reflects backend changes...` 覆盖后端标题、状态和日期变化，无手动 reload/scan | PASS |
| U02 | 同一 Hook/E2E 调度覆盖后端新增和归档，沿用现有归档显示规则且无复制 | PASS |
| U03 | `stops polling while hidden and revalidates once visibility or focus returns`；timer/listener 清理 | PASS |
| U04 | Hook 使用忽略 abort 的慢 Promise；E2E `an older workspace read cannot hide a newly saved resource` | PASS |
| U05 | `retains loaded data on failure and clears the error after the next successful poll` | PASS |
| U06 | 双浏览器 `background refresh preserves task filters and an unsaved editor draft` | PASS |
| U07 | 既有 restore、undo、manual refresh 跨视图 E2E 保持通过 | PASS |
| U08 | `life-management.spec.ts` Chrome/WebKit 18/18 | PASS |

H02 后 `pnpm check` exit 0（Vitest 264、API 266、Worker 9、Agent integration 23）。这是后端已提交数据到 UI 的新鲜度证据，不是个人 Notion 工作区端到端延迟验收。

## H03：C01–C07

| ID | 证据 | 当前结果 |
| --- | --- | --- |
| C01 | hosted run `35647517050` 在全新 `ubuntu-24.04` 成功；Node 24.20.0、pnpm 10.29.1、lock SHA-256 与记录一致；check 264/266/9/23、build、Chrome/WebKit 98/98 全部通过 | PASS |
| C02 | `471279d…`、`cb2a726…` 及后续每个 PR head 都触发新 run；`51c4d63…` 的无效哨兵 run `35648608779` 被新 head 按 concurrency 取消；最终报告 head 尚待验证 | PASS_WITH_FINAL_RECHECK_PENDING |
| C03 | 受控候选 `7583b25…` / run `35648673796` 的 `Check` 因 `tests/unit/controlled-ci-gate-failure.test.ts` 唯一断言而失败（264 pass + 1 fail），build/E2E 被跳过，PR `mergeStateStatus=BLOCKED`；`fb696dc…` 已删除哨兵并恢复到 `cb2a726…` 的相同 tree，恢复 run `35649161772` 运行中 | RED_PROVED_RECOVERY_RUNNING |
| C04 | run `35647517050` 事件为 `pull_request`，PR head `cb2a726…`、base `853898d…`；GitHub 实际 checkout 为合并提交 `e1b27085f48066aa9a1c0b34e00e3f1ca1db2eb0`，tree `8c0011c…` 与 PR head tree 一致 | PASS |
| C05 | workflow 权限 `contents: read`，无 secrets，Worker dry run，E2E 3100/3002 + disposable SQLite | PASS_BY_INSPECTION |
| C06 | 初始规则回读为 main 未保护、rulesets `[]`；现已建立只匹配 `refs/heads/main` 的 active ruleset `23787864`：禁止删除/非快进，必须经 PR，审批数 0，无额外归属审批 | PASS |
| C07 | ruleset 回读确认 required check 为 `newday-quality-gate`、GitHub Actions integration `15368`、strict 最新基线、无 bypass actor；branch API 返回 `protected: true`，红灯 run 时 PR 实际为 BLOCKED | PASS |

## H04/H05/H06 与 D01–D06

| ID | 当前证据 | 当前结果 |
| --- | --- | --- |
| D01 | README 一跳进入 `docs/project-state.md`，含日期、main/candidate、边界和后续任务 | PASS |
| D02 | 同次 GitHub/Linear 核对：main `853898d…`、PR #21 Draft、COL-39 Done、COL-23/24/40 In Progress；历史文档加历史标识 | PASS |
| D03 | README 不再声称 API/SQLite/Notion 未合入；状态表拆分合并/部署/G3/G4 | PASS |
| D04 | 主线、实现候选、历史真实验收均绑定固定 SHA/tree；实时入口单列 | PASS |
| D05 | PR/Linear/报告最终 candidate 与结论需在 H06 绑定 | PENDING |
| D06 | 文档不含令牌、密钥、完整远端 ID、个人任务正文、私有证据路径或机器标识 | PASS_BY_REVIEW |

H05 设计见 `docs/notion-restore-resolution-design.md`；本批次不新增解除隔离、删除隔离审计或重放旧写入的入口。受控故障与规则回读已完成；H06 的独立审查、最终 head hosted 绿灯、正常合并和 main push CI 仍为 `PENDING`，因此当前不能标记 `BATCH_COMPLETE`。

## 本机完整回归与证据索引

候选 `cb2a72633ff73f84cbdea0985455a77358d92aec` / tree `8c0011ca84cd3ffeb73ca5a257a44d141f703e76` 在干净 worktree 运行完整门禁；随后 `fb696dc…` 只移除受控失败哨兵，tree 精确恢复为同一值。日志保存在仓库外的受控 evidence bundle：

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm check` | exit 0；Vitest 264、API 266、Worker 9、Agent integration 23 | `final-candidate-cb2a726/pnpm-check.log` |
| `pnpm build` | exit 0；API、Next.js、Worker dry run | `final-candidate-cb2a726/pnpm-build.log` |
| `pnpm test:e2e --project=chrome --project=safari-webkit` | exit 0；98/98 | `final-candidate-cb2a726/pnpm-e2e-chrome-webkit.log` |
| `git diff --check` / `git diff --cached --check` | exit 0 / exit 0 | `final-candidate-cb2a726/git-diff-check.log`、`git-diff-cached-check.log` |
| hosted `35647517050` | success；实际 checkout `e1b2708…`，98/98 | `hosted/run-35647517050.log` |
| hosted `35648673796` | expected failure；唯一哨兵断言失败，门禁阻止合并 | `hosted/run-35648673796-controlled-failure.log` |

## 附录 C：A01–A06

| ID | 当前证据 | 当前结果 |
| --- | --- | --- |
| A01 | Codex Goal 原生状态实际读取为 `active`；本机权限为 unrestricted / approval disabled；Node、pnpm、lock 摘要均实测，不把提示词当配置 | PASS |
| A02 | GitHub `admin: true` 且 push/PR/ruleset API 已实际成功；Linear COL-40 已创建并为 In Progress | PASS |
| A03 | C03 首个哨兵位置未进入 Vitest include，预检明确报 `No test files found`；迁入 `tests/unit` 后本机与 hosted 均真正执行断言并失败，随后恢复同 tree | PASS |
| A04 | 首次哨兵运行无效、一次 GitHub readback EOF 均作为局部环境/测试问题处理；源码、文档、门禁和回归继续推进 | PASS |
| A05 | PR 最终 head、正常 merge SHA 与 main push run 尚待完成 | PENDING |
| A06 | 未伪造 Goal resume/complete，未改内部数据库；当前原生 Goal 仍 active，执行可继续 | PASS |

## 最终回填区

| 项目 | 结果 |
| --- | --- |
| 最终 candidate SHA/tree | PENDING；最近完整本机/hosted 绿灯为 `cb2a726…` / `8c0011c…`，恢复提交 `fb696dc…` 为同 tree |
| `pnpm check` | `cb2a726…` exit 0；最终报告 head 仍需重跑 |
| `pnpm build` | `cb2a726…` exit 0；最终报告 head 仍需重跑 |
| Chrome/WebKit full E2E | `cb2a726…` 98/98；最终报告 head 仍需重跑 |
| `git diff --check` / `git diff --cached --check` | `cb2a726…` exit 0 / 0；最终 head 仍需重跑 |
| 独立审查 | REVIEW_PENDING |
| final PR hosted run | PENDING |
| main protection readback | PASS；ruleset `23787864` active，branch `protected: true` |
| merge SHA | POST_MERGE_PENDING |
| main push run | POST_MERGE_PENDING |
| execution / acceptance / native Goal | 执行中 / 未完成 / active |
