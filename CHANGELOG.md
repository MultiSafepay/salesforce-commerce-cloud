# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-06

First stable release of the MultiSafepay connector for Salesforce B2C Commerce, built on
the Storefront Reference Architecture (SFRA) 6.3.0.

### Added

- Checkout: the payment methods of the merchant's MultiSafepay account, read from
  `/payment-methods` in a single unfiltered call, with each method's allowed countries,
  currencies and amount limits applied at checkout. A method with no country restriction
  (`allowed_countries: []`) is offered in every country.
- Checkout: inline payments through the MultiSafepay Payment Component for methods that
  support it (such as cards), falling back to a redirect when a direct request is not
  accepted; redirect payments through the MultiSafepay payment page for the others.
- Checkout: Salesforce gift certificates combined with a MultiSafepay method, which is
  charged the remaining balance.
- Checkout: the basket is restored when the shopper cancels on the payment page.
- Notifications: webhooks verified with HMAC-SHA512, mapping MultiSafepay statuses to the
  Salesforce order and payment status, including partial and full refunds.
- Manual capture: authorise at checkout and capture the full amount later from the order
  detail in Business Manager, for methods the account supports and enables for capture;
  the capture expiry is stored on the order.
- Refunds: full and partial refunds from the order detail in Business Manager.
- BNPL: the `custom.MSP.NotifyShipments` job step, which notifies MultiSafepay of shipped
  orders (`PATCH /orders/{id}` with track-and-trace code, carrier and ship date) so that
  Klarna, Riverty, Billink and in3 can invoice.
- Business Manager: the **Multisafepay settings** page (environment, test and live API
  keys, manual capture, card grouping), **Sync & Import** of the payment methods into the
  `MSPPaymentMethod` custom objects and the `MSP_<gateway>` payment methods, per-method
  enable/disable, and the order-detail box with status, payment breakdown, capture and
  refund.
- Business Manager: the **Multisafepay dashboard** with transactions, refunds and 7-day
  trends for the active environment.
- Metadata for Site Import & Export: site preferences, custom attributes, the
  `MSPPaymentMethod` custom object, the service definitions and the
  `MSP-ImportPaymentMethods` job.
- `npm run build` and `npm run upload`: a build of the storefront assets with esbuild and
  Sass, and a WebDAV upload of the two cartridges, needing only Node.js 22 or later.
- A connector test suite on Node's built-in test runner (`npm test`), run in CI on Node 22
  and 24.

### Security

- Replaced the SFRA `sgmf-scripts` build toolchain (webpack 4, `dwupload`, `request`) and
  removed the unused SFRA lint toolchain (ESLint 3, Stylelint 13, isml-linter, Husky). This
  resolves every open Dependabot alert, including advisories that have no patched release
  (`request`, `elliptic`); `npm audit` reports no vulnerabilities. All of them were in
  build-time development dependencies; none was deployed to the instance.

### Known limitations

- Recurring payments and POS / omnichannel are not included.
- The payment-method list is built when the checkout page loads and is not refreshed
  while the shopper enters or changes an address.

[Unreleased]: https://github.com/MultiSafepay/salesforce-commerce-cloud/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MultiSafepay/salesforce-commerce-cloud/releases/tag/v1.0.0
