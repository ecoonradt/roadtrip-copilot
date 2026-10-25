# ADR-0012: Verified Place Evidence, Not Search-Query Echoes

* **Date:** 2026-10-25
* **Status:** Accepted
* **Deciders:** GPT-6.1 Sol, within the approved M4 review-remediation scope
* **Related Work Package:** [`WP-04`](../plan/active/WP-04-scout-grounding-tools.md)

## 1. Context & Problem Statement

M4 matching used `ResolvedPlaceRecord.query` alongside returned place names/addresses when scoring branch qualifiers. That field is the model's search input, not Google's confirmation. Text Search can return another branch. A local probe requested Lucky Lane, received a West Route 66 address, and still matched the wrong branch solely because the query echoed Lucky Lane. Duplicate-record aggregation also preserved this unsafe evidence.

## 2. Decision Drivers

* Preserve deterministic verified-entity grounding and avoid cross-branch hydration.
* Keep public tool/result interfaces and exact-ID precedence unchanged.
* Preserve repeated evidence without converting an assumption into verification.

## 3. Considered Options

* **A:** Score echoed search inputs as place evidence; this can reinforce the model's original error.
* **B:** Use returned entity fields for branch verification; retain queries as context only.

## 4. Decision Outcome

Choose **B**. Matching must use authoritative returned names/addresses (`display_name`, `place_name`, `address`), not the input `query`. Duplicate groups may combine consistent returned evidence, but search inputs cannot establish a branch match. Existing exact verified-ID matching remains authoritative, including correction of inaccurate model metadata; consistent same-ID duplicates should prefer a complete representative, while conflicting records must not be silently combined. When returned evidence does not disambiguate a candidate, preserve the existing no-match behavior rather than guessing.

Positive: prevents self-confirming wrong-branch matches without a new API or infrastructure. Trade-off: suggestions relying only on search wording may remain unhydrated until better evidence is supplied.

## 5. Implementation Notes & Code Touchpoints

* `route-builder/server/services/scoutTools/geo.ts`: returned-field-only qualifier evidence, including duplicate groups.
* `route-builder/tests/ai/scoutPlaceMatchingFollowup.test.ts`: query-echo rejection and positive authoritative-evidence regressions.
* This does not authorize mock results, fallback routing, new tool schemas, or changes to deployment/Region policy. Other transport, cancellation, and timezone bug fixes stay recorded in WP-04.
