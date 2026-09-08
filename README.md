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

M1 foundation through M6 (report assembler and `POST /research`) are implemented.
The reservation ledger refuses a paid call that would breach the cap, including under concurrent reservations, and persists every transition to SQLite.
The typed Perflo client covers every section-10 endpoint and error code against `test/fake-perflo.ts`.
The tool layer maps each capability to a vendor, quotes the live contract, reserves, pays, and stores a Source.
A repeat call is served from that store at zero charge.
The matcher scores each Candidate against the Subject with the section-8 weights, labels it, and selects a Primary candidate only when it is confirmed or a probable lead of at least 0.15.
The orchestrator runs the five phases, honors a 45 second default deadline, and returns a schema-valid report in fixture-style tests for basic, standard, deep, deadline-hit, budget-exhausted, and ambiguous identity.
`POST /research` returns that report over HTTP.
`GET /docs` renders the OpenAPI explorer.
A skipped risk screen marks every category `not_screened` with warnings and forces overall risk `unknown`.
The default model is `@cf/zai-org/glm-5.3` for the tool loop and the narrative.
Person-targeted tools cache by the subject so a second `enrich_person` with different optional fields does not pay twice.
News in the profile uses the same about-primary filter as reputational hits.
A `Dockerfile` builds the API image.
CI builds that image on a clean clone.
`pnpm test:live` is the real-model harness that must stay green before M7 spends Perflo money.
M7 (live verification and README polish) remains.

## Run

Requires Node 22 and pnpm 11.

```bash
pnpm install
cp .env.example .env      # fill in keys, or set FIXTURE_MODE=true to run without money
pnpm dev                  # http://localhost:3000/health, /docs, /openapi.json, POST /research
pnpm test                 # unit and fake-server suite; skips live-model and funded Perflo tests
pnpm test:live            # real glm-5.3 against the fake Perflo server; skipped without Workers AI credentials
pnpm test:perf            # five live runs per tier; prints p50 per phase
pnpm check                # typecheck
```

CI on every push runs `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm check`, and `docker build`.
Do not spend real Perflo money until `pnpm test` and `pnpm test:live` are green.
`pnpm test:live` is the gate: it still fails on live timing as of 2026-09-08 (basic ~40-87s against a 30s target; the 45s default deadline cuts the tool loop).
Raise a target only after `pnpm test:perf` prints a p50. Do not start M7 until that gate is green.

Fixture mode (`FIXTURE_MODE=true`) is meant to serve recorded vendor responses from `test/fixtures/` and spend nothing.
Those recordings do not exist yet; they are M7 work.
Until then, setting `FIXTURE_MODE=true` at runtime will fail on the first lookup with `missing fixture`.
Tests inject the in-process fake Perflo server and do not use those files.
Live mode needs a Perflo agent key plus a Cloudflare account id and an API token with Workers AI read.
The default model is `@cf/zai-org/glm-5.3` (ADR-0006).
See `.env.example` and PRD section 13.

```bash
docker build -t kyc-background-research .
docker run --env-file .env -p 3000:3000 kyc-background-research
```

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
