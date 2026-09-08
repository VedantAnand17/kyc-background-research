# Domain context: background research

Single bounded context.
Read this before touching code; use these words, not synonyms.

## Glossary

- **Subject**: the person the caller asked about, exactly as supplied in the request.
  Not "target", not "user".
- **Cap**: the caller's maximum budget for one request, in micro-dollars.
  Not "limit", which is Perflo's word for envelope windows.
- **Tier**: `basic`, `standard`, or `deep`, derived from the Cap; decides which Tools are offered.
- **Reserve**: the 10 percent of the Cap held back for disambiguation; unspent unless needed.
- **Tool**: a capability the LLM can call, such as `find_people`.
  Tools are not vendors.
- **Capability**: the abstract kind of lookup a Tool performs, and the key of the capability map.
- **Vendor**: a Perflo marketplace service identified by a slug, such as `stableenrich-minerva-resolve`.
  The LLM never sees vendor slugs.
- **Contract**: what `GET /v1/vendors/{slug}` returns for a Vendor: price, `maxChargePerCall`, payable flag, and field placement.
- **Quote**: the `maxChargePerCall` from a Contract; the amount the Spend Guard reserves.
  Never `price`.
- **Reservation**: a Spend Guard hold on part of the Cap for one paid call; moves to settled, released, or held.
- **Spend Guard**: the ledger that approves or denies reservations.
  The only component that can authorize a paid call.
- **Paid call**: one `POST /v1/pay/{slug}` request.
  A paid call may be charged even when the vendor reports failure.
- **Source**: the stored record of one paid call: vendor, capability, purpose, raw payload, extracted facts, charge.
  Every fact in a report cites Source ids.
- **Candidate**: one possible identity for the Subject, produced by resolve and scored by the Matcher.
- **Primary candidate**: the single Candidate whose Sources may populate the profile; exists only when identity status is `confirmed` or `probable`.
- **Matcher**: the deterministic identity scorer.
- **Confidence**: the Matcher's 0 to 1 score for a Candidate.
- **Label**: `confirmed`, `probable`, or `possible`, derived from Confidence.
- **Conflict**: a signal where a Candidate contradicts the Subject (different DOB, different city) or two Sources contradict each other about the Primary candidate.
- **Adverse media**: news or web hits matching risk terms about the Subject's name.
- **Watchlist**: a PEP or sanctions screening vendor.
  Today the Perflo catalog lists none; the status is then `not_screened`.
- **Report**: the single JSON document returned to the caller, validated against the report schema.
- **Warning**: a coded, human-readable entry in the Report naming something that could not be verified or a step that did not run.
- **Deadline**: the wall-clock limit for one request; hitting it cuts phases short but still produces a Report.
- **Fixture mode**: running against recorded vendor responses, spending nothing.

## Words to avoid

- "KYC check" for the whole product; the product is research, not a regulated verification.
- "Match" as a verb for merging two people; say "label as confirmed" or "select the primary candidate".
- "Price" when you mean Quote.
- "Budget" when you mean Cap; "budget" alone is acceptable in prose about the concept, not in code.

## Invariants

- Spent plus reserved never exceeds the Cap.
- No fact appears in a Report without at least one Source id.
- Profile facts come only from the Primary candidate.
- The LLM decides what to buy; code decides whether we can afford it, which Vendor, and who the Subject is.
