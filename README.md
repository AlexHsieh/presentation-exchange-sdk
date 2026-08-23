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
