<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/multisafepay-logo-dark.png">
    <img src="docs/assets/multisafepay-logo.png" alt="MultiSafepay" width="380">
  </picture>
</p>

<h3 align="center">MultiSafepay for Salesforce B2C Commerce</h3>

<p align="center">
  Payment cartridges that bring the MultiSafepay catalogue, its payment lifecycle and its
  Business Manager tooling to a Storefront Reference Architecture site.
</p>

<p align="center">
  <img alt="SFRA 6.3.0" src="https://img.shields.io/badge/SFRA-6.3.0-00A1E0">
  <img alt="Salesforce B2C Commerce" src="https://img.shields.io/badge/Salesforce-B2C%20Commerce-00A1E0">
  <img alt="MultiSafepay API v1" src="https://img.shields.io/badge/MultiSafepay-API%20v1-00ABEE">
  <img alt="Tests" src="https://img.shields.io/badge/tests-npm%20test-004A71">
</p>

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [After every deploy](#after-every-deploy)
- [Testing](#testing)
- [Scope and known limitations](#scope-and-known-limitations)
- [Documentation](#documentation)

---

## Features

### Checkout

| | |
|---|---|
| **The full MultiSafepay catalogue** | Payment methods are read from the merchant's MultiSafepay account in a single call, with no pre-filtering. Each method's own `allowed_countries`, currencies and amount limits come straight from the API. An empty country list means *available everywhere*. |
| **Filtered on the shopper's billing address** | A method is offered only when it is enabled, allowed for the billing country and the cart currency, within its minimum and maximum amount, and applicable as an SFCC payment method. |
| **Redirect and inline payments** | Card schemes and other inline methods use the MultiSafepay Payment Component directly in the page. The rest redirect to the hosted MultiSafepay payment page and return the shopper to the store. |
| **Gift certificates** | Gift certificates can be applied at checkout. The remaining balance is charged to the selected MultiSafepay method. |
| **Cart restored on cancellation** | A shopper who cancels on the payment page returns to a full basket and can try again. |
| **Discreet failure handling** | Configuration problems show the shopper one generic message. The cause goes only to the log. |
| **European address form** | The checkout covers the EU/EEA markets plus UK, CH, US and CN, so methods restricted to a country can be reached by real shoppers. |

### Payment lifecycle

| | |
|---|---|
| **Signed webhooks** | Status notifications are verified with HMAC-SHA512 over `timestamp:body`. Unsigned or tampered notifications are rejected. |
| **Status mapping** | `completed` and `shipped` confirm and pay the order. `declined`, `expired`, `cancelled` and `void` fail it. Refund statuses update the payment status once MultiSafepay confirms the refund. |
| **Manual capture** | Authorise at checkout and capture later from Business Manager. Capture applies only to methods the account reports as both supported and enabled for manual capture. The capture expiry is stored on the order and shown in the order detail. |
| **Refunds** | Full and partial refunds can be made from the order detail. A partial refund leaves the order *Paid* and shows the amount refunded separately. |
| **BNPL shipment notification** | The `custom.MSP.NotifyShipments` job step tells MultiSafepay which orders have shipped (`PATCH /orders/{id}`, with tracking code, carrier and ship date). Klarna, Riverty, Billink and in3 can then invoice. A failure ends the job in `ERROR` and names the order, so it cannot pass for a successful run. |

### Business Manager

| | |
|---|---|
| **Settings page** | Choose the test or live environment and enter the API keys. Manual capture, card grouping and the OMS option are configured on the same page. |
| **Sync & Import** | One click rebuilds the catalogue as `MSPPaymentMethod` custom objects and generates the payment-methods archive. If OCAPI is configured, it also starts `MSP-ImportPaymentMethods`, which keeps *Ordering → Payment Methods* aligned. Methods MultiSafepay no longer offers are disabled. A sync that returns nothing never wipes the configuration. |
| **Per-method control** | Each method can be switched on or off. Badges show which methods are **Inline** and which support **Capture** on this account. |
| **Order detail** | A MultiSafepay box on each order shows the MultiSafepay status in colour, the financial status, the payment breakdown, the capture state and expiry, the refunded amount, and the Capture and Refund actions. |
| **Transactions dashboard** | *Analytics → Multisafepay dashboard* shows today's and total transactions and refunds, with 7-day trends, read live from the active environment. |

### Security

- The API key never reaches the browser. The Payment Component receives short-lived tokens (600 s) issued on the server.
- The checkout and Business Manager endpoints are protected with CSRF tokens and served over HTTPS only.
- A live environment never falls back to the test key.

---

## Architecture

```
multisafepay : bm_multisafepay : app_storefront_base : bm_app_storefront_base : modules
```

| Cartridge | Role |
|---|---|
| **`multisafepay`** | Storefront: controllers, payment hooks, the order payload, the webhook, checkout templates and JS, and the shipment job |
| **`bm_multisafepay`** | Business Manager: settings, Sync & Import, the dashboard, and capture and refund in the order detail |
| `app_storefront_base`, `bm_app_storefront_base`, `modules` | Salesforce SFRA 6.3.0, never modified |

Key files:

| Path | What lives there |
|---|---|
| [`multisafepayHelper.js`](cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js) | MultiSafepay API calls, and `mapApiPaymentMethod`, the one place where the API contract is interpreted |
| [`transactionData.js`](cartridges/multisafepay/cartridge/models/transactionData.js) | The order payload sent to MultiSafepay |
| [`webhookHelper.js`](cartridges/multisafepay/cartridge/scripts/helpers/webhookHelper.js) | Signature check, status mapping, capture-expiry persistence |
| [`notifyShipments.js`](cartridges/multisafepay/cartridge/scripts/jobs/notifyShipments.js) | The BNPL shipment notification job |
| [`MultisafepaySettings.js`](cartridges/bm_multisafepay/cartridge/controllers/MultisafepaySettings.js) | Settings page, sync, payment-methods XML, OCAPI import trigger |
| [`PaymentInstrumentInfo_MultiSafepayPayment.isml`](cartridges/bm_multisafepay/cartridge/templates/default/order/PaymentInstrumentInfo_MultiSafepayPayment.isml) | The order-detail box: status, breakdown, capture and refund |
| [`metadata/site-import`](metadata/site-import) | Site preferences, custom attributes, the custom object and the service definitions |

---

## Installation

1. `npm install`, then create a `dw.json` in the project root with `hostname`, `username`,
   `password` (a WebDAV access key) and `code-version`. The file is gitignored.
2. Build the connector's storefront assets and upload the two MultiSafepay cartridges:
   ```
   npm run build
   npx sgmf-scripts --uploadCartridge multisafepay
   npx sgmf-scripts --uploadCartridge bm_multisafepay
   ```
   `npm run build` compiles the client code of `multisafepay` only. The SFRA base
   cartridges (`app_storefront_base`, `bm_app_storefront_base`, `modules`) must already be
   built and deployed on the instance, as on any SFRA site. An upload replaces the whole
   cartridge on the instance.
3. Add `multisafepay` and `bm_multisafepay` to the cartridge paths, ahead of the base
   cartridges, as shown in [Architecture](#architecture).
4. Import [`metadata/site-import`](metadata/site-import) as a ZIP under
   *Administration → Site Development → Site Import & Export*.
5. Open the **Multisafepay settings** page, enter the API keys and click **Sync & Import**.
6. *(BNPL)* Create a job with the `custom.MSP.NotifyShipments` step and schedule it per site.

The step-by-step guide, including OCAPI and the job, is in the
[Platform User Guide](docs/platform%20user%20guide.md).

## After every deploy

1. Import the metadata.
2. Re-run **Sync & Import**.
3. Confirm in *Job History* that **`MSP-ImportPaymentMethods`** finished OK.

The third step applies the synchronised country lists to the `MSP_*` payment methods. If it
is skipped, the checkout keeps the old restrictions and a correct fix looks as though it
has not worked.

---

## Testing

```
npm test
```

The MultiSafepay suite runs on Node's built-in test runner with no extra dependencies, in
under a second. It covers the payment-method mapper against a real catalogue captured from
the MultiSafepay API, sync, checkout applicability, the order payload, the HTTP verbs and
payloads sent to MultiSafepay, the shipment job, and contract tests on the storefront and
Business Manager templates.

The same suite runs in CI on every push and pull request
([`.github/workflows/test.yml`](.github/workflows/test.yml)), on Node 22 and 24.

> The original SFRA unit suite is still available as `npm run test:sfra`. It does not
> cover MultiSafepay code.

---

## Scope and known limitations

- **Not yet included:** recurring payments and POS / omnichannel (SmartPOS, C-TAP).
  Both are planned for a later release.
- The payment-method list is built when the billing step loads. Changing the billing
  country inside the form takes effect when the step is submitted.

---

## Documentation

| Document | For |
|---|---|
| [Platform User Guide](docs/platform%20user%20guide.md) | Merchants and operators: setup, sync, capture, refunds, the BNPL job, troubleshooting |
| [Technical Documentation](docs/technical%20documentation.md) | Developers: payment flow, components, metadata, API reference |
| [Test Checklist](docs/test-checklist.md) | End-to-end validation scenarios |

<p align="center"><sub>Built on Salesforce Storefront Reference Architecture 6.3.0.</sub></p>
