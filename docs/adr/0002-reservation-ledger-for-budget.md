# ADR-0002: A local reservation ledger guarantees the cap; Perflo envelopes are the backstop

Status: accepted, 2026-09-08.

## Context

The cap is per request and calls run in parallel.
Perflo offers per-call `maxCharge` on `POST /v1/pay/{slug}` and account or sub-account envelopes with hourly, daily, monthly, and total windows.
Perflo's API reference describes sub-accounts as a user surface created by a person in the app, not by an agent mid-payment, and requires an hourly cap whenever any cap is set.
A running-total check (`spent < cap`) is wrong under concurrency: four calls can each pass and together overshoot.

## Decision

Each request has a Spend Guard ledger in integer micro-dollars with `reserve`, `settle`, `release`, and `hold`.
A paid call is allowed only after `reserve(maxChargePerCall)` succeeds atomically against `cap - spent - reserved`.
Every pay call sends `maxCharge` equal to the reservation so Perflo refuses for free anything the ledger did not authorize.
One deployment-wide Perflo agent key pinned to one envelope with an operator-chosen hourly cap bounds total damage from a bug.
Per-request or per-tenant sub-accounts are a later good-to-have.

## Consequences

- Overspend is impossible by construction, including under concurrency and mid-flight deadline cuts.
- The ledger must persist every transition to SQLite before the next network call, and unresolved holds must be reconciled through `GET /v1/transactions`.
- Money is `bigint` micro-dollars everywhere except the HTTP boundary.

## Alternatives rejected

- Per-request Perflo sub-account as the control: two admin-key round trips per request, mandatory hourly window, no reservation for in-flight calls, and contrary to Perflo's stated usage.
- Trusting the model to stay under budget: not verifiable.
