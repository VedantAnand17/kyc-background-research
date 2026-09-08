# ADR-0005: Perflo is the only data source; PEP and sanctions report `not_screened` when no vendor exists

Status: accepted, 2026-09-08.

## Context

The brief requires PEP and sanctions coverage and requires lookups to go through Perflo's marketplace.
The unlocked Perflo catalog, checked on 2026-09-07, lists no dedicated PEP, OFAC, or sanctions screening vendor.
A free non-Perflo source such as OpenSanctions could fill the gap but would introduce a second integration path, a second trust model, and a claim the brief did not ask for.

## Decision

Perflo is the only external data source.
`screen_watchlist` searches the live catalog at run time for a payable watchlist vendor and uses one if found.
When none is found, `risk.pep.status` and `risk.sanctions.status` are `not_screened`, a coded warning explains why, and `risk.overall` is computed without them.
The service never reports `clear` for a category it did not screen and never fabricates a hit.
Adverse media through news and web search covers fraud and reputational risk.

Decided by the owner on 2026-09-08 when offered an OpenSanctions fallback: "no opensanction fallbacks, just perflow only service".

## Consequences

- One integration, one credential, one place to audit spend.
- The report is honest about a real catalog gap; interviewers see it stated, not hidden.
- If Perflo adds a watchlist vendor, the runtime search picks it up with no code change.

## Alternatives rejected

- OpenSanctions or another free API as a labeled fallback: rejected by the owner.
- Reporting `clear` when no vendor exists: a false negative in a compliance context.
