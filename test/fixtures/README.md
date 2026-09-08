# Fixtures

Recorded Perflo responses for fixture mode (`FIXTURE_MODE=true`).
They are not recorded yet; that is M7 work.
Until then, `FIXTURE_MODE=true` at runtime has no vendor payloads to serve.
Tests inject `test/fake-perflo.ts` instead of these files.
Identity-matcher cases live in `identity.ts` and are loaded by `test/matcher.test.ts`.

Layout, one file per vendor and scenario:

```
test/fixtures/
  vendors/<slug>.contract.json          GET /v1/vendors/{slug} response
  pay/<slug>/<scenario>.json            POST /v1/pay/{slug} response (succeeded, failed, ...)
  search/<query-slug>.json              POST /v1/search response
  subjects/<name>.json                  a full request plus the expected report shape for e2e tests
```

Record fixtures from real runs in M7 and scrub anything personal before committing.
Fixtures MUST carry the `charged` amounts they were recorded with so fixture-mode ledgers stay realistic.
