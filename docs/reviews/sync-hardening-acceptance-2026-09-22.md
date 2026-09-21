---
batch: newday-sync-consistency-hardening
status: IN_PROGRESS
reviewed_base_sha: 853898d27203e53fc38c8d289d9ae13910bfce8e
actual_base_sha: 853898d27203e53fc38c8d289d9ae13910bfce8e
source_candidate_sha: a0955562ab8848ffdd3e0753690278334854052e
source_candidate_tree: 45d05d2949b77101a82fdf107457f04ee3890300
latest_verified_candidate_sha: a0955562ab8848ffdd3e0753690278334854052e
latest_verified_candidate_tree: 45d05d2949b77101a82fdf107457f04ee3890300
final_candidate_sha: null
final_candidate_tree: null
node_version: v26.7.0
pnpm_version: 10.29.1
lockfile_sha256: 0229b4113c3d821db229ff4d885659cb518c6ace1d1a9ac245b1b994cd72ca1f
pr_url: https://github.com/ZZZZihan/NewDay/pull/21
hosted_run_url: https://github.com/ZZZZihan/NewDay/actions/runs/35649607021
hosted_checkout_sha: 14af99f287dd9138db5d66f40d5fd136e3cb2a3f
hosted_checkout_tree: 9a26ae7c57cfb399401a78b144fc2c0fd0cd0f2c
hosted_event: pull_request
controlled_failure_sha: 7583b25bc2bd544b6abe3de1fddecd065a325716
controlled_failure_run_url: https://github.com/ZZZZihan/NewDay/actions/runs/35648673796
independent_review: APPROVED_ON_A095556_FINAL_HEAD_PENDING
admin_gate: ACTIVE_RULESET_VERIFIED
standing_authorization: NEWDAY_AUTONOMOUS_V2
execution_state: FINAL_CANDIDATE_PREPARATION
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

## H00–H06 交付六要素摘要

| 任务 | 目标与范围 | 实际实现 | 验收结果 | 证据位置 | 剩余风险 | 回退方法 |
| --- | --- | --- | --- | --- | --- | --- |
| H00 | 固定真实 base、权限、工具、旧改动归属和隔离测试基线 | 从 `853898d…` 建立独立 worktree，冻结安装并记录版本/lock/tree；未写用户原脏工作树 | 基线 check/build/Chrome+WebKit 94/94；外部业务调用 0 | 本报告 H00；evidence bundle 的 `baseline-*` | 只证明记录时本机环境，不代表部署 | 无运行时代码可回退；删除隔离 worktree/证据副本前先保留 Git 与报告，绝不 reset 用户工作树 |
| H01 | 防止已 confirmed 写回之后返回的旧 Tasks 响应覆盖本地有效状态 | `1de33e8…` 加入持久任务新鲜度采样/落库校验及 S01–S12 回归 | 红测 `Missing expected rejection`；修复后 S01–S12 与全套 check 通过 | 本报告 H01；`h01-confirmed-race-{red,green}.log` | 合成 gateway/SQLite 证明工程语义，不是个人 Notion 延迟验收 | 发现回归时通过新 PR 正常 revert H01 提交并恢复旧行为；不得重写 main，且 unknown/outbox 栅栏不能被绕过 |
| H02 | 前台任务总表有界刷新，并保护任务、重复系列、资料的未保存草稿 | `d83c7b8…` 加轮询/旧响应保护；`2dc407d…`、`72e7f15…`、`a095556…` 逐轮补齐 opening snapshot、目标绑定与完整 series tail revision | U01–U08 自动化通过；第三轮发现均有红测，`a095556…` 本机 check/build/E2E 102/102，第四轮独立复核 `APPROVED` | 本报告 H02/审查循环；`h02-*` 与 `independent-review/round{2,3}` | 轮询目标是后端→UI，不证明真实 Notion→后端→UI；极端大系列仍需运行观测 | 用正常 revert PR 按依赖逆序撤销 H02 提交；若只回退 revision 契约，前后端必须同一发布单元，不能让旧 API 静默接受覆盖 |
| H03 | 无真实凭据 CI、受控红灯及 main 生效门禁 | `471279d…` 加最小权限 workflow；建立 ruleset `23787864`，required check 固定为 Actions `newday-quality-gate`，无 bypass | hosted 绿灯与受控失败均已证明；最终 head hosted run 与 main push run 待 H06 | 本报告 C01–C07；GitHub runs `35649607021`、`35648673796` | 当前旧 hosted 绿灯不替代最终 head；GitHub 服务故障仍可能形成依赖等待 | workflow 用审查 PR 正常 revert；规则变更只按已保存配置恢复或替换为等价门禁，不为合并临时关闭 required check |
| H04 | README 一跳到准确状态页，拆分合并/部署/G3/G4 与历史证据 | 更新 `README.md`、`docs/project-state.md`、本报告和人工维护的项目流程 | D01–D06 中 D05 待最终 SHA/run/merge 回填，其余当前通过 | 本报告 H04 与 `docs/project-state.md` | dated snapshot 会漂移，必须结合 GitHub/Linear 实时源 | 文档错误用后续文档提交或 revert PR 修正；不得用旧快照覆盖真实新状态 |
| H05 | 仅冻结 `paused_after_restore` 后续恢复设计，不开放解锁或重放 | `cb2a726…` 交付状态机、API 草案、风险、回退边界与 RR01–RR20 下一阶段矩阵 | 设计范围完成；运行时代码/schema/备份格式均未改变 | `docs/notion-restore-resolution-design.md` | 所有真实解除隔离仍未实现，属于后续独立事项 | 设计文档可正常 revert；当前 fail-closed 行为保持，任何未来实现回退都不能冒充撤销已到达远端的请求 |
| H06 | 独立审查→修复→最终门禁→正常合并→main 验证→状态同步闭环 | 三轮 findings 已修复，第四轮对 `a095556…` 独立复核 `APPROVED`；最终文档/hosted/merge 收尾中 | 最终 head 本机/hosted 全绿、规则回读、正常 merge 与 main push CI 后才为 `BATCH_COMPLETE` | 本报告最终回填区、PR #21、COL-40 | 合并与 main run 尚未发生；COL-23/COL-24、真实 Notion/G3/G4/部署均明确范围外 | 合并前停止并保留 Draft；合并后若发现本批次回归，走受保护 main 的正常 revert/fix PR 和同等门禁，不强推、不删除测试 |

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
| S03 | 既有 pending 用例，加上 sending/unknown fence 定向子测试；无重放、水位不推进 | PASS |
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

轮询修复前后证据为 `h02-polling-red.log`（旧 hook 4 项中 3 项失败）与 `h02-polling-green.log`（4/4 通过）。首次独立审查随后发现：只保留本地表单状态仍允许旧草稿保存覆盖服务器新版本。补充的真实保存场景在修复前稳定 2/2 失败，日志为 `independent-review/u06-stale-save-red.log`；提交 `2dc407d…` 先加入任务/资料完整快照比较。第二轮独立复核又实际证明任务基线仍可省略或错绑，且重复任务的 live series 会重挂载/卸载编辑器；提交 `72e7f15…` 改为服务器强制、目标绑定的 task/series CAS，并保留打开时的双快照。第三轮复核继续证明只比较 source segment 仍会让旧编辑器删除服务器新 successor，并指出不存在系列与同批 create→update 被错误提前拦成 409。提交 `a095556…` 新增服务器生成的 tail revision，覆盖实际写集合中的 source、successors、occurrence tasks、focus 与资料关联，并在同一事务比较；无 opening 基线且目标不存在时仍进入 core 域语义。30 秒轮询仍只在前台运行，重新可见/聚焦时立即刷新，generation + abort 双重拒绝旧响应，错误时保留数据。

| ID | 自动化/断言 | 当前结果 |
| --- | --- | --- |
| U01 | Hook fake clock 与双浏览器 `the open task table reflects backend changes...` 把同一任务改到不同日期并断言新日期，同时覆盖标题、完成状态；无手动 reload/scan | PASS |
| U02 | Hook 从首屏既有未归档任务切换为同 ID 已归档任务，同时加入第二个新任务，并断言 ID 集合无重复；沿用现有归档显示规则 | PASS |
| U03 | `stops polling while hidden and revalidates once visibility or focus returns`；timer/listener 清理 | PASS |
| U04 | Hook 使用忽略 abort 的慢 Promise；E2E `an older workspace read cannot hide a newly saved resource` | PASS |
| U05 | `retains loaded data on failure and clears the error after the next successful poll` | PASS |
| U06 | API 定向测试验证任务编辑的缺失、错绑、多目标、stale/fresh 基线；系列编辑覆盖缺失、错绑、source 被替换、source 不变但 successor 改变、目标不存在及同批新建后编辑。旧写返回 409 且 winner series/tasks 不变；Chrome/WebKit 验证三类编辑器草稿保留 | PASS |
| U07 | 既有 restore、undo、manual refresh 跨视图 E2E 保持通过 | PASS |
| U08 | `life-management.spec.ts` Chrome/WebKit 22/22；其中 U01、U04、任务、重复系列与资料 U06 均有双浏览器代表旅程 | PASS |

第三轮审查修复提交 `a095556…` 上，`pnpm check` exit 0（Vitest 265、API 271、Worker 9、Agent integration 23），`pnpm build` exit 0，Chrome/WebKit 全套 102/102。这是后端已提交数据到 UI 的新鲜度和并发保存保护证据，不是个人 Notion 工作区端到端延迟验收；第四轮独立复核已通过，最终报告 head 的全套重跑仍待完成。

### 独立审查循环与处置

同一独立审查者在 `8e92fb4…` 上给出首次 `CHANGES_REQUESTED`：P1 为 U06 旧草稿可静默覆盖服务器新版本；P2 为 U01/U02 的报告超出实际断言；P3 为 S03 多写了合同未要求、也未定向执行的 `quarantined`。提交 `2dc407d…` 加入第一版任务/资料保护，U01/U02 自动化改为真实日期变化和既有任务归档转变，本报告删除 S03 多余声称。

该审查者在 `bf4ff25…` 的第二轮复核仍给出 `CHANGES_REQUESTED`：任务 CAS 可省略或用任务 A 的快照修改任务 B；系列保存错误地依赖 occurrence task；live series 刷新会让重复编辑器重挂载或卸载。提交 `72e7f15…` 针对这些可执行反例加入服务端强制目标绑定、完整 source 快照与稳定编辑器快照，并保存红/绿成对证据。

该审查者在 `72e7f15…` 的第三轮复核再次给出 `CHANGES_REQUESTED`：source 未变、successor 已变化时，旧 source 编辑器仍会删除服务器胜出 successor；同时无条件要求系列基线破坏了不存在目标 400 与同批 create→update。红测分别记录 `200 != 409`、`409 != 400`，以及 source 已替换时双浏览器收到错误 400。提交 `a095556…` 以完整尾部写集合 revision 和“是否实际携带 opening 基线”的分支修复这些边界。

第四轮独立复核对不可变代码提交 `a0955562ab8848ffdd3e0753690278334854052e` / tree `45d05d2949b77101a82fdf107457f04ee3890300` 给出 `APPROVED`，无 P0～P3 未解决 finding。审查者独立运行 API 15/15、Hook 5/5、Chrome/WebKit 重复草稿 2/2、successor/focus/resource-link revision 行为探针，以及从历史基线到候选的 `git diff --check`；同时明确其批准只绑定代码提交，不把三份随后更新的文档冒充为已独立复核代码。最终文档 head 因此仍须重新执行完整本机和 hosted 门禁，但无需把文档 SHA 冒充为另一轮代码审查结论。

## H03：C01–C07

| ID | 证据 | 当前结果 |
| --- | --- | --- |
| C01 | hosted run `35649607021` 在全新 `ubuntu-24.04` 成功；Node 24.20.0、pnpm 10.29.1、lock SHA-256 与记录一致；check 264/266/9/23、build、Chrome/WebKit 98/98 全部通过 | PASS_WITH_FINAL_HEAD_RECHECK_PENDING |
| C02 | `471279d…`、`cb2a726…`、`8e92fb4…` 及后续每个已推送 PR head 都触发新 run；`51c4d63…` 的无效哨兵 run `35648608779` 被新 head 按 concurrency 取消；`a095556…` 的三轮审查修复和最终报告 head 尚待推送验证 | PASS_WITH_FINAL_RECHECK_PENDING |
| C03 | 受控候选 `7583b25…` / run `35648673796` 的 `Check` 因 `tests/unit/controlled-ci-gate-failure.test.ts` 唯一断言而失败（264 pass + 1 fail），build/E2E 被跳过，PR `mergeStateStatus=BLOCKED`；`fb696dc…` 已删除哨兵，后续 `8e92fb4…` / run `35649607021` 全绿 | RED_PROVED_RECOVERED |
| C04 | run `35649607021` 事件为 `pull_request`，PR head `8e92fb4…`、base `853898d…`；GitHub 实际 checkout 为合并提交 `14af99f287dd9138db5d66f40d5fd136e3cb2a3f`，tree `9a26ae7…` 与 PR head tree 一致 | PASS |
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

H05 设计见 `docs/notion-restore-resolution-design.md`；本批次不新增解除隔离、删除隔离审计或重放旧写入的入口。受控故障与规则回读已完成，三轮独立审查实质缺陷均有代码和红/绿回归处置，第四轮已 `APPROVED`；最终 head 全套本机/hosted 绿灯、正常合并和 main push CI 仍为 `PENDING`，因此当前不能标记 `BATCH_COMPLETE`。

## 本机完整回归与证据索引

候选 `8e92fb4854754d901b81960747e1d8c361832dd4` / tree `9a26ae7c57cfb399401a78b144fc2c0fd0cd0f2c` 在干净 worktree 运行完整门禁，hosted run `35649607021` 也成功。第三轮独立审查修复 `a095556…` / tree `45d05d2…` 已通过全量 `pnpm check`、`pnpm build` 和 Chrome/WebKit 102/102；最终文档提交后仍将把完整命令日志绑定到最终候选。日志保存在仓库外的受控 evidence bundle：

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `pnpm check` | `8e92fb4…` exit 0：264/266/9/23；`a095556…` exit 0：265/271/9/23 | `final-candidate-8e92fb4/pnpm-check.log`、`independent-review/round3/pnpm-check-precommit.log` |
| `pnpm build` | `8e92fb4…` 与 `a095556…` 均 exit 0；API、Next.js、Worker dry run | `final-candidate-8e92fb4/pnpm-build.log`、`independent-review/round3/pnpm-build-precommit.log` |
| `pnpm test:e2e --project=chrome --project=safari-webkit` | `8e92fb4…` exit 0：98/98；`a095556…` exit 0：102/102 | `final-candidate-8e92fb4/pnpm-e2e-chrome-webkit.log`、`independent-review/round3/pnpm-e2e-full-precommit.log` |
| 审查第二轮定向红/绿 | 旧实现 API 2 项 `200 != 409`、重复编辑器消失；`72e7f15…` API 13/13、重复 Chrome 1/1 | `independent-review/round2/task-series-target-binding-{red,green}.log`、`recurring-draft-{red,green}.log` |
| 审查第三轮定向红/绿 | 旧实现 successor 竞态 `200 != 409`、不存在目标 `409 != 400`、source 替换后 Chrome/WebKit 2/2 错收 400；`a095556…` API 15/15、重复草稿双浏览器 2/2 | `independent-review/round3/series-tail-revision-red.log`、`series-domain-semantics-red.log`、`replaced-source-conflict-red.log`、`recurring-draft-tail-revision-green.log`、`series-all-green.log` |
| `git diff --check` / `git diff --cached --check` | `8e92fb4…` exit 0 / 0；最终 head 仍需重跑 | `final-candidate-8e92fb4/git-diff-check.log`、`git-diff-cached-check.log` |
| hosted `35649607021` | success；实际 checkout `14af99f…`、tree `9a26ae7…`，98/98 | `hosted/run-35649607021.log` |
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
| 最终 candidate SHA/tree | PENDING；当前代码修复提交 `a095556…` / `45d05d2…` 已通过 check/build/Chrome+WebKit，最终文档 head 尚未生成 |
| `pnpm check` | `a095556…` exit 0；Vitest 265、API 271、Worker 9、Agent integration 23；最终报告 head 仍需重跑 |
| `pnpm build` | `a095556…` exit 0；最终报告 head 仍需重跑 |
| Chrome/WebKit full E2E | `a095556…` 102/102；最终报告 head 仍需全套重跑 |
| `git diff --check` / `git diff --cached --check` | `a095556…` 提交前均 exit 0；最终 head 仍需重跑 |
| 独立审查 | 首次、第二轮、第三轮均 `CHANGES_REQUESTED`；第四轮对 `a095556…` / `45d05d2…` 为 `APPROVED`，无 P0～P3 未解决 finding |
| final PR hosted run | PENDING |
| main protection readback | PASS；ruleset `23787864` active，branch `protected: true` |
| merge SHA | POST_MERGE_PENDING |
| main push run | POST_MERGE_PENDING |
| execution / acceptance / native Goal | 执行中 / 未完成 / active |
