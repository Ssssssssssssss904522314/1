# EKOOOL Card — prototype status

## Implemented in this branch
- Internal, closed-loop wallet record stored in the existing EKOOOL key-value database.
- On-demand card identifier with the requested `5112` prefix. This is **not** a bank-issued card number, PAN, or Mastercard/Visa credential.
- Authenticated card summary and recent internal transactions.
- A prototype page at `/card.html`, linked from the messenger UI.
- Server-side gate: requests above 1,000 RUB are refused unless the stored card record has a provider-confirmed `ageVerified: true` status.
- Internal purchase debit endpoint with a PostgreSQL row lock when PostgreSQL is configured.
- Age-verification endpoint deliberately fails closed until a real provider is configured.
- BANKA top-up endpoint deliberately fails closed until BANKA's documented create-payment contract and webhook settlement are integrated. It never credits the balance from a client request.

## Not production-ready
- The existing BANKA create-payment endpoint accepts `productType: 'card_topup'` for amounts from 1 to 100,000 RUB, checks the card status and enforces the 1,000 RUB age-verification gate.
- The BANKA settlement webhook credits the internal card ledger only for a valid signed `payment.paid` event whose order ID, payment ID, currency, and amount match the stored order. PostgreSQL mode locks the order and card rows and records a per-order ledger transaction; duplicate events do not credit twice.
- The card page redirects to the BANKA payment URL. The balance is never credited from the browser.
- Age verification is **not yet active**. No selfie or AI age-estimate is accepted from the browser. Select and configure an age-verification provider with liveness and a documented callback/verification API before enabling the >1,000 RUB limit.
- Internal purchase endpoint is a technical primitive, not yet connected to the actual Premium/store checkout catalogue. Callers must only pass server-authorized item IDs and prices; do not expose it as an unrestricted client-priced purchase endpoint.
- The JSON-file fallback cannot provide robust atomic concurrent spending. Production money-like balances must use PostgreSQL transactions.
- No cash withdrawal, external merchant payments, card-network processing, or bank-card issuance is provided.
- Legal/payment-provider rules for minors and privacy/biometric processing must be reviewed before release.

## Routes
- `GET /api/ekoool-card`
- `POST /api/ekoool-card/topup` — currently returns a safe 503 until provider contract is integrated.
- `POST /api/ekoool-card/age-verification/start` — currently returns a safe 503 until provider configured.
- `POST /api/ekoool-card/purchase` — internal purchase debit primitive; must be wired only to trusted server-side catalogue prices.

The BANKA payment creation/settlement path is wired to the existing provider integration, but has not yet been verified with a live payment. The >1,000 RUB limit remains blocked until a real age-verification provider is integrated. Do not describe age verification as active.
