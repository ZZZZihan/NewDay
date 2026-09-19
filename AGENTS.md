<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Workspace responsibilities

- `apps/web`: Next.js frontend. Read its installed guides at `apps/web/node_modules/next/dist/docs/` before frontend changes. Keep `src/app` limited to routing and layout; planner UI, hooks, HTTP requests, and browser migration live in `src/features/planner`.
- `apps/api`: independent Fastify HTTP server and SQLite persistence. HTTP validation belongs in `src/http`, business orchestration in `src/services`, database access in `src/storage`.
- `packages/core`: framework-independent domain rules, application operations, storage interfaces, and backup contracts. The frontend may execute domain/contract helpers but must call the HTTP API to run application operations.
- `tests`: shared regression suites and test stores. Browser tests use a disposable SQLite database on ports 3100/3002; never point replacement-import fixtures at development data.
- `tooling`: process coordination and architecture lint rules. Root `pnpm dev` starts web and API; each app also has independent dev/build/start commands.

Read `docs/architecture.md` for dependencies and API ownership. Run `pnpm check`, `pnpm build`, and the relevant `pnpm test:e2e` scenarios for changes spanning the HTTP interface or persistence. Preserve the existing working tree when moving code.

## Project management: Linear + Git

- Use the Linear **NewDay** project in team **CoLife (COL)** for requirements, work status, acceptance criteria, and blockers. Project ID: `3456fad5-6548-4edb-8cb4-d5448e7df87c`; URL: https://linear.app/colife/project/newday-aa09602a66c8.
- Read `docs/project-management.md` when starting or resuming development. Search the project for an existing issue before creating one; keep Linear current as authorized work progresses.
- Use Git/GitHub for implementation history and review: https://github.com/ZZZZihan/NewDay. New development branches use `codex/col-<number>-<short-description>`; include the `COL-<number>` in commit messages and PR titles, and link the Linear issue in the PR body.
- Inspect the branch, worktree, staging area, and remote before changes. Preserve pre-existing edits; stage only the intended scope. Continue existing work on its current branch when appropriate instead of renaming or resetting it to match the new convention.
- Record the candidate commit SHA, relevant validation, and PR URL in the Linear issue. Use `In Review` for code awaiting review; use `Done` only after merge and issue-specific acceptance. Documentation or administrative tasks can finish after their stated deliverables are verified.
- Linear and GitHub are the live status sources; repository status documents are dated evidence. Do not equate linked repositories with configured automatic status synchronization, or software checks with real-model or personal-use acceptance.
