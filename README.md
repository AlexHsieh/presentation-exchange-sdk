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

## Configuration status

The SDK processes presentation requests and credentials only when the app configuration status is `testing` or `active`. Configurations in `draft`, `suspended`, or `revoked` status are rejected with `APP_NOT_ACTIVE`.

## Development

```bash
npm install
npm run build
npm test
```

## Wallet submission HTTP responses

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
