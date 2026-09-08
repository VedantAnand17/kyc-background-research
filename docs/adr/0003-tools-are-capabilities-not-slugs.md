# ADR-0003: Tools are capabilities, not vendor slugs, and not Perflo's task route

Status: accepted, 2026-09-08.

## Context

Perflo exposes about 550 vendors by slug and two ways to spend: `POST /v1/pay/{slug}` for a vendor you chose, and `POST /v1/tasks` where Perflo picks the vendor from a natural-language task.
`POST /v1/tasks` has no per-call `maxCharge`; only envelope windows bound it.
Exposing raw slugs to a model invites hallucinated slugs, gives no fallback, and asks the model to learn a catalog.

## Decision

The LLM sees about a dozen capability tools with Zod argument schemas.
The tool layer maps each capability to an ordered vendor list, quotes the live contract, picks the first payable vendor that fits remaining headroom, dedupes on `(tool, canonical args)`, and places fields per the contract's `in`.
`web_search` and `screen_watchlist` vendors are discovered at run time through `POST /v1/search`.
`POST /v1/tasks` is not used in the must-have release.

## Consequences

- Vendor choice, fallback, dedupe, and request shaping are testable code.
- Adding a vendor is a one-line change to the capability map.
- The interview can show explicit tool selection rather than delegating it to Perflo.

## Alternatives rejected

- Raw slugs as tools: hallucination risk, no fallback.
- `POST /v1/tasks` as the primary spend path: no per-call ceiling and no visible tool selection of our own.
