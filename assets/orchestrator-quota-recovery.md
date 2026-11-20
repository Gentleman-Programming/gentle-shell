# Temporary verifier quota recovery

Parent only: load after an identified verifier quota failure when the human explicitly requests the missing verification.

A temporary verifier quota failure with no verdict still ends the automatic cycle. After the human reports restored availability and explicitly requests the missing verification, allow one new bounded attempt for the same candidate. Preserve the failed attempt and still-valid passed checks; do not replay passed suites. Confirm no child is active or uncertain. This is not an automatic retry, provider/model fallback, or reset of correction/native budgets. Consent, denials, explicit one-run/no-retry limits and terminal native outcomes remain binding; failure never counts as approval.
