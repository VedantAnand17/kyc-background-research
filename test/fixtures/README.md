# Fixtures

Recorded Perflo responses used by fixture mode (`FIXTURE_MODE=true`) and by tests.

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
