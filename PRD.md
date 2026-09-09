# PRD: Budget-capped KYC and background-research API

Status: approved design; M1 through M6 implemented.
Owner: Vedant.
Source brief: [original-assignment.md](original-assignment.md).
Scope split: [requirements.md](requirements.md).
Vocabulary: [CONTEXT.md](CONTEXT.md).
Decisions: [docs/adr/](docs/adr/).

This document is written so that an agent can implement the product from it without asking design questions.
Where it says MUST, a pull request that violates it is not mergeable.
Where it says SHOULD, deviate only with a stated reason in the PR.

## 1. Problem and goal

A caller knows a person's name, maybe their date of birth and location, and how much money they are willing to spend finding out who that person is.
They want one structured, cited, costed report: who the person appears to be, how confident we are, what public risk exists, and exactly what each lookup cost.

The product is a backend HTTP service.
It buys every external lookup through Perflo's pay-per-use marketplace and never through vendor keys of its own.
It is evaluated in a technical interview on correctness, architecture, budget discipline, speed, agent and tool-calling design, identity-matching accuracy, and code quality.

One line: one search in, one honest costed file out, never overspend.

## 2. Non-goals for the must-have release

These are explicitly out of scope until the must-have release ships.
Do not build them, do not leave hooks for them beyond what the design already provides.

- A web UI or dashboard.
- Authentication or API keys for our own endpoint.
- Per-request Perflo sub-accounts or per-tenant envelopes.
- Async job submission and polling as the primary interface.
- Result caching across requests.
- Any non-Perflo data source, including free sanctions databases.
  PEP and sanctions are reported as `not_screened` when the Perflo catalog has no payable watchlist vendor at run time.
  This is a deliberate decision, see [ADR-0005](docs/adr/0005-perflo-only-sources.md).
- Webhooks, billing statements, kill switches beyond the per-request ceiling.

## 3. Users and the single flow

The user is another system: a script, a CRM integration, or the interviewer's terminal.
There is one flow.

1. The caller sends `POST /research` with a name, optional date of birth, optional address, and a maximum budget.
2. The service plans a tier from the budget, resolves candidate identities, disambiguates, enriches the best candidate, screens risk, and writes a report.
3. The caller receives the report in the same HTTP response, inside a wall-clock deadline, with warnings for anything that could not be verified.

## 4. Architecture summary

One Node process, TypeScript, six components.
Full rationale is in the ADRs.

| Component | Kind | Responsibility |
|---|---|---|
| API | code | Validate input, own the deadline, return the report. |
| Planner | code | Map the budget to a tier, an allowed tool set, and a reserve. |
| Agent loop | LLM | Decide which allowed capability to buy next given the evidence so far. |
| Tool layer | code | Map a capability to a Perflo vendor with fallback, quote it, dedupe, run calls concurrently. |
| Spend Guard | code | Reservation ledger that makes overspend impossible. |
| Identity matcher | code | Score each candidate against the input and label it. |
| Evidence store | code | Persist every vendor response as a Source with its cost. |
| Report assembler | code + LLM | Build the schema-checked report; code fills costs, confidence, and risk level; the LLM writes narrative only. |
| Perflo client | code | Typed HTTP client, idempotency keys, error code mapping. |

The rule that binds them: the LLM decides what is worth buying, code decides whether we can afford it, which vendor, and who the person is.
Money and identity never pass through the model.

## 5. API contract

### 5.1 `POST /research`

Request body, validated with Zod.
Unknown fields are rejected.

```json
{
  "firstName": "Ada",
  "lastName": "Okonkwo",
  "dateOfBirth": "1991-04-12",
  "address": { "line1": "12 Marina Rd", "city": "Lagos", "region": "Lagos", "country": "NG" },
  "maxBudget": { "amount": "1.50", "currency": "USD" },
  "options": { "deadlineMs": 60000 }
}
```

Field rules:

- `firstName`, `lastName`: required, 1 to 100 characters, trimmed, Unicode allowed.
- `dateOfBirth`: optional, ISO `YYYY-MM-DD`, must be in the past.
- `address`: optional; every subfield optional; `country` is ISO 3166-1 alpha-2 when present.
- `maxBudget.amount`: required, decimal string matching `^\d+(\.\d{1,6})?$`, greater than zero, at most `1000.000000`.
- `maxBudget.currency`: required, MUST be `USD` in this release.
- `options.deadlineMs`: optional, 5000 to 120000; default 90000 for basic and 120000 for standard and deep (measured Apify actor runs take up to 30 s and Perflo settlement 9 to 11 s), or `RESEARCH_DEADLINE_MS` when that variable is set.

Responses:

- `200` with a Report whenever at least one lookup ran or was attempted, even if every lookup failed.
  Warnings carry the failures.
- `400` with a validation error body when the request does not match the schema.
- `503` only when no lookup could be attempted at all: Perflo unreachable, agent key rejected, account empty before the first call, or the model failing before the first lookup (`llm_unavailable`).
  The body names the reason with Perflo's error code where one exists, or `llm_unavailable` for a model failure.

### 5.2 `GET /health`

Returns `{ "status": "ok", "version": "<package version>" }`.
No auth, no external calls.

### 5.3 `GET /openapi.json` and `GET /docs`

Generated from the same Zod schemas by `@hono/zod-openapi`.
The docs page is the interview demo surface for the API contract.

### 5.4 Report schema

The report is validated against a Zod schema before it is sent.
A report that fails validation is a server bug and MUST fail the request loudly in development and be logged at error level in production.

```jsonc
{
  "requestId": "req_01J…",
  "subject": { "firstName": "Ada", "lastName": "Okonkwo", "dateOfBirth": "1991-04-12", "address": { … } },
  "tier": "standard",
  "identity": {
    "status": "confirmed" | "probable" | "ambiguous" | "not_found",
    "primaryCandidateId": "c1" | null,
    "candidates": [
      {
        "id": "c1",
        "confidence": 0.86,
        "label": "confirmed" | "probable" | "possible",
        "summary": "Product lead at Paystack, Lagos",
        "matchedOn": ["name", "location", "corroboration"],
        "conflicts": [],
        "sourceIds": ["s1", "s2"]
      }
    ]
  },
  "profile": {
    "employment": [{ "title": "…", "company": "…", "from": "2019-03", "to": null, "sourceIds": ["s2"] }],
    "education": [{ "institution": "…", "degree": "…", "from": "…", "to": "…", "sourceIds": [] }],
    "contacts": { "emails": [{ "value": "…", "sourceIds": [] }], "phones": [{ "value": "…", "sourceIds": [] }] },
    "socialProfiles": [{ "network": "linkedin" | "x" | "instagram" | "other", "url": "…", "handle": "…", "sourceIds": [] }],
    "news": [{ "title": "…", "url": "…", "publishedAt": "…", "outlet": "…", "sourceIds": [] }],
    "publicRecords": [{ "kind": "sec_filing" | "other", "title": "…", "url": "…", "sourceIds": [] }]
  },
  "risk": {
    "pep":          { "status": "clear" | "hits" | "not_screened", "hits": [] },
    "sanctions":    { "status": "clear" | "hits" | "not_screened", "hits": [] },
    "fraud":        { "status": "clear" | "hits" | "not_screened", "hits": [] },
    "reputational": { "status": "clear" | "hits" | "not_screened", "hits": [
      { "summary": "…", "severity": "low" | "medium" | "high", "sourceIds": ["s7"], "candidateId": "c1" }
    ] },
    "overall": { "level": "low" | "medium" | "high" | "unknown", "rationale": "…" }
  },
  "sources": [
    { "id": "s1", "vendor": "stableenrich-minerva-resolve", "capability": "find_people", "purpose": "resolve candidates", "retrievedAt": "…", "status": "succeeded" | "failed" }
  ],
  "costs": {
    "budget":    { "amount": "1.500000", "currency": "USD" },
    "total":     { "amount": "1.120000", "currency": "USD" },
    "remaining": { "amount": "0.380000", "currency": "USD" },
    "calls": [
      { "sourceId": "s1", "vendor": "…", "capability": "…", "status": "succeeded" | "failed", "charged": { "amount": "0.020000", "currency": "USD" }, "transactionId": "…" }
    ]
  },
  "warnings": [
    { "code": "pep_not_screened", "message": "PEP screening not available: no payable watchlist vendor in the Perflo catalog at run time." }
  ],
  "timing": { "totalMs": 18740, "deadlineHit": false, "phases": { "resolve": 2100, "enrich": 9800 } }
}
```

Invariants the assembler MUST enforce:

- `costs.total` equals the sum of `costs.calls[].charged` and equals the ledger's settled total, computed in integer micro-dollars.
- `costs.total` is less than or equal to `costs.budget`.
- Every `sourceIds` entry references an id present in `sources`.
- Every `profile` fact comes only from sources attached to the primary candidate, and only when `identity.status` is `confirmed` or `probable`.
  When it is `ambiguous` or `not_found`, `profile` sections are empty arrays and a warning explains why.
- `risk.overall.level` is `unknown` whenever `identity.status` is `ambiguous` or `not_found`.
- Amounts are decimal strings with exactly six fractional digits.

## 6. The request lifecycle in detail

### 6.1 Phase 0: Plan (code)

Input: the validated request.
Output: a `Plan` with `tier`, `allowedTools`, `capMicro`, `reserveMicro`, `deadlineAt`.

Tier thresholds, from `maxBudget`:

| Tier | Budget | Allowed tools |
|---|---|---|
| `basic` | less than $0.50 | `find_people`, `get_professional_profile`, `search_news`, `screen_watchlist`, `finish` |
| `standard` | $0.50 to $2.00 inclusive | basic plus `enrich_person`, `get_social_profile`, `search_web` |
| `deep` | more than $2.00 | standard plus `skip_trace`, `search_filings`, `fetch_page` |

Reserve: the cheapest live Quote among allowed tools that can separate two candidates (`find_people`, `finish`, and `screen_watchlist` excluded), held back from resolve so that call cannot spend the discriminator.
The hold is clamped so `find_people`'s own Quote still fits the cap.
After resolve, leftover reserve is unlocked for disambiguation, enrich, and screen.
A missing Quote means a zero reserve.
Money still in the hold at the end of the request is never spent.

### 6.2 Phase 1: Resolve (agent)

The agent is instructed to call `find_people` with the subject's name plus any location hint.
The tool layer runs the cheapest mapped vendor first and returns a compact candidate list.
If the cheap vendor returns zero candidates and the tier allows, the tool layer falls back to the next mapped vendor once.
Zero candidates after fallback yields `identity.status = "not_found"` and the run skips to phase 5.

### 6.3 Phase 2: Disambiguate (code, then agent if needed)

The matcher scores every candidate (section 8).
If the top candidate is `confirmed`, or is `probable` and leads the runner-up by 0.15 or more, it becomes the primary candidate.
Otherwise the run is ambiguous.
The agent is told the two closest candidates and asked to pick one allowed tool that would separate them; the reserve is already unlocked after resolve, so that call and any later phase can use leftover.
After that call the matcher re-scores.
If still ambiguous, `identity.status = "ambiguous"`, phases 3 and 4 run only adverse-media queries scoped to the name, and profile sections stay empty.

### 6.4 Phase 3: Enrich (agent, parallel)

The agent may issue several tool calls in one turn; the tool layer runs them concurrently with a concurrency limit of 4.
The enrich prompt states that the primary candidate is already resolved and `find_people` must not be called again.
Each tool result returned to the model is a compact summary of at most 1,500 characters plus the `sourceId`, the charged amount, and the remaining budget.
Raw vendor payloads are stored in SQLite and never enter the model context.
The agent stops enriching when it judges the file complete, when every allowed tool has been used for the primary candidate, or when remaining headroom is below the cheapest live quote among the allowed tools.

### 6.5 Phase 4: Screen risk (agent, parallel)

This phase does not depend on enrich results and MUST run concurrently with phase 3 when both run.
Two things always happen here regardless of tier:

- `search_news` and, when allowed, `search_web` are called with adverse-media queries built by code from a fixed template list, for example `"<full name>" fraud OR scam OR arrested OR indicted OR lawsuit OR sanctions`.
  The agent classifies each returned hit as about the primary candidate or not, and assigns a severity; code stores the classification with the source.
- `screen_watchlist` runs `POST /v1/search` with the query `PEP sanctions watchlist screening` filtered to payable vendors.
  If a payable vendor is returned and its `maxChargePerCall` fits the remaining budget, the tool layer pays it once and maps the result to `pep` and `sanctions`.
  If none is returned, both statuses are `not_screened` and the corresponding warnings are added.
  No other source is consulted for PEP or sanctions.

### 6.6 Phase 5: Report (code, then LLM for narrative)

Code assembles everything except narrative fields: identity block from the matcher, profile from sources tagged to the primary candidate, risk statuses and hits from phase 4, `costs` from the ledger, `warnings` from the run log, `timing` from the clock.
The LLM is then asked, with structured output, to fill exactly three narrative fields: each candidate's `summary`, each reputational hit's `summary`, and `risk.overall.rationale`.
If the LLM call fails after two retries, those fields are filled with the literal `"narrative unavailable"` and a warning is added.
The final object is validated against the report schema.

### 6.7 Deadline behavior

The orchestrator holds an `AbortSignal` derived from `deadlineAt` minus a synthesis allowance: 15 seconds on basic, 25 on standard, 30 on deep.
When it fires: tool calls not yet started are dropped, in-flight calls are awaited for up to 5 more seconds, then phase 5 runs with whatever exists.
The narrative pass still runs inside that synthesis allowance; it does not inherit the aborted tool-phase signal.
Each of its two attempts gets a fresh timeout of at most 15 seconds, bounded by the time still left, so a request that stalls on the richer tiers leaves room for a second attempt (a funded deep run on 2026-09-08 lost its narrative to one such stall).
Independently, every model HTTP request is capped at `LLM_REQUEST_TIMEOUT_MS` (default 30 seconds) so a hung connection in any phase fails fast rather than running to the deadline.
If the screen phase never started, every risk category is `not_screened` with a warning and `risk.overall.level` is `unknown`.
`timing.deadlineHit` is true and a warning names the phase that was cut.
After the response is sent, any in-flight call that was abandoned is reconciled against `GET /v1/transactions` so the ledger row never stays a phantom reservation.

## 7. Spend Guard

The Spend Guard is the only component allowed to approve a paid call.

### 7.1 Money representation

All amounts are integer micro-dollars in `bigint`; 1 USD is 1,000,000.
`src/budget/money.ts` is the only module that parses Perflo decimal strings and formats them back.
Floating point MUST never touch an amount.
Formatting always emits six fractional digits.

### 7.2 Ledger semantics

Per request, the ledger tracks `capMicro`, `reservedMicro`, `spentMicro`.

- `reserve(amountMicro)`: succeeds if and only if `capMicro - spentMicro - reservedMicro >= amountMicro`; then `reservedMicro += amountMicro`.
  The check and update are one synchronous step under a per-request mutex, so concurrent reservations cannot both pass on the same headroom.
- `settle(reservationId, chargedMicro)`: `reservedMicro -= amount; spentMicro += chargedMicro`.
  Called for every `200` from the pay route, including `status: "failed"`, because Perflo charges for a vendor that answered and failed.
  `chargedMicro` is what Perflo debited, not always the `charged` field: a successful pay whose `settlement.status` is `not_required` (the per-item Apify actors) posts the whole authorization, so it settles at the reserved quote.
  Verified 2026-09-08: `GET /v1/key` `spent` equals the sum of posted transaction amounts, which carry the cap (`-0.05`) while the pay response meters `0.0065`.
  A `finalized` settlement debits exactly `charged`, and a failed run is voided.
- `release(reservationId)`: `reservedMicro -= amount`.
  Called for every refusal that Perflo documents as free.
- `hold(reservationId)`: leaves the reservation in place until a transaction lookup resolves it, used after a timeout or a `500`.

The amount reserved is the vendor's `maxChargePerCall` from `GET /v1/vendors/{slug}` or `POST /v1/search`, never its `price`.
Every pay call sends `maxCharge` equal to the reservation, so Perflo refuses for free any charge the ledger did not authorize.
Every ledger transition is written to the `ledger` table before the next network call.

### 7.3 Perflo-side backstop

One Perflo agent key is configured for the whole deployment, pinned to one envelope with an hourly cap chosen by the operator.
That envelope bounds total damage if the service has a bug; it is not the per-request control.

## 8. Identity matching

Deterministic, in `src/identity/matcher.ts`, unit-tested against fixtures.

### 8.1 Signals and weights

| Signal | Weight | Score |
|---|---|---|
| Name | 0.35 | normalized exact 1.0; known nickname or alias 0.9; otherwise Jaro-Winkler on normalized full name |
| Date of birth | 0.25 | exact 1.0; year only 0.6; absent in source 0; conflict applies a hard cap of 0.30 on the total |
| Location | 0.20 | city and country match 1.0; country only 0.5; absent 0; conflict subtracts 0.30 from the total |
| Corroboration | 0.20 | 1.0 when the same employer, handle, or profile URL appears in two or more independent sources; 0 otherwise |

Normalization: Unicode NFKD, strip diacritics, lowercase, drop punctuation, collapse whitespace, ignore middle names and suffixes such as Jr.
A small alias table maps common nicknames (for example William to Bill).

### 8.2 Missing inputs

When the request omits `dateOfBirth`, the DOB weight is redistributed proportionally across the remaining signals and the total is capped at 0.85.
The same applies when `address` is omitted.
A warning states which inputs identity rests on.

### 8.3 Labels and use

- `confirmed`: score at least 0.80.
- `probable`: 0.55 to 0.79.
- `possible`: below 0.55.

Only a `confirmed` or `probable` primary candidate contributes profile facts.
Every other candidate stays in `identity.candidates` with its `conflicts`, so a same-name person in another city is visible and never merged.
Conflicting facts about the primary candidate from two sources (two different current employers, for example) are both kept, each with its own `sourceIds`, and a warning names the conflict.

## 9. Tools and the capability map

The LLM sees these tools and only these.
Each tool's argument schema is a Zod object in `src/research/tools.ts`.
The capability map in `src/research/capabilities.ts` lists vendors in preference order; the first `payable` vendor whose quoted `maxChargePerCall` fits the remaining headroom is used.
Vendor contracts are fetched at startup from `GET /v1/vendors/{slug}` and cached for one hour.

| Tool | Arguments | Vendors, in order | Listed max per call | Tier |
|---|---|---|---|---|
| `find_people` | fullName, locationHint? | `stableenrich-minerva-resolve`, `stableenrich-fullenrich-people-search` | $0.02, $0.15 | basic |
| `get_professional_profile` | profileUrl or (fullName, company?) | `apify-harvestapi-linkedin-profile-scraper`, `apify-apimaestro-linkedin-profile-detail` | $0.05 | basic |
| `search_news` | query | `ottoai-filtered-news`, `stableenrich-serper-news` | $0.001, $0.04 | basic |
| `screen_watchlist` | fullName, dateOfBirth?, country? | runtime `POST /v1/search` for `PEP sanctions watchlist screening`; none listed today | n/a | basic |
| `enrich_person` | fullName, company?, location?, profileUrl? | `stableenrich-pdl-people-enrich` | $0.28 | standard |
| `get_social_profile` | network (`x` or `instagram`), handleOrName | x: `stablesocial-twitter-profile` then `stablesocial-twitter-user-tweets`; instagram: `stablesocial-instagram-search-profiles` then `stablesocial-instagram-profile` | $0.06 each | standard |
| `search_web` | query | runtime `POST /v1/search` for `web search`, prefer `isPrimary` | about $0.03 | standard |
| `skip_trace` | fullName, city?, region? | `apify-one-api-skip-trace` | $0.20 | deep |
| `search_filings` | fullName | `paysponge-edgar-search` | $0.008 | deep |
| `fetch_page` | url | `stableenrich-firecrawl-scrape` | $0.013 | deep |
| `finish` | none | no vendor; ends the loop | n/a | all |

Tool layer rules:

- Dedupe key is `(tool, canonicalized arguments)`.
  A repeat returns the stored Source and reports `charged: 0` and `cached: true` to the model.
- A tool not allowed by the tier is not offered to the model at all.
- Any tool may return `{ "outcome": "budget_exhausted" }` for that call.
  Only `finish` is offered once remaining headroom is below the cheapest live quote among the tier's allowed tools.
- Every tool result to the model is capped at 1,500 characters of summary produced by `src/evidence/extract.ts` for that capability.
- Field placement follows the vendor contract's `input.fields[].in`: `body` fields go under `input`, `query` fields under `query`.
  Never guess.

Prices above are the catalog's listed maxima at design time and are reference only; the live quote is authoritative.

## 10. Perflo integration

Base URL `https://pay-per-use-api.perflo.ai`.
Authentication `Authorization: Bearer <agent key>` from `PERFLO_AGENT_KEY`.
The client in `src/perflo/client.ts` is adapted from Perflo's quickstart client and depends only on `fetch`.

Endpoints used:

- `GET /v1/vendors/{slug}` for contract, `maxChargePerCall`, `payable`, and field placement.
- `POST /v1/search` for runtime discovery of `web_search` and watchlist vendors.
- `POST /v1/pay/{slug}` for every paid call, always with `Idempotency-Key` (a fresh UUID stored on the ledger row) and `maxCharge`.
- `GET /v1/transactions/{id}` and `GET /v1/transactions` for reconciliation after a timeout or a `500`.
- `GET /v1/key` once per request before the first lookup to fail fast on a bad key; it returns the agent key's own envelope. `GET /v1/balance` is account-key only and answers `ACCOUNT_KEY_REQUIRED` to an agent key.

Error code handling, matched on `error.code` never on message text:

| Code | Charged | Ledger | Behavior |
|---|---|---|---|
| `200 status: succeeded` | yes | settle | store Source, return summary |
| `200 status: failed` | yes | settle | store failed Source, warning, one fallback vendor allowed |
| `422 MAX_CHARGE_EXCEEDED`, `SCHEMA_VALIDATION_FAILED`, `VALIDATION_ERROR` | no | release | refresh the vendor contract, retry once, then fallback |
| `403 VENDOR_NOT_PAYABLE`, `404 VENDOR_NOT_FOUND` | no | release | mark vendor unavailable for this run, fallback |
| `403 GUARDRAIL_DENIED` | no | release | deployment envelope exhausted; stop spending, warning, finish |
| `402 INSUFFICIENT_BALANCE` | no | release | same as above plus an error-level log for the operator |
| `502 VENDOR_ERROR` | no | release | fallback once, else warning |
| `202 pending_confirmation` | no | release | skip vendor, warning |
| `500 SETTLEMENT_RECORDING_FAILED` | yes | settle at reserved amount | never retry, never fail over; look up transaction, warning |
| `429 RATE_LIMITED` | no | release | back off per `RateLimit-*` headers if the deadline allows, else skip |
| timeout or connection error | unknown | hold | look up by transaction; settle or release from the answer; never re-pay blind |
| unrecognized 5xx on pay (HTML gateway page, `HTTP_5xx`, unknown shape) | unknown | hold | same as timeout; do not treat as free. Documented 5xx codes in this table still win (`VENDOR_ERROR` is release; `SETTLEMENT_RECORDING_FAILED` settles at reserved) |

## 11. LLM integration

Use the Vercel AI SDK so the provider is an environment choice.
The default is Cloudflare Workers AI through its OpenAI-compatible endpoint with `@cf/zai-org/glm-5.3`, chosen on live evidence in [ADR-0006](docs/adr/0006-cloudflare-workers-ai-glm-5-3.md).
`LLM_PROVIDER` is `cloudflare` (base URL derived from `CLOUDFLARE_ACCOUNT_ID`), `openai`, or `openai-compatible` with `LLM_BASE_URL`.
`LLM_MODEL` names the narrative and risk-classification model.
`LLM_LOOP_MODEL` names the tool-loop model and defaults to `LLM_MODEL`.
Use the `@ai-sdk/openai-compatible` provider for `cloudflare` and `openai-compatible`, and `@ai-sdk/openai` for `openai`.
Every LLM call sets `maxOutputTokens` explicitly to 1500.
Classification and the narrative pass use plain text generation plus a JSON parse.
`generateObject` / json_schema mode on glm-5.3 spends the token budget on hidden reasoning and returns no object.
Reasoning models on Workers AI otherwise spend the default budget on thinking and return an empty completion.
The agent loop uses tool calling with a step limit of 4 on resolve, 2 on disambiguate, and 3 on enrich (one fan-out turn, then finish).
The narrative pass and risk classification send `response_format: json_schema` on a raw chat-completions request.
The AI SDK openai-compatible provider does not reliably deliver that constraint to Workers AI glm-5.3.
When classification fails, hits become an `unclassified` warning and are never attached to the primary candidate.
A failed model call adds `llm_unavailable` naming the phase.
If that failure happens before the first lookup, the API returns 503 instead of a not-found report.
`@cf/openai/gpt-oss-120b` with `reasoning_effort: low` is a documented override via `LLM_LOOP_MODEL`.
Workers AI rejects its second tool-calling turn, so it is not the default.
System prompts live in `src/research/prompts.ts` as plain template strings and MUST state: the subject, the tier, the remaining budget in dollars, the list of allowed tools, and the rule that the model never invents facts not present in tool results.
The model never receives raw vendor payloads.

## 12. Persistence

SQLite via `better-sqlite3`, file path from `DATABASE_PATH`, default `./data/research.db`.
Schema in `src/db/schema.sql`, applied at startup with `CREATE TABLE IF NOT EXISTS`.

Tables:

- `jobs`: `id`, `created_at`, `finished_at`, `tier`, `cap_micro`, `spent_micro`, `status`, `request_json`, `report_json`.
- `ledger`: `id`, `job_id`, `vendor`, `capability`, `idempotency_key`, `reserved_micro`, `charged_micro`, `state` (`reserved`, `settled`, `released`, `held`), `transaction_id`, `perflo_code`, `created_at`, `updated_at`.
- `sources`: `id`, `job_id`, `ledger_id`, `vendor`, `capability`, `purpose`, `candidate_id`, `status`, `raw_json`, `extracted_json`, `retrieved_at`.

## 13. Configuration

All configuration is read once at startup in `src/config.ts` and validated with Zod.
Missing required values fail startup with a message naming the variable.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PERFLO_AGENT_KEY` | yes in live mode | | Perflo agent key, `perflo_live_…` or `perflo_test_…` |
| `PERFLO_BASE_URL` | no | `https://pay-per-use-api.perflo.ai` | override for tests |
| `LLM_PROVIDER` | no | `cloudflare` | `cloudflare`, `openai`, `openai-compatible` |
| `CLOUDFLARE_ACCOUNT_ID` | when `cloudflare` | | 32-hex account id; base URL is derived from it |
| `LLM_MODEL` | no | `@cf/zai-org/glm-5.3` | narrative and risk-classification model |
| `LLM_LOOP_MODEL` | no | `LLM_MODEL` | tool-loop override |
| `LLM_API_KEY` | yes | | provider key; for Cloudflare, an API token with Workers AI read |
| `LLM_BASE_URL` | when `openai-compatible` | | endpoint |
| `RESEARCH_DEADLINE_MS` | no | unset: `90000` basic, `120000` standard and deep | operator override for the default deadline |
| `LLM_REQUEST_TIMEOUT_MS` | no | `30000` | cap on one model HTTP request; a stalled connection fails fast instead of consuming the deadline |
| `TOOL_CONCURRENCY` | no | `4` | parallel paid calls |
| `VENDOR_TIMEOUT_MS` | no | `45000` | per paid call, including polling of a running vendor task |
| `DATABASE_PATH` | no | `./data/research.db` | SQLite file |
| `FIXTURE_MODE` | no | `false` | serve recorded vendor responses, spend nothing |
| `PORT` | no | `3000` | listen port |
| `LOG_LEVEL` | no | `info` | pino level |

## 14. Observability

Structured JSON logs with pino.
Every log line carries `requestId`.
Log at info: phase start and end with elapsed ms, every reservation, settle, release, and hold with amounts, every tool call with vendor and outcome.
Log at warn: every warning added to the report.
Log at error: report schema validation failure, `INSUFFICIENT_BALANCE`, `SETTLEMENT_RECORDING_FAILED`, unreconciled held reservations.
Never log the agent key, the LLM key, or raw vendor payloads at info level.

## 15. Performance targets

- Fixture mode with the scripted agent stays fast: basic, standard, and deep complete well under 5 seconds in the existing suite.
- Live Workers AI `@cf/zai-org/glm-5.3`, measured 2026-09-08: a constrained `json_schema` narrative call is 5.8 seconds on basic and overran 12 seconds on deep; a tool-loop turn at `reasoning_effort: low` is 3 to 6 seconds, and 15 to 20 seconds at the default effort.
- Every model call therefore sends `reasoning_effort: low`, and each tool loop stops as soon as a turn's tool calls are all accepted by code, so resolve and enrich are one model turn each when the model behaves.
- Live p50 targets are basic under 30 seconds, standard under 45 seconds, deep under 45 seconds.
- Five-run sample on 2026-09-08 (`pnpm test:perf`): p50 total 12.4 s basic, 12.3 s standard, 13.2 s deep; every run under 16 s, none hit the deadline.
- The default wall-clock deadline is 45 seconds for every tier.
- Raise a target or the default deadline only after a measured sample says the p50 is higher.
- Independent tool calls run concurrently; no phase serializes calls that do not depend on each other.
- The deadline is honored within 5 seconds in every case.

## 16. Testing strategy

Vitest.
Tests live in `test/` and mirror `src/` names.

Required before the must-have release is considered done:

- `money.test.ts`: parse and format round trips, rejection of floats and malformed strings, six-digit formatting.
- `ledger.test.ts`: concurrent reservations never exceed the cap (property-style test with random amounts), settle and release arithmetic, hold then resolve.
- `matcher.test.ts`: fixtures for exact match, nickname match, same name other city, DOB conflict cap, missing DOB renormalization, corroboration bonus, ambiguity gap.
- `report.test.ts`: every invariant in section 5.4 asserted against a generated report; schema validation failure path.
- `perflo-client.test.ts`: every error code in section 10 mapped to the documented ledger action, using the fake Perflo server in `test/fake-perflo.ts`.
- `orchestrator.test.ts`: end-to-end in fixture mode for one basic, one standard, one deep request; a deadline-hit request; a budget-exhausted request; an ambiguous-identity request; a tight-cap parallel enrich that never exceeds the cap.
- `failure-injection.test.ts`: model auth failure and model timeout, Perflo unreachable, vendor `200 failed` (charged), vendor timeout (held then reconciled), and `GUARDRAIL_DENIED`.
  Each case asserts the report or `503` this document specifies, including the warning code.
- `live-model.test.ts` (`pnpm test:live`, skipped without Workers AI credentials): real `@cf/zai-org/glm-5.3` against the fake Perflo server for basic, standard, and deep.
  Asserts narrative present, `deadlineHit` false, total within cap, each person-tool paid once, the Houston article excluded from the Lagos candidate, and per-phase timings under the section-15 targets.
- `logger.test.ts`: keys and `Authorization` headers never reach the log line.
- `fixture-mode.test.ts`: `POST /research` with `FIXTURE_MODE=true` and no network, served from the fixtures M7 recorded.
- `live-paid.test.ts` (`pnpm test:paid`, skipped without a funded Perflo agent key and Workers AI credentials): the M7 gate below; it spends real money and is never part of `pnpm test`.
- CI on a clean clone: `pnpm install --frozen-lockfile && pnpm test && pnpm check && docker build`.
- `pnpm test:perf` samples five live runs per tier and prints p50 per phase.
  Raise the default deadline only from that evidence.

Do not spend real Perflo money until those gates are green.

Fixture mode is a first-class feature, not a test hack: `FIXTURE_MODE=true` makes the Perflo client serve recorded responses from `test/fixtures/` so the interviewer can run the whole flow without a funded account.
M7 recorded them on 2026-09-08 from the funded runs, scrubbed of contact details; `pnpm test:paid` records any fixture path that is still missing.
Unit tests still inject the in-process fake server so they can script failures the recordings do not contain.

## 17. Documentation deliverables

- `README.md`: what it is, how to run it live and in fixture mode, one example request and response, how budget tiers work, what is not verified and why.
- `GET /docs`: generated OpenAPI.
- `CONTEXT.md` and `docs/adr/`: kept current when vocabulary or decisions change.

## 18. Build order and acceptance criteria

Each milestone is one pull request.
A milestone is accepted when its criteria pass in CI and the README section it touches is updated.

### M1: Foundation

- `money.ts` complete with tests.
- `config.ts`, `db/sqlite.ts`, `schema.sql`, `GET /health`, pino logging, Dockerfile.
- Accept: `pnpm test` green, `pnpm dev` serves `/health`, `pnpm check` passes.

### M2: Perflo client and Spend Guard

- `perflo/client.ts` with every endpoint in section 10 and typed errors.
- `budget/ledger.ts` with reserve, settle, release, hold and SQLite persistence.
- `test/fake-perflo.ts` covering every documented code.
- Accept: `ledger.test.ts` and `perflo-client.test.ts` green, including the concurrency property test.

### M3: Capabilities and tool layer

- `capabilities.ts` map, contract cache, vendor selection with fallback, dedupe, concurrency limit, field placement from `in`.
- `evidence/store.ts` and `extract.ts` with one extractor per capability.
- Accept: each tool callable against the fake server; a repeat call is served from cache with zero charge.

### M4: Identity matcher

- `normalize.ts`, `matcher.ts`, alias table, fixtures.
- Accept: `matcher.test.ts` green for every case in section 16.

### M5: Agent loop and orchestrator

- `planner.ts`, `agent.ts`, `prompts.ts`, `orchestrator.ts` with the five phases and deadline handling.
- Accept: fixture-mode end-to-end runs for basic, standard, deep; deadline-hit and budget-exhausted paths produce valid reports.

### M6: Report assembler and API

- `report.ts` with invariants, narrative pass, `api/routes.ts`, `api/schemas.ts`, OpenAPI.
- Accept: `report.test.ts` green; `POST /research` returns a schema-valid report in fixture mode; `GET /docs` renders.

### M7: Live verification and README

- Run against a funded Perflo account with three real subjects at three tiers; record the fixtures from those runs.
- README complete.
- Accept: live totals equal ledger totals equal Perflo's `GET /v1/transactions` for the run; no run exceeds its cap.
- Done 2026-09-08 (`pnpm test:paid`, 5 of 5): basic $0.10, standard about $0.17, deep about $0.50 against a `kyc-research` sub-account capped at $10 per hour; a $0.05 cap refuses without spending, and a nonexistent person returns `not_found`.
  Each run's ledger equalled the posted Perflo transactions once settlement followed the debit rule in section 7, including a run whose vendor task was still running at report time.

## 19. Working rules for agents building this

- Read `CONTEXT.md` and the ADRs before touching a module; use their vocabulary in code, tests, and PR titles.
- One milestone per pull request; do not mix milestones.
- Money is `bigint` micro-dollars everywhere except at the HTTP boundary; a `number` holding money is a bug.
- The LLM never sees raw vendor payloads, never writes an amount, and never assigns an identity score.
- Every Perflo code in section 10 has exactly one behavior; add a test when you add a code.
- Never call `POST /v1/pay` outside `src/research/tools.ts`, and never without a ledger reservation.
- Never add a non-Perflo data source; see ADR-0005.
- Do not add dependencies beyond `package.json` without stating why in the PR.
- Keep each sentence on its own line in Markdown files.
- Do not add an agent name as a commit co-author.
