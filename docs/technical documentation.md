# Technical Documentation — MultiSafepay Integration for SFCC (SFRA)

> Integration of the **MultiSafepay** Payment Service Provider into the
> **Salesforce B2C Commerce** platform based on **Storefront Reference Architecture (SFRA 6.3.0)**.

---

## 1. Overview

The project is a standard SFRA installation extended with the MultiSafepay payment
integration (hereinafter **MSP**). The integration enables:

- Dynamic display of the available MSP payment methods at checkout, filtered by
  country, currency and locale.
- Payment in both **redirect** mode (MSP-hosted payment page) and **direct** mode
  (inline card data entry via the MSP *Payment Component SDK*).
- Asynchronous order-status notifications via HMAC-SHA512-signed **webhook**.
- Management from the **Business Manager**: payment-method synchronization/import,
  transactions dashboard, manual capture and refunds.
- Support for **BNPL** (Buy Now Pay Later), Gift Certificates and Salesforce OMS.

### Technology stack

| Component | Technology |
|---|---|
| Platform | Salesforce B2C Commerce (Demandware) |
| Storefront framework | SFRA 6.3.0 (`app_storefront_base`) |
| Server-side runtime | Rhino JavaScript (`dw.*` API) |
| Client-side | jQuery, Bootstrap 4/5, MultiSafepay JS SDK |
| Build | `sgmf-scripts`, Webpack, SCSS |
| Testing | Mocha + Chai (unit), CodeceptJS (acceptance) |
| MSP API | REST JSON v1 (`/v1/json/`) |

---

## 2. Cartridge structure

The site's cartridge path must load the custom cartridges **before** the base ones,
so the overrides take precedence. Typical order:

```
multisafepay : bm_multisafepay : app_storefront_base : bm_app_storefront_base : modules
```

| Cartridge | Role |
|---|---|
| `app_storefront_base` | SFRA base provided by Salesforce — **never modified directly**. |
| `bm_app_storefront_base` | SFRA Business Manager base. |
| `modules` | Shared SFRA modules (`server`, `*/cartridge/scripts/util/collections`, etc.). |
| **`multisafepay`** | Custom storefront cartridge: controllers, payment hooks, models, helpers, templates and MSP checkout JS. |
| **`bm_multisafepay`** | Custom Business Manager cartridge: settings page, dashboard, capture/refund from order detail. |

The project's custom files reside almost entirely in `cartridges/multisafepay` and
`cartridges/bm_multisafepay`. The other folders in `multisafepay/cartridge/client` and
`static` are overrides of SFRA assets to enable the MSP checkout styles.

---

## 3. Payment flow architecture

### 3.1 Sequence diagram (high level)

```
Shopper            Storefront (multisafepay)          MSP API                 Webhook
   │  Checkout          │                                │                       │
   │───────────────────>│ Multisafepay-GetPaymentMethods │                       │
   │                    │───────────────────────────────>│ GET /payment-methods  │
   │  method list <─────│<───────────────────────────────│                       │
   │  select method     │                                │                       │
   │  (if card) ───────>│ Multisafepay-GetComponentToken │                       │
   │                    │───────────────────────────────>│ GET /auth/api_token   │
   │  Place Order ─────>│ CheckoutServices-PlaceOrder     │                       │
   │                    │  createOrder (SFCC)             │                       │
   │                    │  Authorize hook                 │                       │
   │                    │───────────────────────────────>│ POST /orders          │
   │                    │<── payment_url ─────────────────│                       │
   │  redirect to MSP <─│                                │                       │
   │  pay on MSP ────────────────────────────────────────>│                       │
   │                    │                                │  status=completed ───>│ Multisafepay-Webhook
   │                    │<───────────────────────────────────────────────────────│ (place + PAID + email)
   │  redirect_url ─────│ Multisafepay-Confirm            │                       │
   │  order confirmed <─│                                │                       │
```

### 3.2 Phases in detail

1. **Method loading** — At checkout the billing template `Multisafepay.isml` renders the
   payment methods server-side from the **synchronized `MSPPaymentMethod` Custom Objects**
   via `getApplicableMSPMethods()` (see §4.4). The methods are the most recent sync snapshot,
   filtered by enabled flag, country, currency, amount and the SFCC `Ordering > Payment
   Methods` gate. Before rendering, the active API key is validated (see *Invalid API key*
   in §12): an invalid key hides all methods and blocks checkout. The
   `Multisafepay-GetPaymentMethods` controller (live API) still exists but is **not** used by
   the current checkout flow.

2. **Method selection** — The `msp_checkout.js` JS handles radio selection. For methods
   flagged `data-requires-component="true"` it initializes the **MultiSafepay Payment
   Component**, obtaining an ephemeral token via `Multisafepay-GetComponentToken`. The flag
   comes from the API `payment_components.has_fields && is_enabled` captured at sync time
   (see §12 item 5 for the `group_cards` interaction).

3. **Place Order** — `CheckoutServices-PlaceOrder`:
   - Creates the SFCC order in `CREATED` status.
   - Calls `COHelpers.handlePayments()`, which invokes the
     `app.payment.processor.multisafepaypayment` hook → **`Authorize`** function.
   - `Authorize` builds the payload via the `transactionData` model and calls
     `POST /orders` on MSP.
     - **Direct mode**: if the client captured `payment_data` from the Payment Component,
       it is sent with `type: 'direct'`. On failure there is an **automatic fallback** to
       `type: 'redirect'`.
     - **Redirect mode**: MSP returns a `payment_url`.
   - The `payment_url` is returned to the client, which redirects to it.
     The order is **not** yet placed (`placeOrder`) if a `redirectUrl` exists.

4. **Payment on MSP** — The shopper completes the payment on the MSP-hosted page.

5. **Webhook** — MSP notifies the status to `Multisafepay-Webhook` (POST). The HMAC signature
   is verified; based on the `status`, the order is placed/confirmed/cancelled/refunded.

6. **Confirm / Cancellation** — The shopper is redirected to `Multisafepay-Confirm`
   (success) or `Multisafepay-Cancellation` (cancellation → recreates the basket from the order).

---

## 4. Server-side components (`cartridges/multisafepay`)

### 4.1 Controllers

#### `controllers/Multisafepay.js`
`Multisafepay` namespace. Main endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `Multisafepay-GetPaymentMethods` | GET | Returns the HTML of the applicable MSP methods (country/currency/locale). |
| `Multisafepay-GetComponentToken` | GET | Generates an ephemeral API token (600s) for the Payment Component SDK; returns `environment`, `orderData` (currency, amount in cents, locale, country). |
| `Multisafepay-ValidateGift` | GET | Validates and applies a Gift Certificate to the basket. |
| `Multisafepay-RemoveGiftCard` | GET | Removes `GIFT_CERTIFICATE` payment instruments from the basket. |
| `Multisafepay-Confirm` | GET | Order confirmation page. Includes BNPL check: if the order is not `PAID`, queries MSP (`getOrderStatus`); if completed it forces the `notify` webhook, otherwise redirects to the cart. |
| `Multisafepay-Cancellation` | GET | Recreates a basket from the order and returns the shopper to checkout. |
| `Multisafepay-Webhook` | POST | Receives MSP asynchronous notifications; verifies the signature and delegates to `webhookHelper.notify`. |

#### `controllers/CheckoutServices.js`
SFRA checkout override. Main MSP customizations:
- `SubmitPayment`: propagates the selected gateway (`paymentForm.gatewayMSP.value`) into
  the `paymentInformation`.
- `PlaceOrder`: reads `gateway` and `payment_data` from the request and passes them to
  `COHelpers.handlePayments(order, orderNo, gateway, mspPaymentData)`. If the result contains
  a `redirectUrl` (MSP), it does **not** run `placeOrder` nor send the email — the webhook
  will handle it. It returns `redirectUrl` to the client.

### 4.2 Payment hooks

Registered in `hooks.json`:

| Hook | Script | Function |
|---|---|---|
| `app.payment.processor.multisafepaypayment` | `.../processor/multisafepaypayment.js` | `Handle` + `Authorize` |
| `app.payment.form.processor.multisafepaypayment` | `.../multisafepaypayment_form_processor.js` | `processForm` + `savePaymentInformation` |
| `app.payment.processor.cybersource_bml` | BML/BNPL Cybersource | legacy |
| `app.payment.processor.basic_gift_certificate` | Gift Certificate | |
| `dw.order.payment.authorize` | `hooks/authorize.js` | generic authorize |

**`multisafepaypayment.js`**
- `Handle(basket, paymentInformation, ...)`: removes existing payment instruments (except
  `GIFT_CERTIFICATE`), creates a `MultiSafepayPayment` instrument with the gross total amount and
  stores the selected gateway in `custom.Multisafepay_Gateway`.
- `Authorize(order, paymentInstrument, paymentProcessor, gateway, mspPaymentData)`:
  builds `transactionData`, handles direct/redirect with fallback, calls
  `multisafepayHelper.createOrder`, saves the transaction log to
  `paymentTransaction.custom.Multisafepay_log` and returns `redirectUrl` (payment_url).
  The log write is guarded by try/catch to avoid failures caused by a race condition
  with the webhook.

### 4.3 Models

#### `models/transactionData.js`
Builds the JSON payload for the MSP `POST /orders`. Key elements:
- `payment_options`: `notification_url` (absolute HTTPS webhook), `redirect_url`
  (Confirm), `cancel_url` (Cancellation), `notification_method: POST`.
- `customer` / `delivery`: data from billing/shipping address. `parseStreetAndHouseNumber()`
  splits street and house number for **both** billing and delivery: if `address2` is a bare
  number it is the house number; otherwise a trailing number in `address1` is extracted **and
  stripped** from `address1` so it is never sent twice (item 8 — e.g. "Via Roma 10" →
  `address1="Via Roma"`, `house_number="10"`). `reference` = `customerNo` for registered
  users, `orderNo` for guests.
- `shopping_cart`: product + shipping lines with net `unit_price` and `tax_table_selector`.
- `checkout_options.tax_tables`: VAT rates derived from the lines (`buildTaxTables`).
- `plugin`: integration metadata (shop `SalesforceCommerceCloud`, `shop_version SFRA 6.3.0`,
  `plugin_version 1.0.0`, `partner BIP`).
- `seconds_active: 3600` (payment expiry 1 hour).
- `amount`: `Math.round(orderTotal * 100)` (cents, safe rounding).
- `capture: 'manual'` if `Multisafepay_ManualCapture` is enabled.

#### `models/order.js`, `models/payment.js`
Overrides of the SFRA models to correctly expose the MSP payment methods/instructions.

### 4.4 Helpers

#### `scripts/helpers/multisafepayHelper.js`
Core of the MSP API integration. Main functions:

| Function | Description |
|---|---|
| `getApiBaseUrl()` | Returns the test/live base URL based on `Multisafepay_Environment` (case-insensitive). |
| `getActiveApiKey(site)` | Returns the active API key: `LiveApiKey`/`TestApiKey` with fallback to the legacy `ClientKey`. In live it **never** falls back to the test key. |
| `getApplicablePaymentMethods(DTO)` | `GET /payment-methods?country&currency&locale&group_cards=<pref>&include_coupons=1`. `group_cards` comes from `DTO.groupCards` or the `Multisafepay_GroupCards` Site Preference (item 2); `include_coupons=1` returns gift cards (item 14). |
| `generateApiToken(apiKey)` | `GET /auth/api_token` — ephemeral token for the Payment Component. Returns `{success, apiToken, statusCode, invalidKey}` so callers can tell an invalid key (401/403) from a transient error (item 7). |
| `createOrder(apiToken, transactionData)` | `POST /orders` — creates the MSP order, returns `payment_url`. |
| `getOrderStatus(apiToken, orderNumber)` | `GET /orders/{id}` — order status (used for BNPL). |
| `captureOrder(apiToken, orderNumber, amount, currency)` | `POST /orders/{id}/capture` — manual capture (full amount). |
| `refundOrder(apiToken, amount, orderNumber, currency, invoiceNo)` | `POST /orders/{id}/refunds` — full/partial refund. |
| `getAllTransactions(apiToken)` | `GET /transactions` — aggregates for the dashboard. KPI cards = counts; the 7-day charts = **revenue/refund amounts** (item 15). Dates are zero-padded ISO to match the transaction keys. |
| `getEnabledMSPMethods()` | Reads the enabled `MSPPaymentMethod` COs (sorted by `sortOrder`), including the restriction/capture fields; `requiresComponent` is read as-stored (no runtime hardcode). |
| `getApplicableMSPMethods(customer, country, amount, currency)` | Filters the enabled COs by country/currency/min-max amount (item 4) then applies the SFCC `Ordering > Payment Methods` gate per method (item 1/3). |
| `fetchTransactionsPaginated(apiToken)` | Paginates `GET /transactions` with content-based de-duplication (feeds `getAllTransactions`). |

**Inline component decision (item 5)**: `requiresComponent` is computed **at sync time**,
fully from the API — `apps.payment_components.has_fields && is_enabled` (top-level
`payment_components` also read for older API shapes). Confirmed against the live API, individual
card brands report `has_fields=true` even with `group_cards=0`, so **no hardcoded card list /
exception is used**. Methods such as Bancontact, Riverty, in3, in3 business, Billink and Direct
Debit report `has_fields=true` and therefore render the component; iDEAL and methods with
`is_enabled=false` do not.

**Single Source of Truth** (`getApplicableMSPMethods`): checkout shows only enabled COs that
pass the MSP restriction filters AND, per gateway, the SFCC `MSP_<gatewayId>` gate —
`active` flag + `isApplicable()` (customer group / country / currency / amount). A gateway
with no imported SFCC method yet is kept (partial-rollout safety); a disabled or inapplicable
one is hidden.

#### `scripts/helpers/webhookHelper.js`
Webhook notification handling.

- **`check(request)`** → verifies the signature: decodes the `auth` header (Base64
  `timestamp:hmac`), compares the timestamp and recomputes `HMAC-SHA512(timestamp:body, apiKey)`.
- **`notify(notificationData)`** → updates `paymentTransaction.custom.Multisafepay_OrderStatus`,
  `transactionID`, `Multisafepay_AmountRefunded`. **Item 10**: if the method actually used on
  the MSP page differs from the selected one (from `payment_details.type`, fallback
  `payment_method`), the actual gateway overwrites `Multisafepay_Gateway` on **both** the
  payment instrument and the transaction, with a consistent log line. Then switches on `status`:

| MSP Status | Action |
|---|---|
| `completed`, `shipped` | `confirmOrder`: place order (if `CREATED`/`FAILED`), set `PAYMENT_STATUS_PAID`, `EXPORT_STATUS_READY`, **`ensurePaymentProcessor()`** (item 6 — prevents "payment processor is unknown"), send confirmation email. |
| `refunded` | `handleRefund`: set `PAYMENT_STATUS_NOTPAID`. |
| `partial_refunded` | `handleRefund`: **keeps `PAYMENT_STATUS_PAID`** (item 11); the refunded amount is tracked via `Multisafepay_AmountRefunded`. |
| `void`, `expired`, `declined`, `cancelled` | `cancelOrder`: `failOrder`. |
| `reserved`, `uncleared`, `initialized` | Log only; status tracked in the custom attribute (`uncleared` = awaiting manual capture). |

### 4.5 Service configuration

#### `config/apiConfig.js`
Maps the logical names to the SFCC service IDs (`LocalServiceRegistry`):
`Multisafepay.GetPaymentMethods`, `.CreateOrder`, `.ListTransactions`, `.RefundOrder`,
`.CaptureOrder`, `.GenerateApiToken`.

> **Technical note**: the helpers use `dw/net/HTTPClient` for the actual HTTP calls,
> while the `LocalServiceRegistry` services are created for compliance/monitoring. The
> `Multisafepay.GenerateApiToken` service is defined in `metadata/site-import/services.xml`.

---

## 5. Business Manager components (`cartridges/bm_multisafepay`)

Registered in `bm_extensions.xml`:
- Menu **Merchant Tools → Site Preferences → Multisafepay settings** → `MultisafepaySettings-Start`.
- Menu **Analytics → Multisafepay dashboard** → `MultisafepayDashboard-Start`.

### 5.1 `MultisafepaySettings.js`
Configuration page + payment-method management. Endpoints:

| Endpoint | Description |
|---|---|
| `Start` (GET) | Renders the settings + list of synchronized `MSPPaymentMethod`. |
| `Save` (POST) | Saves the Site Preferences (Environment, API key, OMS, Manual Capture, **Group Card Methods**). |
| `SyncPaymentMethods` (POST) | Queries MSP for each target country, builds a gateway→countries map, captures per-method **restriction data** (currencies, min/max amount) and the **component flag** (`payment_components.has_fields && is_enabled`, plus the `group_cards=0` card exception), creates/updates the `MSPPaymentMethod` COs, disables methods no longer returned, generates the XML and triggers the import job via OCAPI. |
| `TogglePaymentMethod` (POST) | Enables/disables a single method (CO `enabled`) **and regenerates the XML + re-triggers the import job** so Site Prefs and Ordering > Payment Methods stay aligned (item 3). |
| `ImportPaymentMethods` (POST) | Generates the XML from all COs and triggers the import job. |
| `RefundOrder` (POST) | Refund from order detail. |
| `CaptureOrder` (POST) | Manual capture; saves `Multisafepay_CapturedAt` on the order. |

**Method import mechanism**:
1. `generatePaymentMethodsXML(methods)` writes
   `IMPEX/src/instance/msp-payment-methods/sites/<siteId>/payment-methods.xml` (site archive
   format), creates a ZIP, with method-id `MSP_<gatewayId>` and `processor-id MultiSafepayPayment`.
2. `getOCAPIToken()` obtains an OAuth2 token from `account.demandware.com` using
   `Multisafepay_OCAPI_ClientId/Secret`.
3. `triggerImportJob()` calls the **`MSP-ImportPaymentMethods`** job via the OCAPI Data API
   (`.../jobs/MSP-ImportPaymentMethods/executions`).

### 5.2 `MultisafepayDashboard.js`
`Start` (GET) → renders `multisafepayDashboard/dashboard.isml` with the aggregates from
`getAllTransactions` (transactions/refunds today and totals, 7-day charts).

### 5.3 Order detail — `PaymentInstrumentInfo_MultiSafepayPayment.isml`
Template injected into the BM order detail. Shows: gateway, transaction ID, MSP status
(color-coded), capture status, refunded amount. Exposes:
- Amount field (**refund only**) + **REFUND PAYMENT** button → `Multisafepay-RefundOrder`.
- **CAPTURE FULL PAYMENT** button + Capture Status row — shown only when Manual Capture is on,
  the method **supports capture** (the MSPPaymentMethod CO `supportsCapture`, set at sync time
  from the API `manual_capture.supported`) and the transaction is genuinely **awaiting capture**
  — order status `completed` with financial status `initialized`/`uncleared` (from
  `Multisafepay_FinancialStatus`) and not yet captured (items 12/13). This correctly covers
  cards (Visa/MC/Maestro/Bancontact) and excludes BNPL/instant methods. MSP capture is always
  full-amount; the UI states this and the amount field applies to refunds only.
  → `MultisafepaySettings-CaptureOrder`.
- `multisafepayRefund.js` JS.

---

## 6. Metadata and configuration (`metadata/site-import`)

### 6.1 Site Preferences (`Multisafepay` group)

| Preference | Type | Description |
|---|---|---|
| `Multisafepay_Environment` | enum (`test`/`live`) | Active environment. |
| `Multisafepay_TestApiKey` | string | Test-environment API key. |
| `Multisafepay_LiveApiKey` | string | Live-environment API key. |
| `Multisafepay_ClientKey` | string | Legacy key (fallback). |
| `Multisafepay_OMSOption` | boolean | Integration with Salesforce OMS. |
| `Multisafepay_ManualCapture` | boolean | Authorize without automatic capture. |
| `Multisafepay_GroupCards` | boolean | Group card schemes into one "Credit Card" method (`group_cards=1`) vs individual brands (`group_cards=0`, default). Item 2. |
| `Multisafepay_OCAPI_ClientId` | string | Account Manager Client ID for triggering the import job. |
| `Multisafepay_OCAPI_ClientSecret` | password | OCAPI Client Secret. |

### 6.2 `MSPPaymentMethod` Custom Object
Key: `gatewayId`. Attributes: `name`, `iconUrl`, `enabled` (default true),
`requiresComponent` (default false), `sortOrder`, `countries` (ISO alpha-2 CSV —
**empty means no country restriction**, mirroring MSP's `allowed_countries: []`),
`currencies` (ISO 4217 CSV — item 4), `minAmount`/`maxAmount` (double, major units, 0 = no
bound — item 4), `supportsCapture` (boolean — item 12). Scope: `site`, no-staging.

### 6.3 Custom attributes on system objects

| Object | Attribute | Description |
|---|---|---|
| `PaymentInstrument` | `Multisafepay_Gateway` | Selected gateway. |
| `PaymentInstrument` | `Multisafepay_PaymentData` | Payment Component `payment_data` JSON. |
| `PaymentTransaction` | `Multisafepay_OrderStatus` | Last MSP status from the webhook. |
| `PaymentTransaction` | `Multisafepay_log` | Order-creation response JSON log. |
| `PaymentTransaction` | `Multisafepay_AmountRefunded` | Refunded amount. |
| `PaymentTransaction` | `Multisafepay_CapturedAt` | Manual-capture ISO timestamp. |
| `PaymentTransaction` | `Multisafepay_FinancialStatus` | MSP financial (transaction) status from the webhook — `initialized`/`uncleared` while awaiting capture, `completed` once captured (item 12). |
| `PaymentTransaction` | `Multisafepay_CaptureExpiry` | Deadline after which an authorized payment can no longer be captured (REQ-2.2.2). |
| `PaymentTransaction` | `Multisafepay_PaymentBreakdown` | JSON array of the `payment_methods` MSP reported (coupon/gift-card split, ADD-1.3). |
| `Order` | `Multisafepay_ShipmentNotified` | Set once the shipment has been notified to MSP, so the job never notifies twice (REQ-2.1.6). |

---

## 7. Client-side components (`cartridges/multisafepay/cartridge/client`)

### `checkout/msp_checkout.js`
Handles the MSP Payment Component at checkout:
- `initMethodSelection()`: binds the `msp-payment-method` radios, sets the hidden
  `gatewayMSP` field and initializes/hides the component based on `data-requires-component`.
- `initPaymentComponent(gateway)`: requests the token (`window.componentTokenURL`), instantiates
  `new MultiSafepay({env, apiToken, order})` and `init('payment', {container, gateway})`.
- `capturePaymentData()`: captures `payment_data` **while the component is still visible**
  (before the stage transition) and stores it in `storedPaymentData`.
- `createOrder()`: exposes `gateway` and `payment_data` (JSON) for the PlaceOrder request.

### Other files
`checkout.js`, `checkout/billing.js`, `checkout/giftCard.js` and the components in `components/`
are SFRA overrides/extensions to integrate the MSP flow, handle Gift Certificates and
client-side validation. The styles are in `scss/checkout_msp.scss` and `scss/multisafepay.scss`.

---

## 8. Security

- **Webhook**: HMAC-SHA512 signature verified over `timestamp:body` with the API key as the
  secret (`webhookHelper.check`). Unsigned notifications are rejected (`/notifyError`).
- **API key** never exposed to the client: the frontend receives only ephemeral tokens (600s)
  generated server-side via `auth/api_token`.
- **CSRF**: the BM and checkout endpoints use `csrfProtection` (SFRA middleware).
- **HTTPS**: all endpoints use `server.middleware.https`; the webhook/redirect URLs are
  generated with `URLUtils.https(...).abs()`.
- **Live safety**: in the live environment the test key is never used as a fallback.

---

## 9. Build, deploy and testing

### Local setup
1. `npm install`
2. Create `dw.json` in the root with `hostname`, `username`, `password` (WebDAV access key),
   `code-version`.
3. `npm run build` (compiles JS, SCSS, fonts).
4. `npm run uploadCartridge` to upload the base cartridges; also upload `multisafepay` and
   `bm_multisafepay` (or use `npm run watch`).

### Main NPM scripts
| Script | Action |
|---|---|
| `npm run compile:js` / `compile:scss` | Compiles client JS / CSS (uses `--openssl-legacy-provider`). |
| `npm run build` | Compiles JS + fonts + SCSS. |
| `npm run watch` | Watch + automatic upload to sandbox. |
| `npm run lint` | Lints JS + CSS. |
| `npm test` | Unit tests (Mocha, `test/unit`). |
| `npm run cover` | Coverage (`coverage/`). |
| `npm run test:integration` | Integration tests (requires `dw.json`). |
| `npm run test:acceptance:*` | CodeceptJS acceptance tests (smoke/desktop/mobile/…). |

### Git hooks (Husky)
- `pre-commit`: `npm run lint`
- `pre-push`: `npm run test`

### CI
Configurations present: `.circleci/`, `bitbucket-pipelines.yml`.

---

## 10. MultiSafepay API reference

| Operation | Endpoint |
|---|---|
| Test base | `https://testapi.multisafepay.com/v1/json/` |
| Live base | `https://api.multisafepay.com/v1/json/` |
| Payment methods | `GET /payment-methods?country&currency&locale&group_cards=<0\|1>&include_coupons=1` |
| Component token | `GET /auth/api_token` |
| Create order | `POST /orders` |
| Order status | `GET /orders/{orderNo}` |
| Capture | `POST /orders/{orderNo}/capture` |
| Refund | `POST /orders/{orderNo}/refunds` |
| Transactions | `GET /transactions` |

Authentication: `Authorization: Bearer <apiKey|token>` header.

---

## 11. Operational notes and known limitations

- The order is **placed by the webhook**, not at redirect time: if the webhook does not
  arrive, `Multisafepay-Confirm` performs a fallback check on MSP (relevant for BNPL).
- The transaction-log write in `Authorize` may fail due to a race condition with the
  webhook: it is handled in a non-blocking way.
- The method sync stops (without deleting the existing COs) if **no** method is returned
  by any country, to avoid emptying the configuration.
- The method import via OCAPI requires Data API permissions on the Account Manager client and
  the OCAPI preferences configured; without them the COs are still saved but the import into
  SFCC must be run manually.

---

## 12. QA retest fixes (2026)

Summary of the 15 QA findings addressed and the files touched.

| # | Fix | Where |
|---|---|---|
| 1 | Sync reflects real MSP state; disabled methods hidden; checkout uses the last sync snapshot filtered strictly. | `multisafepayHelper.getApplicableMSPMethods` |
| 2 | `group_cards` support via `Multisafepay_GroupCards` Site Preference + BM toggle, wired into the payment-methods call. | `multisafepayHelper`, `requiredSettings.isml`, metadata |
| 3 | `TogglePaymentMethod` regenerates XML + re-triggers import so the two panels stay aligned. | `MultisafepaySettings.js` |
| 4 | Restrictions (currency, min/max amount) from MSP data + customer-group/active via `PaymentMethod.isApplicable`. | `multisafepayHelper`, sync, metadata |
| 5 | Inline component driven by API `has_fields && is_enabled`; hardcode removed except the documented `group_cards=0` card exception. | `multisafepayHelper`, sync |
| 6 | `ensurePaymentProcessor()` on webhook confirm prevents "payment processor is unknown". | `webhookHelper.js` |
| 7 | Invalid API key (401/403) hides all methods, shows a specific message and blocks the payment button; positive result cached per session. | `Multisafepay.isml`, `generateApiToken` |
| 8 | House number stripped from `address1` (no duplication), billing + delivery. | `transactionData.js` |
| 9 | Alphanumeric postal codes accepted (e.g. NL "1012 AB"). | `forms/default/address.xml` (override), `templates/resources/forms.properties` (both **new**) |
| 10 | Actual method used overwrites the stored gateway on PI + transaction, consistent logging. | `webhookHelper.notify` |
| 11 | Partial refund keeps `PAYMENT_STATUS_PAID`; amount tracked via `Multisafepay_AmountRefunded`. | `webhookHelper.handleRefund` |
| 12 | Capture UI shown only when the method supports capture and status is `uncleared` (awaiting capture). | `PaymentInstrumentInfo_MultiSafepayPayment.isml` |
| 13 | UI clarifies capture is always full; amount field is refund-only. | same |
| 14 | `include_coupons=1` returns gift cards. | `getApplicablePaymentMethods` |
| 15 | Dashboard charts fixed (zero-padded ISO dates) and now plot revenue/refund **amounts**. | `getAllTransactions`, `Last7Days` |

### 12.1 Deploy prerequisites
1. Re-import `metadata/site-import/meta/system-objecttype-extensions.xml` (new Site Preference
   `Multisafepay_GroupCards`; new `MSPPaymentMethod` attributes `currencies`, `minAmount`,
   `maxAmount`, `supportsCapture`).
2. Ensure `multisafepay` precedes `app_storefront_base` in the cartridge path (the `address.xml`
   form override and the checkout templates depend on it).
3. Run **Sync & Import** to populate the new CO fields; for item 6 (live) make sure the
   `MultiSafepayPayment` method has a Payment Processor and the webhook is reachable.

### 12.2 Confirmed against the live MSP API (2026 follow-up)
- **Restriction fields (item 4/14)**: confirmed — `allowed_currencies` (array) and
  `allowed_amount.min/max` **in cents** (`max` may be `null` = no cap). `payment_components`
  lives under `apps.payment_components`.
- **Manual-capture support (item 12)**: confirmed — the API reports it per method as
  `manual_capture.supported`. The sync stores it on the CO (`supportsCapture`); no hardcoded
  list. Note: Amex reported `supported=false` on the test account.
- **Awaiting-capture status (item 12)**: confirmed from `/transactions` — an authorized card is
  `status=completed` + `financial_status=initialized`; BNPL sits in `uncleared`. The Capture UI
  uses the financial status **and** `supportsCapture`, so BNPL (captured via shipment, not this
  button) is correctly excluded.
- **Card component with `group_cards=0`**: confirmed — individual brands DO report
  `has_fields=true`, so the component decision is fully API-driven with **no card exception**.

### 12.3 Residual limitations / open
- **Customer/user type (item 4)**: MSP does not expose per-method customer-type restrictions;
  enforcement relies on **SFCC customer groups** on the `MSP_<gateway>` methods, which the
  merchant configures. Ensure the import job runs in **MERGE** mode so a re-sync does not clear
  manually-set customer groups.
- **`/transactions` pagination (item 15)**: the sample response has no pagination envelope; the
  code paginates defensively with content-based de-dup (`limit`/`offset` assumed) and degrades
  to single-page if the params are ignored. Confirm the real pagination mechanism to guarantee
  completeness on high-volume accounts.
- **BNPL postal-code format**: BNPL methods (Riverty/in3/Billink/Klarna) validate the address
  strictly (a test AFTERPAY order was declined with "Value format is incorrect:
  customer.address.postalCode"). Watch the postal-code format sent in `transactionData.js` during
  BNPL testing.
- **`Multisafepay-GetPaymentMethods` / `MSPpaymentMethods.isml`**: legacy live-API render path,
  not used by the current checkout (kept for backward compatibility).

---

## 13. Second QA round (open items)

| Item | Root cause | Fix |
|---|---|---|
| **REQ-1.1.4** Group Cards persistence | The preference write failed because the metadata was not imported (`Save` threw). Sync/disable logic was already correct: with `group_cards=1` the API returns a single `CREDITCARD`, and the individual brands, no longer returned, are disabled. | Resolved by the describe-based metadata robustness (§ "never write/read undefined attributes"). No sync/rendering change required. |
| **REQ-1.2.2** min/max limits | Restrictions were stored and filtered at checkout but not visible to the merchant → "hidden" restrictions. | `MultisafepaySettings-Start` exposes `minAmount/maxAmount/currencies/supportsCapture`; `settings.isml` renders them as badges. |
| **REQ-1.3.1 / REQ-2.1.1 C** missing methods | The sync probed only 11 countries, so methods tied to other markets (DotPay/PL, Klarna DK/SE/NO/GB, …) were never returned by the API and never synced. | Default target countries expanded to the EU/EEA + UK in `SyncPaymentMethods`. |
| **REQ-1.4.3 / REQ-2.1.1 A** Riverty → Failed | The webhook only logged `uncleared` (the state of an authorized BNPL payment awaiting capture at shipment), so the order was never placed. | `confirmOrder(notificationData, markPaid)` — `uncleared` places the order as authorized/pending (NOTPAID); `completed`/`shipped` settle it to PAID. `Multisafepay-Confirm` fallback also accepts `uncleared`. |
| **REQ-1.4.4** invalid API key | Covered by the checkout key validation (methods hidden + checkout blocked) and the sync aborting on 401 without clearing existing methods. | Verified; no change. |
| **REQ-2.1.1 B** in3 B2B | Missing due to the sync interruption + un-probed markets; `IN3B2B` has a €150 minimum. | Resolved by the sync robustness + expanded countries. |
| **REQ-2.2.2** manual capture | Already API-driven via `manual_capture.supported` + `Multisafepay_FinancialStatus`. | Verified; no change. |
| **ADD-1.3** gift-card breakdown | `OrderModel` read `BasketMgr.getCurrentBasket()`, which is null on a placed order → gift cards never shown on confirmation/detail. | `OrderModel` now reads `lineItemContainer.paymentInstruments`; exposes `giftCards` (multiple), `giftCardTotal`, `hasGiftCards`, `paymentMethodBreakdown`. BM order detail renders the breakdown. Amount split is handled by `calculatePaymentTransaction` (gift certificate first, MSP takes the remainder). |

**BNPL payment-status note:** an `uncleared` BNPL authorization is placed as **NOTPAID (authorized/pending)**; a later `completed`/`shipped` notification settles it to PAID. If a merchant prefers BNPL orders to be PAID immediately, this is a one-line change in `confirmOrder`.

---

## 14. Fourth QA round (2026-08) — resolved findings

### 14.1 Country availability rebuilt on `allowed_countries` (REQ-1.1.4, REQ-1.3.1, REQ-2.1.1)

**What was wrong.** `SyncPaymentMethods` called `/payment-methods?country=XX&currency=EUR`
once per country in a configurable list, and rebuilt each method's country list from the
probes that happened to return it. That produced two independent defects:

1. **Incomplete.** `currency=EUR` was hardcoded, so probes for PL, DK, SE, NO, GB, CZ, HU and
   RO returned nothing and those markets could never enter any list.
2. **Wrong.** A method with **no** restriction on the MSP side was pinned to whatever the
   probe list happened to be. MasterCard, which MSP reports as `allowed_countries: []`, ended
   up as `DE,IT,BE,FR,ES,AT` — without NL — and therefore vanished for Dutch shoppers.

The inferred list was then written into the SFCC payment-method XML, so
`PaymentMethod.isApplicable()` re-applied the same wrong restriction. Roughly half the
catalogue was unreachable at checkout.

**What it does now.** One call to `/payment-methods` with **no** `country`/`currency` filter.
MSP returns the whole catalogue with each method's own restrictions, interpreted in exactly
one place — `multisafepayHelper.mapApiPaymentMethod`:

| MSP field | Meaning | Stored as |
|---|---|---|
| `allowed_countries: []` or absent | available in every country | `countries = ''` |
| `allowed_countries: ['NL']` | restricted to those countries | `countries = 'NL'` |
| `allowed_currencies` | allowed currencies | `currencies` CSV, empty = no restriction |
| `allowed_amount.min/max` (cents) | amount bounds, `null` max = no cap | `minAmount`/`maxAmount` in major units, `0` = no bound |
| `manual_capture.supported && is_enabled` | capture available on this account | `supportsCapture` |

`Multisafepay_TargetCountries` has been **removed**: it configured a mechanism that no longer
exists, and leaving it visible would suggest country availability is a Salesforce setting.

**Clearing stale restrictions.** `generatePaymentMethodsXML` now always writes a `<countries>`
element — **empty** when the method has no restriction. Omitting it would leave the incorrect
country list assigned to `MSP_<gateway>` by an earlier import, and the method would stay
hidden even after a correct sync.

### 14.2 Checkout filters on the billing address (REQ-1.1.4)

`paymentOptions/Multisafepay.isml` derived the country from
`basket.defaultShipment.shippingAddress`. Payment is processed against the **billing**
address, and that is what MSP validates, so the billing country is now the primary source,
falling back to the shipping address and then to the request locale (first render, before any
address exists).

> **Known limitation.** The list is rendered server-side when the billing step loads. Changing
> the billing country in the form does not re-render it until the step is submitted. Making
> the list refresh over AJAX on country change is a separate enhancement.

### 14.3 Generic failure message at checkout (REQ-1.4.4)

The storefront no longer states *why* online payment is unavailable. `msp.error.unavailable`
and `msp.error.nomethods` in `templates/resources/multisafepay.properties` carry a single
neutral text for every configuration failure; the distinction (`invalid` vs `notConfigured`,
HTTP status) goes to the `multisafepay/MSP` log only. Disclosing "invalid API key" told an
anonymous shopper the state of the merchant's integration.

### 14.4 BNPL shipment notification (REQ-2.1.6)

* **`updateOrderShipped` used `POST`** on `orders/{order_id}`. Probed against the live test API:

  | Request | Response |
  |---|---|
  | `PATCH /v1/json/orders/<unknown-id>` | `404 Invalid transaction ID` — verb accepted |
  | `POST /v1/json/orders/<unknown-id>` | `405 Method not allowed` — verb rejected |

  The old call could never take effect, which is why the scheduled job appeared to do nothing
  while still reporting a successful run. No `POST` fallback is kept: `POST` is the verb the
  API rejects, so a fallback could only produce a second failing call.
* Empty `tracktrace_code` / `carrier` / `ship_date` are **omitted** instead of sent as empty
  strings, which MSP rejects. Tracking data is taken from the SFCC shipment when present.
* The job returns `Status.ERROR` with the MSP error text when any notification fails, so the
  failure is visible in **Job History** instead of being swallowed as a green run.
* The job refuses to run for an order whose `Multisafepay_ShipmentNotified` attribute is not
  in the metadata: without it, it cannot remember what it already sent and would re-notify MSP
  on every execution.

The shipping-cost line in the order request now uses the reserved
`merchant_item_id: 'msp-shipping'` required by MSP's order format.

### 14.5 Manual capture (REQ-2.2.1, REQ-2.2.2)

| Finding | Change |
|---|---|
| The Capture badge appeared for methods whose capture the merchant had switched off in the MSP Admin Panel | `supportsCapture` now requires `manual_capture.supported` **and** `manual_capture.is_enabled` |
| `"capture": "manual"` was sent for every method whenever the preference was on | `transactionData` sends it only when the selected gateway's Custom Object reports `supportsCapture` |
| The Capture button never appeared in the order detail | The visibility rule was an allow-list on the financial status (`initialized`/`uncleared`). Orders whose status had not been stored — webhook processed before the attribute existed, or a notification without the field — fell through it. It is now a **deny-list**: an authorized payment is capturable unless it is demonstrably settled (`completed`, `refunded`, `partial_refunded`, `declined`, `expired`, `cancelled`, `void`, `chargeback`). An unknown status no longer hides the button, and unknown capture support (Custom Object missing) no longer counts as "not supported" |
| The capture deadline was not shown | `Multisafepay_CaptureExpiry` is stored from the webhook (and from the `Multisafepay-Confirm` fallback) and rendered as **Capture Expiry** in the order Payment tab |

### 14.6 Address form country list (REQ-1.1.4)

`forms/default/address.xml` offered only US, NL and CN, so country-restricted methods were
unreachable for real shoppers and untestable for QA. It now covers the EU/EEA markets plus
UK, CH, US and CN, with labels in `templates/resources/forms.properties`.

### 14.7 Test suite

`npm run test:msp` runs 83 unit tests (`test/msp/`) pinning every finding above.

Ten of them (`liveCatalogue.test.js`) run the mapper against `fixtures-payment-methods.json`,
a real response captured from the MultiSafepay test API for the sandbox account used in the
fourth QA round — so the assertions are pinned to the merchant's actual catalogue rather than
to a shape we invented. That fixture is also the evidence for § 14.1:

| Query | Methods returned |
|---|---|
| `GET /payment-methods` (no filter — what the sync now sends) | **30** |
| `GET /payment-methods?country=NL&currency=EUR` (the old probe) | **16** |

The fourteen the NL/EUR probe drops — `MASTERCARD`, `MISTERCASH`, `MYBANK`, `AMAZONBTN`,
`KBC`, `BELFIUS`, `DIRDEB`, `TRUSTLY`, `CBC`, `EPS`, `DOTPAY`, `MBWAY`, `MULTIBANCO`,
`BIZUM` — are exactly the fourteen the QA reported as missing from checkout, and every one of
them is reported by MSP with `allowed_countries: []`, i.e. no restriction at all.

`IN3B2B`, the fifteenth entry on the QA list, is withheld by its EUR 150 minimum against a
EUR 64 basket. That behaviour is correct and unchanged.

> The repository's existing `npm test` (mocha via `sgmf-scripts`) does **not run on Node 18+**:
> the pinned mocha bundles a `yargs` build that Node loads as ESM and fails on. This is
> pre-existing and unrelated to these changes. The MSP suite therefore uses Node's built-in
> test runner, which needs no dependencies. `test/msp/helpers/sfccModules.js` patches
> `Module._load` to serve `dw/*` and cartridge-path stubs, because most SFCC requires in this
> codebase are lazy and proxyquire cannot intercept them.
