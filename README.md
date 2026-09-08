# Background research API

A budget-capped KYC and background-research service.
Send a name and a maximum spend; get back one structured, cited, costed report.
Every external lookup is bought through Perflo's pay-per-use marketplace, never through vendor keys of our own.

One line: one search in, one honest costed file out, never overspend.

## Read first

- [AGENTS.md](AGENTS.md): always-loaded agent contract (Claude loads it via `CLAUDE.md`).
- [PRD.md](PRD.md): the full specification, milestone by milestone.
  Agents build from this.
- [CONTEXT.md](CONTEXT.md): the vocabulary this codebase uses.
- [docs/adr/](docs/adr/): why the design is the way it is.
- [requirements.md](requirements.md): must-have versus good-to-have.
- [original-assignment.md](original-assignment.md): the brief.

## Status

M1 foundation, M2 (Perflo client + Spend Guard), M3 (capabilities and tool layer), and M4 (identity matcher) are implemented.
The reservation ledger refuses a paid call that would breach the cap, including under concurrent reservations, and persists every transition to SQLite.
The typed Perflo client covers every section-10 endpoint and error code against `test/fake-perflo.ts`.
The tool layer maps each capability to a vendor, quotes the live contract, reserves, pays, and stores a Source.
A repeat call is served from that store at zero charge.
The matcher scores each Candidate against the Subject with the section-8 weights, labels it, and selects a Primary candidate only when it is confirmed or a probable lead of at least 0.15.
Later milestones remain stubs tagged `TODO(Mn)`.

## Run

Requires Node 22 and pnpm 11.

```bash
pnpm install
cp .env.example .env      # fill in keys, or set FIXTURE_MODE=true to run without money
pnpm dev                  # http://localhost:3000/health and /openapi.json
pnpm test
pnpm check                # typecheck
```

Fixture mode (`FIXTURE_MODE=true`) serves recorded vendor responses from `test/fixtures/` and spends nothing.
Live mode needs a Perflo agent key plus a Cloudflare account id and an API token with Workers AI read; the default model is `@cf/zai-org/glm-5.3` (ADR-0006).
See `.env.example` and PRD section 13.

## Layout

```
src/
  index.ts        server entry
  config.ts       env -> validated Config
  logger.ts       pino
  api/            routes.ts, schemas.ts (request + report Zod schemas, OpenAPI)
  research/       orchestrator.ts, planner.ts, agent.ts, tools.ts, capabilities.ts, prompts.ts
  budget/         money.ts (bigint micro-dollars), ledger.ts (Spend Guard)
  identity/       matcher.ts, normalize.ts
  evidence/       store.ts, extract.ts, report.ts
  perflo/         client.ts, errors.ts, types.ts
  db/             sqlite.ts, schema.sql
test/             mirrors src/; fake-perflo.ts; fixtures/
```

## Example

Request:

```json
POST /research
{
  "firstName": "Ada",
  "lastName": "Okonkwo",
  "dateOfBirth": "1991-04-12",
  "address": { "city": "Lagos", "country": "NG" },
  "maxBudget": { "amount": "1.50", "currency": "USD" }
}
```

Response: see PRD section 5.4 for the full shape.
`costs.total` never exceeds `maxBudget`; PEP and sanctions read `not_screened` when the Perflo catalog has no payable watchlist vendor.
