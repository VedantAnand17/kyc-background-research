# Background research API

Budget-capped KYC and background-research HTTP service.
One search in, one honest costed file out, never overspend.
Every external lookup is bought through Perflo.
There are no vendor keys of our own.

This file is the always-loaded agent contract.
The specification, glossary, and decisions live in the files below.
Read those before changing a module.
Do not copy them here.

## Read first

- [PRD.md](PRD.md) is the spec: API, report schema, five-phase lifecycle, Spend Guard, identity weights, capability map, Perflo error table, config, tests, and the seven-milestone build order.
  Section 19 is the working rules for agents building this.
- [CONTEXT.md](CONTEXT.md) is the vocabulary.
  Use those words in code, tests, PR titles, and chat.
- [docs/adr/](docs/adr/) is why the design is this way.
  Read the ADR that touches the module you are about to change.
- [requirements.md](requirements.md) is must-have versus good-to-have.
- [original-assignment.md](original-assignment.md) is the interview brief.
- [README.md](README.md) is how to run it and the current milestone status.
- [`.env.example`](.env.example) is every environment variable.
  PRD section 13 is the meaning of each one.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`VedantAnand17/kyc-background-research`), via `gh-axi` / `gh`.
See `/home/vedant/codes/.agents/docs/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using the default label strings.
See `/home/vedant/codes/.agents/docs/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root.
See `/home/vedant/codes/.agents/docs/domain.md`.

## Hard rules

These are always on.
A pull request that violates them is not mergeable.

- Spent plus reserved never exceeds the Cap.
- Money is `bigint` micro-dollars everywhere except the HTTP boundary.
  A `number` holding money is a bug.
  `src/budget/money.ts` is the only module that parses or formats amounts.
- The Spend Guard is the only component that can approve a paid call.
  Never call `POST /v1/pay` outside `src/research/tools.ts`, and never without a reservation.
- Budget against a vendor's `maxChargePerCall` (the Quote), never its `price`.
- Send `Idempotency-Key` and `maxCharge` on every pay call.
- A 200 with `status: "failed"` is still a charge.
  An unrecognized 5xx on pay is a hold, then reconcile through `GET /v1/transactions`.
  Never re-pay blind after a timeout or 5xx.
  Documented codes keep the PRD section 10 table (`VENDOR_ERROR` releases; `SETTLEMENT_RECORDING_FAILED` settles at reserved).
- The LLM decides which allowed capability to buy next.
  Code decides whether we can afford it, which Vendor, and who the Subject is (ADR-0001).
- The LLM never sees raw vendor payloads, never writes an amount, and never assigns an identity score.
- Tools are capabilities, not vendor slugs (ADR-0003).
  The model never sees slugs.
- Perflo is the only external data source (ADR-0005).
  PEP and sanctions report `not_screened` when the catalog has no payable watchlist vendor.
- One milestone per pull request.
  Do not mix milestones.
  Build order and acceptance are PRD section 18.
- Do not add dependencies beyond `package.json` without stating why in the PR.
- Keep each sentence on its own line in Markdown files.
- Do not add an agent name as a commit co-author.
- Never commit `.env` or a Perflo / LLM key.

## Context re-entry (multi-project juggling)

The reader is juggling several projects, each with several concurrent sessions, and has usually lost the thread by the time they return to any one of them.
Write every user-facing message for cold re-entry.
Assume they remember nothing from the scrollback.

- **Open with a recap.**
  Before any summary, decision point, or question: 2-3 plain sentences on what we were just working on, why, and where it stands now.
- **Plain language.**
  No invented codenames, abbreviations, or callbacks like "the earlier fix" or "option B from before".
  Restate the thing in place, every time.
- **Self-contained questions.**
  When asking them to decide something, the question itself must carry everything needed to answer it: the background, the options, the tradeoffs, and your recommendation.
  Never require scrolling back.
- **One question at a time.**
  When a summary or decision point holds several open questions or next steps, say so up front ("three decisions are waiting; here's the first"), then present only the first and wait for the answer before raising the next.
- **Anchor the work.**
  Name the project, branch, and PR when reporting status.
  Several other sessions look just like this one.
- **End with the next action.**
  Close long updates with the single thing waiting on them, or say explicitly that nothing is.

## Worktrees

Use [treehouse](https://github.com/kunchenguid/treehouse) to manage worktrees.
Never run `git worktree add` by hand.
Treehouse keeps a pool of reusable worktrees, so dependencies and build cache survive between sessions and agents start warm instead of reinstalling.

```bash
treehouse get --lease --lease-holder <agent-name>   # acquire a worktree; prints its path
treehouse return <path>                             # release it when done
treehouse status                                    # inspect the pool
```

Rules:

- Agent sessions acquire with `get --lease` and release with `treehouse return`.
  A leased worktree is never handed out twice and is never pruned until returned.
- Treehouse hands out a detached HEAD at the latest default branch.
  Create a branch before committing: `git switch -c <branch-slug>` inside the worktree.
- Unlanded work is never discarded automatically.
  Commit and push a branch before returning the tree.
  Only `destroy --include-unlanded --yes` removes dirty or unmerged content, and only after the human confirms it is disposable.
- If treehouse is not installed, install it first
  (`curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh`)
  rather than falling back to manual worktrees.

**Never create a worktree under `/tmp` or other tmpfs.**
Treehouse's pool root is on ext4.
A new tool that wants a different worktree root must be checked with `findmnt` first.

After the work is merged, return the worktree to the pool with `treehouse return`.
Pool cleanup is `treehouse prune` (dry run by default; `--yes` only after reviewing the list).
Do not reuse old trees by hand.
A returned tree is reset to the latest default branch automatically.

## TDD is mandatory

Every change follows **failing test first, then implement, then verify**:

1. Write the test(s) that capture the desired behavior and watch them **fail** (red).
2. Implement the minimum to make them pass.
3. Run the suite and typecheck and confirm green.

Do not write implementation before a failing test exists.
When fixing a bug, reproduce it with a failing test first.
Required test files and cases are PRD section 16.
Tests live in `test/` and mirror `src/` names.

## Verify before claiming "done"

Never report something as working without running it.
"Done" means: relevant tests green, `pnpm check` clean, and for a live or fixture research flow, one end-to-end request that returns a schema-valid report.
If tests fail or a step was skipped, say so plainly with the output.

Commands (also in README and `package.json`):

```bash
pnpm install
pnpm test
pnpm check
pnpm dev                  # GET /health and /openapi.json
```

`FIXTURE_MODE=true` serves recorded vendor responses from `test/fixtures/` and spends nothing.
Live mode needs `PERFLO_AGENT_KEY` plus a Cloudflare account id and an API token with Workers AI read.
The default model is `@cf/zai-org/glm-5.3` (ADR-0006).
Do not run a paid live call unless the human asked for one.

## Orchestrating the gate (builder/driver split)

This project is `no-mistakes-prod-only`: product-facing work ships through the no-mistakes pipeline.
Follow the [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) install for this stack.

- **Builders never drive the gate.**
  A builder agent builds, commits on its branch, and ends its task with a `HANDOFF: INTENT` paragraph: a thorough statement of what changed and why, for the reviewer.
  Its large transcript is read once and never resumed for gate-driving.
- **A fresh tiny driver agent per worktree** (cheap model, few-k-token context) runs the gate.
  It starts the review with the handed-off intent, monitors progress, and answers the gate's questions.
- **Gate rules for the driver:** apply auto-fixable findings; approve info-only findings; for anything that needs a human decision, PARK.
  Quote the finding verbatim and end the task so the orchestrator can relay it, then resume the driver with the decision.
  Resume a builder only when a finding needs real code fixes.
- Never end a subagent's turn while a gate run is active.
  Its background processes are orphaned the moment the turn ends.

Workflow conventions adapted from
[AGENTS.md Snippets](https://github.com/VedantAnand17/agents-md-snippets).

## Layout

Point at `README.md` for the directory sketch.
The pieces that matter for every session:

| Path | Role |
|---|---|
| `src/budget/money.ts` | Integer micro-dollars. Only parser/formatter. |
| `src/budget/ledger.ts` | Spend Guard: reserve, settle, release, hold. |
| `src/perflo/client.ts` | Typed Perflo HTTP client. Never retries a pay call blind. |
| `src/perflo/errors.ts` | `ledgerActionFor` / `ledgerActionForError`. Branch on `code` and status, never on message. |
| `src/research/` | Planner, agent loop, tools, capability map, orchestrator. Tools and the capability map ship in M3; planner, agent, and orchestrator ship in M5. |
| `src/identity/` | Matcher. Shipped in M4. |
| `src/evidence/` | Source store and extractors ship in M3; report assembler stays a stub until M6. |
| `src/api/` | Hono routes and Zod schemas. `/health` ships; `POST /research` is M6. |
| `test/fake-perflo.ts` | In-process Perflo for tests. Covers every documented pay outcome. |
| `test/fixtures/` | Recorded responses for fixture mode. Fill in M7. |

## Milestone map

PRD section 18 is the owner.
Current status is also in README.

- M1 Foundation: done (`money.ts`, config, SQLite, `/health`).
- M2 Perflo client and Spend Guard: done, including hold-on-unrecognized-5xx.
- M3 Capabilities and tool layer: done (capability map, contract cache, tools, evidence store, extractors).
- M4 Identity matcher: done.
- M5 Agent loop and orchestrator: done, including `jobs.spent_micro` at job end and settle outcome in `perflo_code`.
- M6 Report assembler and `POST /research`.
- M7 Live verification and README.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
