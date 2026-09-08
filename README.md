# Background research API

A budget-capped KYC and background-research service.
Send a name and a maximum spend; get back one structured, cited, costed report.
Every external lookup is bought through Perflo's pay-per-use marketplace, never through vendor keys of our own.

One line: one search in, one honest costed file out, never overspend.

## Read first

- [PRD.md](PRD.md): the full specification, milestone by milestone.
  Agents build from this.
- [CONTEXT.md](CONTEXT.md): the vocabulary this codebase uses.
- [docs/adr/](docs/adr/): why the design is the way it is.
- [requirements.md](requirements.md): must-have versus good-to-have.
- [original-assignment.md](original-assignment.md): the brief.

## Status

Scaffold only.
The foundation (`money.ts`, config, database schema, `GET /health`, OpenAPI document) runs.
Everything else is a stub tagged `TODO(Mn)` pointing at its PRD section and milestone.

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
Live mode needs a Perflo agent key and an LLM key; see `.env.example` and PRD section 13.

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
