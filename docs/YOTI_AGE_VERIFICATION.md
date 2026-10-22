# EKOOOL Card — Yoti age verification setup

This integration is fail-closed: top-ups over 1,000 RUB stay blocked until the server receives a successful Yoti result.

## Render environment variables

Add these to the existing `ekool-server` service:

- `YOTI_AGE_API_KEY` — secret API key from Yoti Hub.
- `YOTI_AGE_SDK_ID` — SDK ID from Yoti Hub.
- Optional `EKOOOL_PUBLIC_URL` — public HTTPS base URL; defaults to `https://ekool-server.onrender.com`.

Never commit API credentials or put them in browser code.

## Provider configuration

In Yoti Hub, complete onboarding, enable Age Verification / Age Estimation, and register the callback URL:

`https://ekool-server.onrender.com/api/ekoool-card/age-verification/callback`

The integration creates a 15-minute `OVER` session with age-estimation threshold 14, passive capture and automatic authenticity checks. It redirects the user to Yoti and then retrieves the result server-to-server. Only a `COMPLETE` response for the configured threshold and age-estimation method can set `ageVerified=true`. Browser query parameters alone cannot verify age.

## What is stored

EKOOOL stores a session-to-account mapping temporarily, and on success stores a boolean verification status, timestamp, provider name, and opaque reference. It does not accept face images through EKOOOL endpoints. The user's camera capture is handled by Yoti. Expired session records should be cleaned up periodically; no raw biometric media should be logged or stored.

## Before production

1. Confirm Yoti account approval, available methods, pricing, and legal eligibility for the intended countries and age threshold.
2. Review privacy and terms pages with qualified counsel; the included pages are informational drafts.
3. Verify the exact semantics of Yoti's `OVER` threshold for the product requirement. `OVER 14` may mean strictly older than 14, not age 14 inclusive.
4. Test success, failure, cancellation, expiration, API outage, and spoofed callback cases in a provider-approved test setup.
5. Keep the >1,000 RUB server-side block until the provider credentials and full flow are configured and tested.
6. Do not describe the feature as production-ready until the payment flow and verification are independently tested.

Official docs: https://developers.yoti.com/age-verification-api
