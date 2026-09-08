# Fixtures

Recorded Perflo responses for fixture mode (`FIXTURE_MODE=true`).
Recorded by `pnpm test:paid` on 2026-09-08 from funded runs on public figures, with contact details scrubbed; a missing path is recorded on the next paid run.
Unit tests inject `test/fake-perflo.ts` instead of these files so they can script failures.
Identity-matcher cases live in `identity.ts` and are loaded by `test/matcher.test.ts`.

Layout, one file per vendor and scenario:

```
test/fixtures/
  vendors/<slug>.contract.json          GET /v1/vendors/{slug} response
  pay/<slug>/<scenario>.json            POST /v1/pay/{slug} response (succeeded, failed, ...)
  search/<query-slug>.json              POST /v1/search response
  subjects/<name>.json                  a full request plus the expected report shape for e2e tests
```

Scrub anything personal before committing a new recording.
Fixtures MUST carry the `charged` amounts they were recorded with so fixture-mode ledgers stay realistic.
