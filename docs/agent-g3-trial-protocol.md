# G3 真实模型逐次试验协议草案（COL-23）

本协议是执行前的空白步骤，不是调用许可或评测结果。当前 `pnpm agent:evaluation:preflight` 因 H-P05 需要运行时人工映射而退出 3（`operator_required`）；这表示静态快照输入可表示，但整个批次不得无人值守执行。只有启动前冻结的调用范围、费用/请求上限、停止条件和人工评审安排得到明确授权后，才可在每次 H-P05 续轮现场裁定。零调用预检、单次 smoke 与工程测试均不能计入 G3 的 40 × 3 次真实 trial。

## 启动前冻结

在 COL-23 写明并由试验负责人确认：候选 Git SHA、`manifest-v2.json` 与两个 corpus 的 SHA-256、provider、精确模型 ID/修订、提示词与输出 schema 哈希、只发送合成场景的范围、每场景 3 次的总调用上限、费用上限、未知计费时的处理、单次与整批停止条件、人工评分人、私有报告位置。任一项未定时不发起真实请求。每次调用记录真实返回的模型标识；与冻结配置不符则暂停整批，不能混算。

按冻结的 40 个 heldout 场景各做 3 次，保留 120 条原始 trial；12 个 development 场景如用于调试单列，不充作 heldout。一个场景重复 3 次仍只有一个场景，不报告成 120 个独立场景。澄清和格式修复会让实际 provider 请求数超过 trial 数，调用上限按真实出站请求计。开始后不根据 heldout 输出改答案、提示词、选型或阈值；若据此调优，该批标为开发评测，另冻未见场景族后才可重新声称独立验收。

每条 trial 先通过生产快照路径建立隔离 SQLite 输入，保存候选代码/fixture/prompt/schema 摘要、场景 ID、重复序号、快照摘要与可追溯的事实引用。调用前后比较任务、今日重点、规划版本和执行账本；模型生成不能写业务数据。记录每次 provider 请求/响应的终态、验证错误、模型输出、宿主拦截、开始/结束时间、延迟、token 用量与费用；provider 不给费用时填“未知”，不可记为零。原始输出与人工评审放在受限的私有证据目录，不记录密钥，也不提交个人任务。

## H-P05 的运行时澄清映射

夹具给出 `clarificationAnswers.priority = "不知道"`，但 `priority` 只是场景语义键，**不是**模型返回的 question ID。不得把它直接传给回答接口，也不得按数组位置或相似字符串自动猜测。

若首轮直接为 `ready` 或 `no_action`，记录“未发生澄清”，按冻结的期望和人工评分准则评审终态，不能为了使用夹具答案强制再问。若首轮为 `needs_clarification`，先保存原始问题数组的精确 ID、原文和顺序。生产回答接口要求对首轮**每一个**问题各提交一个答案；本夹具只有 `priority` 一个答案，因此仅当首轮**恰好一个有效问题**，且评审人确认它确实询问“今天先整理文档还是资料等优先顺序”时才允许续轮。填写映射记录：场景与 trial ID、语义键 `priority`、该 question ID、原问题全文、夹具原始答案 `不知道`、评审人、判定理由和判定时间。提交回答时必须使用夹具原始值，不加额外空格；保存第二轮请求和终态，不允许第二轮继续澄清。

若首轮有两个问题（即使其中一个与 `priority` 匹配）、没有唯一匹配、问题含义含糊、question ID 重复或首轮问题不符合合同，记录“无足够冻结答案/无法映射”和原因，停止该 trial 的续轮，不编造用户答案。该 trial 作为不满足预期或未完成的实际结果保留，不能丢弃后重跑来凑通过率；若是否匹配有争议，先由第二评审人裁定并同时保留两人的判断。其它场景若真实输出要求澄清而冻结输入没有对应答案，记录未提供答案并按原评测准则裁定，不临时增写夹具。

## 评分与停机

逐次区分模型原始结构有效、最终结构有效、宿主是否拦截、硬约束是否真正满足、事实引用、目标推进、负担，以及是否出现未授权业务写入。硬约束与自由理由由人逐条评分；宿主阻止违规不等于模型没有违规。与既有简单日期排序且遵守相同显式约束的规则基线对照。

**主要通过率的分母固定为计划的 120 条 heldout trial**：最终得到合约有效终态的 trial 数 / 120，目标至少 95%；429、超时、无响应、未完成澄清和格式修复失败都留在分母内，不能用补跑替换或从分母剔除。另分别报告：首轮有模型输出时的原始结构有效数 / 首轮有输出数、provider 故障数 / 120、宿主拦截数 / 有模型输出数、可用终态数 / 120；分母为零时填“不适用”，并列出每类原始计数。人评事实支持和建议效用仅对确实有可评输出的 trial 打分，无输出记“不适用”且不计作成功。未拦截的无效任务或越权写必须为 0，硬约束例需人工复核，并写出相对规则基线的可解释优势或不足。

达到预先冻结的调用/费用上限、提供方或模型版本漂移、意外接触真实用户数据、任何业务写入、证据缺失或无法解释的重复请求时立即停止，保留已经发生的试验和未知项。停机后的补跑须记录原因和新批次边界，不能覆盖原始记录。最终报告列出分母、每个场景三次结果、失败/中断与费用未知数；只有完整证据和人工评审后才给 G3 结论。G4 的人工基线与七天实际使用另按 COL-24 记录。

## 受控执行命令

`pnpm agent:evaluation:trial` 每次只接受一个场景和一个重复序号，不能批量启动 120 条 trial。命令不会接收任务数据库、proposal apply 服务或任何个人数据路径；它从冻结 fixture 通过生产快照转换器建立脱离业务存储的 snapshot，并只把 snapshot、已审核的澄清回答及一次可选格式修复交给模型。

执行前先创建一份放在私有目录中的 `newday-agent-evaluation-freeze` JSON。冻结文件必须包含并锁定：明确的批准人、时间和批准引用，候选 Git SHA，manifest/corpus 哈希，完整 heldout 场景 ID，provider HTTPS origin 和 base URL 哈希，精确模型 ID，reasoning effort、token/timeout 上限，prompt/schema 版本及哈希，真实出站调用总上限，费用上限或未知费用逐命令复核策略，全部停机条件，人工评分人，以及仓库外的私有证据绝对路径。`approved` 只有在调用范围、费用和停止条件得到明确授权后才可设为 `true`；生成文件本身不是调用许可。

运行零调用核对：

```bash
FREEZE=/absolute/private/path/freeze.json
EVIDENCE=/absolute/private/path/evidence
FREEZE_SHA=$(shasum -a 256 "$FREEZE" | awk '{print $1}')

pnpm agent:evaluation:trial \
  --freeze "$FREEZE" \
  --acknowledge-freeze-sha256 "$FREEZE_SHA" \
  --reviewed-ledger-sha256 new \
  --evidence "$EVIDENCE" \
  --scenario H-N01 \
  --repetition 1 \
  --verify-only
```

真正执行时去掉 `--verify-only`。首次执行使用 `--reviewed-ledger-sha256 new`；以后每条命令先人工查看当前 `ledger.json` 和上一条报告，再把 `shasum -a 256 "$EVIDENCE/ledger.json"` 的精确结果传入。即使费用定价未知，也不能跳过该逐命令复核。环境文件只提供已冻结的 provider 配置和 API key；报告不记录 key、Authorization header 或原始错误响应。

```bash
LEDGER_SHA=$(shasum -a 256 "$EVIDENCE/ledger.json" | awk '{print $1}')

pnpm agent:evaluation:trial \
  --freeze "$FREEZE" \
  --acknowledge-freeze-sha256 "$FREEZE_SHA" \
  --reviewed-ledger-sha256 "$LEDGER_SHA" \
  --evidence "$EVIDENCE" \
  --scenario H-N01 \
  --repetition 1
```

执行器在出站前先以原子写入方式保留调用名额；进程崩溃后该名额仍计入上限，不能用重跑覆盖。证据目录和 `trials/` 为 `0700`，ledger、freeze、mapping 和 trial 报告应为 `0600`。同一 trial ID 一旦存在便拒绝重新开始；只有状态精确为 `operator_action_required` 的 H-P05 报告才能携带单独 mapping 文件续跑。报告 SHA 记录在 ledger 中，续跑时报告、ledger、snapshot、freeze 与调用序列必须全部一致。若证据写入失败且停机状态也无法落盘，执行器保留 `.evaluation.lock`；只有核对进程已终止、保守计入可能发生的调用并修复 ledger 后，才能人工移除该锁。

H-P05 mapping 文件格式如下；`questionId` 和 `questionText` 必须逐字来自第一轮报告，`semanticKey` 和 `answer` 必须逐字来自冻结 fixture，评审人必须与 freeze 一致：

```json
{
  "format": "newday-agent-evaluation-clarification-mapping",
  "version": 1,
  "trialId": "heldout:H-P05:1",
  "semanticKey": "priority",
  "questionId": "第一轮报告里的精确 ID",
  "questionText": "第一轮报告里的精确问题原文",
  "answer": "不知道",
  "reviewer": "冻结的 primaryReviewer",
  "rationale": "说明该问题为何唯一地询问两个整理任务的优先顺序",
  "decidedAt": "2026-09-21T00:00:00.000Z"
}
```

续跑仍是一条单独命令，并继续使用同一 trial 的三次总调用上限：

```bash
pnpm agent:evaluation:trial \
  --freeze "$FREEZE" \
  --acknowledge-freeze-sha256 "$FREEZE_SHA" \
  --reviewed-ledger-sha256 "$LEDGER_SHA" \
  --evidence "$EVIDENCE" \
  --scenario H-P05 \
  --repetition 1 \
  --mapping /absolute/private/path/H-P05-1-mapping.json
```

执行器只记录宿主验证结果、provider 返回的模型标识、usage、调用数、延迟、原始结构化输出和错误终态。所有人工评分字段保持 `pending/null`；命令成功也只证明该条合成 trial 留下了受控证据，不能单独声称 G3 通过。
