# Agent acceptance evidence

These tests use synthetic data, a scripted model, real local HTTP sockets, and disposable SQLite databases. Passing them establishes offline engineering behavior. It does not establish the usefulness, accuracy, constraint compliance, latency, or cost of a real model.

`fixtures/contracts.ts` contains the shared `newday-agent-v1` wire examples. `unit/contract.test.ts` validates round trips and important input limits. `unit/evaluation-corpus.test.ts` checks the fixed evaluation inputs, category counts, family split, task identities, and local dates.

`integration/agent-http.test.ts` starts the actual Fastify app on a randomly assigned loopback port with a fresh `newday-agent-acceptance-*` directory per test. It exercises task and Agent endpoints through `fetch`, reads final SQLite state, injects an event-write failure using a SQLite trigger, and drops an HTTP acknowledgement after execution to verify recovery by the original operation ID. It never reads or replaces the development database. Its fake model is injected explicitly; `null` explicitly disables model configuration.

`../e2e/agent-planning.spec.ts` uses the shared isolated Playwright server and scripted test provider. It checks complete focus-set previews and confirmed application, rejection and rest-day preservation, one clarification round, and stale proposals after a manual edit in another tab. It does not replace Agent HTTP responses with browser route mocks.

Run the pure contract and fixture checks with:

```sh
pnpm exec vitest run tests/agent/unit
```

After API integration is present, run the real HTTP/SQLite suite and browser journeys with:

```sh
pnpm exec tsx --test tests/agent/integration/*.test.ts
pnpm exec playwright test tests/e2e/agent-planning.spec.ts
```

The root `check` and E2E commands own the final integrated evidence. A worktree test result does not establish that the combined application passes.

## Frozen evaluation split

`fixtures/heldout-v2.json` reserves 40 cases: 10 normal trade-offs, 10 dates/constraints/blockers, 10 clarification/preferences/no-action cases, and 10 untrusted-input/robustness cases. `fixtures/development-v1.json` contains 12 separate development cases. Split ownership is by scenario family, with human review required in addition to different family IDs. Expected selections, exclusions, hard constraints, and human scoring rubrics were written before any provider trials. Original `heldout-v1.json` remains as historical evidence; v2 only repairs the H-C08 task timestamps that were later than its sampledAt.

The files are repository visible. They are operationally reserved, not blinded or secret. If their outcomes or expected answers inform prompt, provider, or selection tuning, that run must be disclosed as contaminated development evaluation; independent acceptance then requires new unseen scenario families. Do not silently change expected answers to match observed model output. Current corpus digests and the pretrial revision record are in `fixtures/manifest-v2.json`; the original `manifest-v1.json` is preserved.

The reserved model evaluation is 40 cases × 3 trials = 120 real provider trials with a fixed model ID, prompt version, schema version, and snapshot provenance. None of those trials has run. These cases have not yet been adapted into live provider requests. No provider credentials or paid requests are needed for the current engineering tests.

Run `pnpm agent:evaluation:preflight --output /tmp/newday-agent-evaluation-preflight.json` to check the frozen fixture digests and convert all 52 inputs through the production snapshot builder without a provider call. The current result and H-P05's runtime human adjudication are documented in [the COL-23 preflight note](../../docs/agent-evaluation-preflight.md). Exit code 2 means a static input cannot be represented and blocks trials. Exit code 3 means snapshots are representable but a human must supervise H-P05's actual first-round questions; it does not permit an unattended batch or any provider call without the separately frozen scope, call/spend caps, stop conditions, and authorization. The prospective procedure is in [the G3 trial protocol](../../docs/agent-g3-trial-protocol.md).

`pnpm agent:evaluation:trial` is the separately authorized, one-trial-at-a-time real-provider runner. It requires an exact approved freeze hash, exact clean candidate SHA, current reviewed ledger hash, private evidence directory outside the repository, one scenario ID and repetition number. Unit tests use fake models and fake fetch responses; `pnpm check`, E2E, and the trial-runner tests never make a real provider request. The G3 trial protocol defines the freeze, H-P05 mapping, cost review, stop and evidence rules.

Provider 429, timeout, malformed response, cancellation, and restart faults belong to the separate engineering suite. Injected faults must not be counted as 120 real model-quality trials. A runtime guard rejecting an invalid proposal must be reported separately from the model producing a valid proposal. Human grounding, goal-alignment, burden, and hard-constraint assessments require actual review; fixture validation and scripted output cannot supply those scores.

Seven-day personal-use evidence and the prior manual baseline are separate acceptance stages and have not been collected by these tests.
