# Presentation Exchange SDK

Server-side SDK for integrating iAMHuman personhood credentials.

## Install

```bash
npm install @iamhuman.link/presentation-exchange-sdk
```

## Documentation

Follow the iAMHuman developer documentation for integration:

- [Add the SDK and load configuration](https://developer.iamhuman.link/docs/v1/personhood-credential-integration/add-sdk-and-load-config)
- [Create a presentation request](https://developer.iamhuman.link/docs/v1/personhood-credential-integration/create-request)
- [Submit and verify](https://developer.iamhuman.link/docs/v1/personhood-credential-integration/submit-and-verify)

## Configuration status

The SDK processes presentation requests and credentials only when the app configuration status is `testing` or `active`. Configurations in `draft`, `suspended`, or `revoked` status are rejected with `APP_NOT_ACTIVE`.

## Development

```bash
npm install
npm run build
npm test
```

## What's new in 1.2.0

`verifySubmission()` now returns `holderId`, the opaque identifier carried in the
presentation's `holder` field. It may be a DID. `walletDid` remains the DID used to
sign the presentation and can differ from `holderId`.

Use `holderId` in new integrations. `holderDid` remains an identical, deprecated
alias throughout SDK 1.x and will be removed in 2.0. This change does not alter
identifier values or the presentation and credential formats.

## What's new in 1.1.0


### Wallet submission HTTP responses

Version 1.1.0 exports `PresentationSubmissionSuccessResponse`,
`PresentationSubmissionErrorResponse`, and the union `PresentationSubmissionResponse`.
These types describe application HTTP responses; `verifySubmission()` still returns
`VerifiedPresentation` for the application to persist and authorize.

Return HTTP **200 or 201** with `{ ok: true, recordId: "<persisted result ID>" }`
only after verification and required persistence succeed. `recordId` is required
for backend integrations. Current wallets temporarily accept its omission/null;
a future wallet release will require it.

`status?: "verified"` is deprecated and will be removed in a future release.
Existing integrations should continue returning it during the transition because
older wallets require it when decoding. Updated wallets use HTTP 200/201 and
`ok === true`, and do not depend on `status`.

Return HTTP **4xx/5xx** with `{ ok: false, error: { code, message } }` on failure.
`message` is a safe string, not internal verification details or a language map.
Optional retry metadata and application-specific response extensions are allowed.
A `recordId` identifies the application's persisted result; it is not proof of validity.

### Shared submission error codes (1.1.0)

```ts
import {
  PresentationSubmissionErrorCode as Codes,
  createPresentationSubmissionError,
  classifyPresentationSubmissionError,
} from '@iamhuman.link/presentation-exchange-sdk';

// Session state is application-owned.
res.status(410).json(createPresentationSubmissionError(Codes.SESSION_EXPIRED));

// In a verification catch block, keep diagnostic details on the server.
const failure = classifyPresentationSubmissionError(error);
res.status(failure.status).json(createPresentationSubmissionError(failure.code));
```

`classifyPresentationSubmissionError` maps typed SDK errors to `{ code, status }`;
unknown exceptions become `INTERNAL_ERROR`/500. `classifyPresentationCredentialState`
classifies a second credential-state check and returns `undefined` for accepted
state. Unknown status is unavailable, not proof of revocation. Diagnostic SDK codes
remain separate from application HTTP response codes. Credential expiry now throws
the distinct SDK code `CREDENTIAL_EXPIRED`; request expiry retains its request code.

| Code | Typical HTTP status | Meaning and client handling |
| --- | --- | --- |
| `INVALID_INPUT` | 400, 413, 415 | Body is malformed, too large, or has an unsupported format. Correct the request. |
| `SESSION_NOT_FOUND` | 404 | Verification request was not found. Start a new request. |
| `SESSION_EXPIRED` | 410 | Verification request expired. Obtain a new request. |
| `SESSION_NOT_PENDING` | 409 | Request can no longer accept a submission. Start a new request; do not assume a previous submission succeeded. |
| `REQUEST_MISMATCH` | 400, 403, 409 | Submission does not match the stored request. Obtain the current request; do not reuse stale request fields. |
| `INVALID_PRESENTATION` | 400, 422 | Presentation could not be verified. Do not grant access. |
| `CREDENTIAL_EXPIRED` | 400, 422 | Credential expired. Obtain a current credential. This differs from request expiry. |
| `CREDENTIAL_REVOKED` | 400, 422 | Credential was revoked. Obtain an accepted credential. |
| `CREDENTIAL_NOT_ACCEPTED` | 400, 422 | Credential does not meet the app’s issuer, type, attributes, lifetime, or status requirements. |
| `RATE_LIMITED` | 429 | Too many requests. Respect `Retry-After` and any `retryAfterSeconds`. |
| `SERVICE_UNAVAILABLE` | 503 | Verification could not finish because a required service is unavailable. This is not a credential rejection. |
| `INTERNAL_ERROR` | 500 | An unexpected server failure prevented completion. Do not assume verification or persistence succeeded. |

Use the SDK’s `PresentationSubmissionErrorCode` constants directly in `error.code`.
The SDK response helper supplies safe English messages. No additional `reason` field is needed.

Stable codes let Credential Wallet and other clients select accurate localized messages
and handling without parsing English server text. For example, `SESSION_EXPIRED` can
map to “驗證請求已過期，請重新取得驗證請求。” while `CREDENTIAL_EXPIRED` needs a
different message about renewing the credential. Credential Wallet currently displays
the server message; code-based English/Traditional Chinese localization is a separate
follow-up, enabled by this contract.

Use shared codes for common failures. Application-specific conditions, such as
VoteApp’s `VOTE_NOT_OPEN`, may keep an application-specific code. For an unknown
code, clients must show a generic localized failure and must not treat it as success.
Keep `message` a safe string; never copy raw SDK errors, credential attributes,
cryptographic details, or server exceptions into the response.

`retryable`, `retryAfterSeconds`, and `Retry-After` remain optional. An unavailable
service does not establish an invalid credential and should not terminally reject a
pending request. Retrying still requires a live, pending session. Do not automatically
retry after a persistence failure or uncertain write; first check application state
or start a new request as appropriate. A response code never grants access by itself.

## Public issuer information and official card

Fetch public issuer display information without registration, cookies, or API tokens:

```http
GET /api/v1/issuers?did=<URL-encoded-issuer-DID>
```

Use the registry base URL `https://stage.developer.iamhuman.link/appregistry` for stage and `https://developer.iamhuman.link/appregistry` for production. Local PEP uses `http://localhost:8090`. PEP supports the configured I Am Human issuer DID for its deployment; development and stage return `https://stage.iamhuman.link` as the issuer website, and production returns `https://iamhuman.link`.

Success is `{ ok: true, issuer }`. The issuer contains `did`, `environment`, `name`, `description`, `iconUrl`, `websiteUrl`, `defaultLocale: "en"`, and `localizations["zh-Hant"]` with translated name and description. The complete HTTPS Firebase Storage `iconUrl` is authoritative: preserve its path and query parameters. No Firebase package or login is required. Metadata is cached for five minutes; versioned icons are cached for one year.

Missing, repeated, or malformed DID input returns HTTP 400 `INVALID_INPUT`. Unknown and other-environment DIDs return HTTP 404 `ISSUER_NOT_FOUND`. Errors use `{ ok: false, error: { code, message } }`.

### Fetch from either SDK

Both `@iamhuman.link/presentation-exchange-sdk` (server) and `@iamhuman.link/presentation-exchange-vue` (Vue browser) export the same helper and `IssuerMetadata` type:

```ts
import { fetchIssuerMetadata } from '@iamhuman.link/presentation-exchange-vue';

const issuer = await fetchIssuerMetadata({
  did: issuerDid, // the public credential issuer DID
  registryBaseUrl: 'https://stage.developer.iamhuman.link/appregistry',
});
```

Use the backend package import for server-side fetching. The helper returns `null` for `ISSUER_NOT_FOUND`. Catch `IssuerMetadataError` for `INVALID_INPUT`, `FETCH_FAILED` (including timeout or cancellation), and `INVALID_RESPONSE`. Requests time out after five seconds; pass an optional `signal` for cancellation. Apps own loading, retry, and error messages. The registry URL must come from trusted application configuration, not user input.

### Vue card

```ts
import { IssuerBanner } from '@iamhuman.link/presentation-exchange-vue';
import '@iamhuman.link/presentation-exchange-vue/style.css';
```

```vue
<IssuerBanner v-if="issuer" :issuer="issuer" locale="zh-Hant" />
```

Use `locale="en"` for English. Unsupported locales fall back to English. Override interface text through `labels`, with `issuer` and `website` keys. Metadata comes from PEP; the component does not fetch it or make verification decisions.

### Other frameworks and plain HTML

Call the HTTP API directly or render metadata fetched by your server. For example, given validated `issuer` metadata and existing `icon`, `name`, `description`, and `link` DOM elements:

```js
icon.src = issuer.iconUrl;
icon.alt = '';
name.textContent = issuer.name;
description.textContent = issuer.description;
link.href = issuer.websiteUrl;
link.textContent = 'Visit issuer website';
link.target = '_blank';
link.rel = 'noopener noreferrer';
```

Validate HTTPS image/link URLs before using raw HTTP responses. Render text through `textContent`, never `innerHTML`. Hide failed icons and keep the issuer name visible. For Traditional Chinese, use `issuer.localizations['zh-Hant']` with the English values as fallback.

Allow your configured PEP origin in `connect-src` and `https://firebasestorage.googleapis.com` in `img-src`. Also allow the storage origin in `connect-src` if downloading image bytes with `fetch`; this requires Storage CORS. Displaying the URL in an image element lets the browser retrieve it directly.

Issuer metadata and the banner are public display information. They do not prove that an app or person has been verified. Keep credential signatures, trusted issuer policy, status checks, and authorization on the backend. Direct requests expose ordinary network information to PEP and Storage; use backend fetching where appropriate. Never send signing secrets or credential JWTs to this API.
