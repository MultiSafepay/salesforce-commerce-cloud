# Technical Documentation — MultiSafepay Integration for SFCC (SFRA)

> Integration of the **MultiSafepay** Payment Service Provider into the
> **Salesforce B2C Commerce** platform based on **Storefront Reference Architecture (SFRA 6.3.0)**.

---

## 1. Overview

The project is a standard SFRA installation extended with the MultiSafepay payment
integration (hereinafter **MSP**). The integration provides:

- Checkout display of the MSP payment methods synchronized from the merchant's MSP account,
  filtered by billing country, currency, order amount and the SFCC payment-method settings.
- Payment in **redirect** mode (MSP-hosted payment page) and **direct** mode (inline data
  entry through the MSP *Payment Component*), with automatic fallback from direct to redirect.
- Asynchronous order-status notifications through an HMAC-SHA512-signed **webhook**.
- Business Manager tools: settings, payment-method synchronization and import, a transactions
  dashboard, manual capture and refunds from the order detail.
- **BNPL** (Buy Now Pay Later) support, including a job that notifies MSP of shipped orders.
- SFCC Gift Certificates combined with an MSP payment, and MSP coupons / gift cards
  (`include_coupons=1`).

### Technology stack

| Component | Technology |
|---|---|
| Platform | Salesforce B2C Commerce |
| Storefront framework | SFRA 6.3.0 (`app_storefront_base`) |
| Server-side runtime | B2C Commerce script API (`dw.*`) |
| Client-side | jQuery, Bootstrap 4, MultiSafepay Payment Component SDK (v2) |
| Build | `sgmf-scripts`, Webpack, SCSS |
| Testing | Node.js built-in test runner (connector suite); Mocha + Chai and CodeceptJS (SFRA base suites) |
| CI | GitHub Actions |
| MSP API | REST JSON v1 (`/v1/json/`) |

---

## 2. Cartridge structure

The site's cartridge path must load the custom cartridges **before** the base ones, so the
overrides take precedence:

```
multisafepay : bm_multisafepay : app_storefront_base : bm_app_storefront_base : modules
```

| Cartridge | Role |
|---|---|
| `app_storefront_base` | SFRA base provided by Salesforce — not modified. |
| `bm_app_storefront_base` | SFRA Business Manager base. |
| `modules` | Shared SFRA modules (`server`, `*/cartridge/scripts/util/collections`, etc.). |
| **`multisafepay`** | Storefront cartridge: controllers, payment hooks, models, helpers, the shipment job, templates and checkout JS. |
| **`bm_multisafepay`** | Business Manager cartridge: settings page, Sync & Import, dashboard, capture/refund from the order detail. |

The Business Manager controllers require `*/cartridge/scripts/helpers/multisafepayHelper`
(from `multisafepay`) and the SFRA CSRF middleware (from `app_storefront_base`), so the
Business Manager cartridge path must contain those cartridges as well as `bm_multisafepay`.

The files under `multisafepay/cartridge/client` and `static` that are not MSP-specific are
overrides of SFRA assets that integrate the MSP checkout.

---

## 3. Payment flow architecture

### 3.1 Sequence diagram (high level)

```
Shopper            Storefront (multisafepay)          MSP API                 Webhook
   │  Billing step      │                                │                       │
   │───────────────────>│ Multisafepay.isml              │                       │
   │                    │  (MSPPaymentMethod COs,        │                       │
   │                    │   key check) ─────────────────>│ GET /auth/api_token   │
   │  method list <─────│                                │                       │
   │  select method     │                                │                       │
   │  (if component) ──>│ Multisafepay-GetComponentToken │                       │
   │                    │───────────────────────────────>│ GET /auth/api_token   │
   │  Place Order ─────>│ CheckoutServices-PlaceOrder    │                       │
   │                    │  createOrder (SFCC)            │                       │
   │                    │  Authorize hook                │                       │
   │                    │───────────────────────────────>│ POST /orders          │
   │                    │<── payment_url ────────────────│                       │
   │  redirect to MSP <─│                                │                       │
   │  pay on MSP ───────────────────────────────────────>│                       │
   │                    │                                │  status ─────────────>│ Multisafepay-Webhook
   │                    │<───────────────────────────────────────────────────────│ (place / status / email)
   │  redirect_url ─────│ Multisafepay-Confirm           │                       │
   │                    │  (if not PAID) ───────────────>│ GET /orders/{id}      │
   │  order confirmed <─│                                │                       │
```

### 3.2 Phases in detail

1. **Method loading** — The billing template `checkout/billing/paymentOptions/Multisafepay.isml`
   renders the payment methods server-side from the synchronized **`MSPPaymentMethod` Custom
   Objects** via `multisafepayHelper.getApplicableMSPMethods()` (see §4.4). No call to
   `/payment-methods` is made at checkout. The country used for filtering is the basket's
   **billing** address country, falling back to the default shipment's shipping address and then
   to the country of the request locale (`US` if the locale has none). Before rendering, the
   active API key is validated (see §4.6).

2. **Method selection** — `msp_checkout.js` handles the radio selection and writes the selected
   gateway into the hidden `gatewayMSP` field. For methods rendered with
   `data-requires-component="true"` it initializes the **MultiSafepay Payment Component** with a
   token obtained from `Multisafepay-GetComponentToken`. The flag is the `requiresComponent`
   attribute stored on the Custom Object at sync time.

3. **Place Order** — `CheckoutServices-PlaceOrder`:
   - Creates the SFCC order (status `CREATED`).
   - Calls `COHelpers.handlePayments(order, orderNo, gateway, mspPaymentData)`, which invokes the
     `app.payment.processor.multisafepaypayment` hook → **`Authorize`**.
   - `Authorize` builds the payload with the `transactionData` model and calls `POST /orders`.
     - **Direct mode**: if the client sent `payment_data` from the Payment Component, it is
       attached with `type: 'direct'`. If that request fails, it is retried once as
       `type: 'redirect'` without `payment_data`.
     - **Redirect mode**: MSP returns a `payment_url`.
   - The `payment_url` is returned to the client as `redirectUrl` and the browser is redirected
     to it. When a `redirectUrl` is present, `PlaceOrder` does **not** call `placeOrder` and does
     not send the confirmation email; both are done on notification.

4. **Payment on MSP** — The shopper completes the payment on the MSP-hosted page.

5. **Webhook** — MSP posts the notification to `Multisafepay-Webhook`. The signature is verified
   and the order is placed, settled, refunded or failed according to `status` (see §4.5).

6. **Confirm / Cancellation** — The shopper returns to `Multisafepay-Confirm` (`redirect_url`) or
   `Multisafepay-Cancellation` (`cancel_url`, recreates the basket from the order).

---

## 4. Server-side components (`cartridges/multisafepay`)

### 4.1 Controllers

#### `controllers/Multisafepay.js`

| Endpoint | Method | Description |
|---|---|---|
| `Multisafepay-GetPaymentMethods` | GET | Calls `/payment-methods` live with the locale country, basket currency and locale and returns the HTML of `MSPpaymentMethods.isml`. Not used by the current checkout, which renders from the Custom Objects. |
| `Multisafepay-GetComponentToken` | GET | Generates a short-lived API token for the Payment Component; returns `apiToken`, `environment` (`live`/`test`) and `orderData` (currency, amount in cents, customer locale and country). |
| `Multisafepay-ValidateGift` | GET | Validates a Gift Certificate code (`giftCert`) and adds it to the basket as a `GIFT_CERTIFICATE` payment instrument. |
| `Multisafepay-RemoveGiftCard` | GET | Removes the `GIFT_CERTIFICATE` payment instruments from the basket. |
| `Multisafepay-Confirm` | GET | Order confirmation page (`orderID`). If the order is not `PAID`, queries MSP (`getOrderStatus`): for `completed`, `shipped` or `uncleared` it runs `webhookHelper.notify` with the returned data; for any other status it redirects to the cart. |
| `Multisafepay-Cancellation` | GET | Recreates a basket from the order (`orderID`) and redirects to `Checkout-Begin`. |
| `Multisafepay-Webhook` | POST | Receives MSP notifications; verifies the signature (`webhookHelper.check`) and delegates to `webhookHelper.notify`. Renders `notify` on success, `notifyError` otherwise. |

All routes use `server.middleware.https`.

#### `controllers/CheckoutServices.js`
Replaces the SFRA `CheckoutServices` controller. MSP-specific behaviour:
- `SubmitPayment`: copies the selected gateway (`paymentForm.gatewayMSP.value`) into
  `paymentInformation.gateway`, which `Handle` stores on the payment instrument. The billing
  address submitted with the step is saved on the basket.
- `PlaceOrder`: reads `gateway` (query string or form) and `payment_data` (form) and passes them
  to `COHelpers.handlePayments(order, orderNo, gateway, mspPaymentData)`. If the result contains a
  `redirectUrl`, it skips `placeOrder` and the confirmation email and returns `redirectUrl` to the
  client.

### 4.2 Payment hooks

Registered in `cartridges/multisafepay/hooks.json`:

| Hook | Script | Functions |
|---|---|---|
| `app.payment.processor.multisafepaypayment` | `processor/multisafepaypayment.js` | `Handle`, `Authorize` |
| `app.payment.form.processor.multisafepaypayment` | `processor/multisafepaypayment_form_processor.js` | `processForm`, `savePaymentInformation` |
| `app.payment.processor.basic_gift_certificate` | `processor/basic_gift_certificate.js` | Gift Certificate processor |
| `app.payment.form.processor.basic_gift_certificate` | `processor/basic_gift_certificate_form_processor.js` | Gift Certificate form processor |
| `app.payment.processor.cybersource_bml` | `processor/cybersource_bml.js` | SFRA sample BML processor |
| `app.payment.form.processor.cybersource_bml` | `processor/cybersource_bml_form_processor.js` | SFRA sample BML form processor |
| `dw.order.payment.authorize` | `hooks/authorize.js` | `authorize(order, paymentDetails)`: creates an MSP order of `type: 'paymentlink'` for the order total and returns `Status.OK` / `Status.ERROR`. |

**`multisafepaypayment.js`**
- `Handle(basket, paymentInformation, paymentMethodID, req)`: removes the existing payment
  instruments except `GIFT_CERTIFICATE`, creates a `MultiSafepayPayment` instrument for the basket
  gross total and stores the selected gateway in `custom.Multisafepay_Gateway`.
- `Authorize(order, paymentInstrument, paymentProcessor, gateway, mspPaymentData)`: builds
  `transactionData`, applies direct/redirect with fallback, calls `multisafepayHelper.createOrder`,
  sets the payment processor on the transaction, writes the response to
  `paymentTransaction.custom.Multisafepay_log` and the gateway to
  `paymentTransaction.custom.Multisafepay_Gateway`, and returns `redirectUrl` (`payment_url`).
  The write is wrapped in try/catch so that a concurrent webhook update cannot fail the checkout.

### 4.3 Models

#### `models/transactionData.js`
`new transactionData(order, currentLocaleID, gateway, orderTotal)` builds the JSON payload for
`POST /orders` in `this.transactionData`:

| Field | Content |
|---|---|
| `type`, `gateway`, `order_id`, `currency`, `description` | `redirect` (overridden by `Authorize` for direct mode), selected gateway, SFCC order number, order currency, `Order <orderNo>`. |
| `amount` | `Math.round(orderTotal * 100)` (cents). |
| `payment_options` | `notification_url` (`Multisafepay-Webhook`), `redirect_url` (`Multisafepay-Confirm?orderID=`), `cancel_url` (`Multisafepay-Cancellation?orderID=`), all absolute HTTPS; `notification_method: 'POST'`; `close_window: false`. |
| `customer` | Billing address, locale, phone, IP (`order.remoteHost`), email, `disable_send_email: false`, `reference` = `customerNo` for registered customers, `orderNo` for guests. |
| `delivery` | Default shipment's shipping address (billing address if none). |
| `shopping_cart.items` | One line per product (`unit_price` = adjusted net price per unit, `merchant_item_id` = product ID, `tax_table_selector`) plus, when the shipping total is above zero, a shipping line with `merchant_item_id: 'msp-shipping'`. |
| `checkout_options` | `validate_cart: false`; `tax_tables.alternate` built from the line tax rates (`buildTaxTables`), selectors named `TAX<rate%>` or `none`. |
| `plugin` | `shop: 'SalesforceCommerceCloud'`, `shop_version: 'SFRA 6.3.0'`, `plugin_version: '1.0.0'`, `partner: 'BIP'`, `shop_root_url`. |
| `seconds_active` | `3600` (payment link valid for one hour). |
| `capture` | `'manual'` only when the `Multisafepay_ManualCapture` preference is `true` **and** the gateway's `MSPPaymentMethod` Custom Object has `supportsCapture === true`. |

`parseStreetAndHouseNumber(address1, address2)` splits street and house number for both
`customer` and `delivery`: if `address2` is a bare number (optionally with a suffix, e.g. `42B`)
it is the house number; otherwise a trailing number in `address1` is extracted and removed from
the street (`"Via Roma 10"` → `address1: "Via Roma"`, `house_number: "10"`).

#### `models/order.js`, `models/payment.js`
Overrides of the SFRA models. `OrderModel` reads the payment instruments of the line-item
container it is given (order or basket) and exposes `giftCards` (all `GIFT_CERTIFICATE`
instruments), `giftCardTotal`, `hasGiftCards` and `paymentMethodBreakdown` (the
`MultiSafepayPayment` instrument with its gateway and amount). The amount split between Gift
Certificates and the MSP instrument is computed by `COHelpers.calculatePaymentTransaction`.

### 4.4 `scripts/helpers/multisafepayHelper.js`

Core of the MSP API integration. All HTTP calls use `dw/net/HTTPClient` with the header
`Authorization: Bearer <key or token>`.

| Function | Description |
|---|---|
| `getCustomPreference(field, site)` | Reads a Site Preference; returns `null` (and logs a warning) if the attribute is not defined in the instance metadata. |
| `getApiBaseUrl()` | Live or test base URL from `Multisafepay_Environment` (case-insensitive `live`; anything else is test). |
| `getActiveApiKey(site)` | Live: `Multisafepay_LiveApiKey`, falling back to `Multisafepay_ClientKey`. Test: `Multisafepay_TestApiKey`, falling back to `Multisafepay_ClientKey`. Live never falls back to the test key. |
| `getApplicablePaymentMethods(DTO)` | `GET /payment-methods`. Adds `country`, `currency` and `locale` only when present in `DTO`; always adds `group_cards` (`DTO.groupCards`, else the `Multisafepay_GroupCards` preference; `1` or `0`) and `include_coupons=1`. Returns the parsed body, or `{error, statusCode, error_info}`. |
| `mapApiPaymentMethod(apiMethod)` | Maps one `/payment-methods` entry to the Custom Object shape (see below). Returns `null` for an entry without `id`. |
| `generateApiToken(apiKey)` | `GET /auth/api_token`. Returns `{success, apiToken, statusCode}` or `{success: false, statusCode, invalidKey}` where `invalidKey` is true for 401/403. |
| `createOrder(apiToken, transactionData)` | `POST /orders`. Returns `{success: true, data}` or `{success: false, statusMessage}`. |
| `getOrderStatus(apiToken, orderNumber)` | `GET /orders/{orderNumber}`. Returns `{success, data}`. |
| `updateOrderShipped(apiToken, orderNumber, shipmentData)` | `PATCH /orders/{orderNumber}` with `status: 'shipped'`, `tracktrace_code`, `carrier` and `ship_date`. Blank values default to the order number, `Unknown` and the current time (`yyyy-MM-dd HH:mm:ss`). A 200 response with `success: false` is treated as a failure. |
| `captureOrder(apiToken, orderNumber, amount, currencyCode)` | `POST /orders/{orderNumber}/capture` with `amount` (cents; the order gross total when no amount is given) and `new_order_status: 'completed'`. |
| `refundOrder(apiToken, amount, orderNumber, currencyCode, invoiceNo)` | `POST /orders/{orderNumber}/refunds` with `amount` (cents) and `currency`. `invoiceNo` is accepted but not sent. |
| `getAllTransactions(apiToken)` | Aggregates `GET /transactions` for the dashboard: payment and refund counts (today and total) and, for the last 7 days, the daily payment and refund **amounts**. |
| `getEnabledMSPMethods()` | Reads the `MSPPaymentMethod` Custom Objects with `enabled !== false`, sorted by `sortOrder`. Each restriction/capture attribute is read on its own and falls back to empty when the metadata does not define it. |
| `getApplicableMSPMethods(customer, countryCode, amount, currencyCode)` | Returns the methods to show at checkout (see below). |

`getAllTransactions` uses an internal `fetchTransactionsPaginated` that requests pages with
`limit=100&offset=<n>` (at most 200 pages), de-duplicates rows by `transaction_id` / `order_id`,
and stops on a short page or on a page with no new rows.

#### Payment-method mapping (`mapApiPaymentMethod`)

This function is the single place where the `/payment-methods` response is interpreted; the sync,
the checkout filter and the tests all rely on it.

| MSP field | Meaning | Stored as |
|---|---|---|
| `allowed_countries: []` or absent | available in every country | `countries = ''` |
| `allowed_countries: ['NL', …]` | restricted to those countries | `countries` = upper-case CSV of the 2-letter codes |
| `allowed_currencies` (or `currencies`) | allowed currencies | `currencies` CSV; empty = no restriction |
| `allowed_amount.min` / `.max` (cents; `max` may be `null`) | amount bounds | `minAmount` / `maxAmount` in major units; `0` = no bound |
| `payment_components.has_fields && is_enabled` (top level or under `apps`) | inline Payment Component | `requiresComponent` |
| `manual_capture.supported && manual_capture.is_enabled` | manual capture available on this account | `supportsCapture` |
| `name` (else `description`, else `id`), `icon_urls.medium` | display data | `name`, `iconUrl` |

#### Checkout filter (`getApplicableMSPMethods`)

A method is shown only if all of the following hold:
1. Its Custom Object is enabled.
2. The country is in `countries` (or `countries` is empty), the currency is in `currencies` (or
   `currencies` is empty), and the amount is within `minAmount` / `maxAmount` (`0` = no bound).
3. The SFCC payment method `MSP_<gatewayId>` (Merchant Tools → Ordering → Payment Methods), if it
   exists, is active and `isApplicable(customer, countryCode, amount)` returns true (customer
   groups, countries, amount range configured on it). A gateway with no `MSP_<gatewayId>` method
   is kept.

### 4.5 `scripts/helpers/webhookHelper.js`

- **`check(request)`** — Reads the `auth` header, Base64-decodes it into `timestamp:signature`,
  requires the timestamp to equal the `timestamp` query parameter and the signature to equal the
  hex `HMAC-SHA512(timestamp + ':' + rawBody)` keyed with the active API key. No age window is
  applied to the timestamp.
- **`notify(notificationData)`** — On the order's `MultiSafepayPayment` transaction it stores
  `Multisafepay_OrderStatus` (`status`), `Multisafepay_FinancialStatus` (`financial_status`),
  `Multisafepay_CaptureExpiry` (`capture_expiry`, `payment_details.capture_expiry` or
  `capture_expiry_at`), `Multisafepay_PaymentBreakdown` (JSON of `payment_methods`), the
  `transactionID` (if not set yet) and `Multisafepay_AmountRefunded` (`amount_refunded / 100`, when
  above zero). Each of the three newer attributes is written on its own and skipped, with a warning,
  when the metadata does not define it. If the
  method actually used (`payment_details.type`, else `payment_method`) differs from the stored
  gateway, it overwrites `Multisafepay_Gateway` on both the payment instrument and the transaction.
  It then acts on `status`:

| MSP status | Action |
|---|---|
| `completed`, `shipped` | `confirmOrder(data)`: places the order if it is `CREATED` or `FAILED`, sets `PAYMENT_STATUS_PAID` and `EXPORT_STATUS_READY`, assigns the `MultiSafepayPayment` payment processor to the transaction if missing, sends the confirmation email. |
| `uncleared` | `confirmOrder(data, false)`: places the order as above but sets `PAYMENT_STATUS_NOTPAID` (authorized, pending capture — the BNPL state before shipment). A later `completed`/`shipped` notification sets it to PAID. |
| `refunded` | `handleRefund`: sets `PAYMENT_STATUS_NOTPAID`. |
| `partial_refunded` | `handleRefund`: keeps `PAYMENT_STATUS_PAID`; the refunded amount is in `Multisafepay_AmountRefunded`. |
| `void`, `expired`, `declined`, `cancelled` | `cancelOrder`: `OrderMgr.failOrder(order, true)` (applies to orders not yet placed). |
| `reserved`, `initialized` | Logged only; the status is stored in `Multisafepay_OrderStatus`. |
| other | Logged as unhandled. |

If placing the order fails, the order is failed and the error logged.

### 4.6 Checkout template — `paymentOptions/Multisafepay.isml`

- **API key check**: if no key is configured, or `generateApiToken` reports 401/403, no method is
  rendered, the generic message `msp.error.unavailable` is shown and the submit-payment and
  place-order buttons are disabled. A successful check is cached in `session.privacy` for that key,
  so a key change triggers a new check. Transient errors (network, 5xx) do not block checkout.
  The cause (`not configured` / `invalid`) is written to the log only.
- **No applicable method**: the message `msp.error.nomethods` is shown.
- Messages are defined in `templates/resources/multisafepay.properties`.
- The Payment Component SDK (`/sdk/components/v2/components.js` and `.css`) is loaded from
  `https://pay.multisafepay.com` when `Multisafepay_Environment` is `live`, otherwise from
  `https://testpay.multisafepay.com`.

### 4.7 Shipment notification job — `scripts/jobs/notifyShipments.js`

Declared in `cartridges/multisafepay/steptypes.json` as the script-module step
**`custom.MSP.NotifyShipments`** (function `run`, site context, not parallel, timeout 900 s). The
job itself is created and scheduled in Business Manager.

`run()`:
1. Returns `ERROR` (`NO_API_KEY`) if no API key is configured.
2. Searches orders with shipping status `SHIPPED` and order status `OPEN`, skipping orders without
   a `MultiSafepayPayment` instrument and orders with `Multisafepay_ShipmentNotified = true`.
3. For each remaining order, calls `updateOrderShipped` with the first shipment's tracking number
   and shipping-method display name (as carrier) when available, and sets
   `Multisafepay_ShipmentNotified = true` on success.
4. If the `Order.Multisafepay_ShipmentNotified` attribute is not defined in the metadata, the order
   is not notified and is counted as a failure. If MultiSafepay accepts the update but the flag
   cannot be saved, the order is also counted as a failure, so it cannot be re-sent unnoticed.
5. Returns `ERROR` (`NOTIFY_FAILED`) with the last error, including the order number, when any
   order failed; otherwise `OK` with the number of orders notified. The status message is shown in
   Job History.

### 4.8 Forms

`forms/default/address.xml` overrides the SFRA address form: the postal-code validation accepts
alphanumeric codes (e.g. `1012 AB`), and the country list contains the EU/EEA countries plus CH, GB,
US and CN, with labels in `templates/resources/forms.properties`. Because SFCC forms do not merge,
the override replaces the whole base form. `forms/default/billing.xml` adds the `gatewayMSP` field.

### 4.9 Service configuration

`config/apiConfig.js` maps logical names to service IDs: `Multisafepay.GetPaymentMethods`,
`.CreateOrder`, `.ListTransactions`, `.RefundOrder`, `.CaptureOrder`, `.GenerateApiToken`. The
helpers create these services through `LocalServiceRegistry` but perform the HTTP calls with
`dw/net/HTTPClient`, building each URL from the selected environment. All six are defined in
`metadata/site-import/services.xml`.

---

## 5. Business Manager components (`cartridges/bm_multisafepay`)

Registered in `bm_extensions.xml`:
- **Merchant Tools → Site Preferences → Multisafepay settings** → `MultisafepaySettings-Start`.
- **Merchant Tools → Analytics → Multisafepay dashboard** → `MultisafepayDashboard-Start`.

### 5.1 `MultisafepaySettings.js`

| Endpoint | Description |
|---|---|
| `Start` (GET) | Renders the settings page and the synchronized `MSPPaymentMethod` list (name, gateway, Inline / Capture / min-max badges, countries or "All countries", enable toggle). |
| `Save` (POST) | Writes each `{key, value}` sent by the page to the corresponding Site Preference. The page exposes Environment, Test/Live API key, OMS option, Manual Capture and Group Card Methods. |
| `SyncPaymentMethods` (POST) | Synchronizes the catalogue (see below). |
| `TogglePaymentMethod` (POST) | Sets `enabled` on one Custom Object, then regenerates the XML from all Custom Objects and triggers the import job. |
| `ImportPaymentMethods` (POST) | Regenerates the XML from all Custom Objects and triggers the import job. |
| `RefundOrder` (POST) | Refund from the order detail (`amount`, `orderNumber`, `currencyCode`). |
| `CaptureOrder` (POST) | Manual capture; on success stores `Multisafepay_CapturedAt` (ISO timestamp) on the order's MSP payment transaction. |

**`SyncPaymentMethods`**
1. Fails with an explicit message if no API key is configured for the active environment.
2. Calls `getApplicablePaymentMethods` **once**, without `country`, `currency` or `locale`
   (`GET /payment-methods?group_cards=<0|1>&include_coupons=1`). MSP returns the whole catalogue,
   each method with its own `allowed_countries` / `allowed_currencies` / `allowed_amount`.
3. Stops on 401/403, on any other API error, or on an empty catalogue, without changing the
   existing Custom Objects.
4. Maps each entry with `mapApiPaymentMethod` and creates or updates the `MSPPaymentMethod` Custom
   Objects. New objects are created with `enabled = true` and the next `sortOrder`; existing
   objects keep their `enabled` and `sortOrder`. `currencies`, `minAmount`, `maxAmount` and
   `supportsCapture` are each written on their own and skipped when the metadata does not define
   them; the core sync proceeds either way.
5. Disables the Custom Objects of methods not returned and clears their `countries`.
6. Generates the XML for the returned methods and triggers the import job.

**Method import mechanism**
1. `generatePaymentMethodsXML(methods)` writes
   `IMPEX/src/instance/msp-payment-methods/sites/<siteId>/payment-methods.xml` (site-archive
   format) and zips the folder to `IMPEX/src/instance/msp-payment-methods.zip`. Each method is
   written as `MSP_<gatewayId>` with name, description, `enabled-flag`, `processor-id
   MultiSafepayPayment` and a `<countries>` element. The element is always written; it is empty for
   a method without country restriction, so the import clears any country list previously assigned
   to `MSP_<gatewayId>`. Customer groups are not written.
2. `getOCAPIToken()` obtains a client-credentials token from
   `https://account.demandware.com/dw/oauth2/access_token` using `Multisafepay_OCAPI_ClientId` /
   `Multisafepay_OCAPI_ClientSecret`.
3. `triggerImportJob()` calls
   `POST https://<instanceHostname>/s/-/dw/data/v24_5/jobs/MSP-ImportPaymentMethods/executions`
   (200/202 = triggered). The **`MSP-ImportPaymentMethods`** job is not part of this repository;
   it is created in Business Manager to import the generated archive. Without OCAPI credentials
   the Custom Objects are still saved and the import must be run manually.

### 5.2 `MultisafepayDashboard.js`
`Start` (GET) renders `multisafepayDashboard/dashboard.isml` with `getAllTransactions`: KPI cards
with payment and refund counts (today and total) and 7-day charts of payment and refund amounts.

### 5.3 Order detail — `order/PaymentInstrumentInfo_MultiSafepayPayment.isml`
Rendered in the Business Manager order Payment tab for `MultiSafepayPayment` instruments. Shows
gateway, transaction ID, MSP order status (colour-coded), capture status, capture expiry, refunded
amount, the Gift Certificate breakdown and the MSP payment breakdown (`Multisafepay_PaymentBreakdown`,
shown when it has more than one entry). Actions, handled by `static/default/js/multisafepayRefund.js`:

- **Refund**: amount field + **REFUND PAYMENT** → `MultisafepaySettings-RefundOrder`. The amount
  field applies to refunds only.
- **CAPTURE FULL PAYMENT** → `MultisafepaySettings-CaptureOrder` (always the full amount). The
  button is shown when all of the following hold:
  - the payment is a manual-capture payment: a capture expiry is stored on the transaction, or
    the `Multisafepay_ManualCapture` preference is on and the gateway's Custom Object does not
    report `supportsCapture = false`;
  - `Multisafepay_CapturedAt` is not set;
  - the MSP order status is `completed` (BNPL payments in `uncleared` are settled by the shipment
    notification, not by this button);
  - the financial status is not one of `completed`, `refunded`, `partial_refunded`, `declined`,
    `expired`, `cancelled`, `void`, `chargeback`.

Custom string attributes are converted with `String(...)` before comparison, because they are
returned as Java `String` objects for which strict equality with a JavaScript string literal is
always false.

---

## 6. Metadata and configuration (`metadata/site-import`)

### 6.1 Site Preferences (`Multisafepay` group)

| Preference | Type | Description |
|---|---|---|
| `Multisafepay_Environment` | string | `test` (default) or `live`. |
| `Multisafepay_TestApiKey` | string | API key used in the test environment. |
| `Multisafepay_LiveApiKey` | string | API key used in the live environment. |
| `Multisafepay_ClientKey` | string | Legacy single key, used only when the key for the selected environment is empty. |
| `Multisafepay_OMSOption` | boolean | Salesforce OMS flag set from the settings page; not read by the connector code. |
| `Multisafepay_ManualCapture` | boolean | Request manual capture for methods that support it. |
| `Multisafepay_GroupCards` | boolean (default `false`) | `true`: card schemes grouped into one method (`group_cards=1`); `false`: one method per scheme (`group_cards=0`). |
| `Multisafepay_OCAPI_ClientId` | string | Account Manager API client ID used to trigger the import job. Empty disables auto-import. |
| `Multisafepay_OCAPI_ClientSecret` | password | Account Manager API client secret. |

### 6.2 `MSPPaymentMethod` Custom Object
Key `gatewayId` (string). Scope `site`, `no-staging`. Attributes:

| Attribute | Type | Meaning |
|---|---|---|
| `name`, `iconUrl` | string | Display data from MSP. |
| `enabled` | boolean | Shown at checkout unless `false`. |
| `requiresComponent` | boolean | Render the inline Payment Component. |
| `sortOrder` | int | Display order. |
| `countries` | string | ISO 3166-1 alpha-2 CSV; **empty means no country restriction**. |
| `currencies` | string | ISO 4217 CSV; empty means no restriction. |
| `minAmount`, `maxAmount` | double | Major currency units; `0` means no bound. |
| `supportsCapture` | boolean | Manual capture supported and enabled for this method. |

### 6.3 Custom attributes on system objects

Defined in `system-objecttype-extensions.xml`:

| Object | Attribute | Type | Description |
|---|---|---|---|
| `Order` | `Multisafepay_ShipmentNotified` | boolean | Set once the shipment has been notified to MSP; prevents duplicate notifications. |
| `PaymentTransaction` | `Multisafepay_CapturedAt` | string | ISO timestamp of the manual capture. |
| `PaymentTransaction` | `Multisafepay_FinancialStatus` | string | MSP financial status from the notification (e.g. `initialized` while awaiting capture). |
| `PaymentTransaction` | `Multisafepay_CaptureExpiry` | string | Deadline by which an authorized payment must be captured. |
| `PaymentTransaction` | `Multisafepay_PaymentBreakdown` | text | JSON array of the `payment_methods` reported by MSP (coupons / gift cards and payment method). |
| `PaymentTransaction` | `Multisafepay_Gateway` | string | Gateway, overwritten with the method actually used on the payment page. |
| `PaymentTransaction` | `Multisafepay_OrderStatus` | string | Last MSP order status. |
| `PaymentTransaction` | `Multisafepay_AmountRefunded` | double | Refunded amount (major units). |
| `PaymentTransaction` | `Multisafepay_log` | text | JSON response of `POST /orders`. |
| `OrderPaymentInstrument` | `Multisafepay_Gateway` | string | Selected gateway, overwritten with the method actually used. |

The newer attributes are read and written inside a `try/catch`, so deploying the code before
importing the metadata does not break checkout, the sync or the webhook; the related features stay
inactive until the import.

---

## 7. Client-side components (`cartridges/multisafepay/cartridge/client`)

### `checkout/msp_checkout.js`
- `initMethodSelection()`: binds the `msp-payment-method` radios, writes the hidden `gatewayMSP`
  field and shows or hides the Payment Component according to `data-requires-component`. Runs on
  page load and on `checkout:updateCheckoutView` when the stage is `payment`.
- `initPaymentComponent(gateway)`: requests a token from `window.componentTokenURL`
  (`Multisafepay-GetComponentToken`), creates `new MultiSafepay({env, apiToken, order})` and calls
  `init('payment', {container: '#MultiSafepayPayment', gateway})`.
- `capturePaymentData()`: reads `payment_data` from the component while it is still visible (before
  the stage changes to Place Order) and keeps it in memory.
- `createOrder()`: returns `{gateway, payment_data}` (JSON string) for the `PlaceOrder` request.

### Other files
`checkout.js`, `checkout/billing.js`, `checkout/giftCard.js` and the files in `components/` are
SFRA overrides that integrate the MSP flow, Gift Certificates and client-side validation. Styles
are in `scss/checkout_msp.scss` and `scss/multisafepay.scss`.

---

## 8. Security

- **Webhook**: HMAC-SHA512 signature over `timestamp:body` keyed with the active API key
  (`webhookHelper.check`). Notifications without a valid signature are not processed and receive
  `notifyError`.
- **API key**: never sent to the browser. The Payment Component receives only a short-lived token
  from `GET /auth/api_token`.
- **CSRF**: `CheckoutServices-SubmitPayment` uses `csrfProtection.validateAjaxRequest` (SFRA); the
  Business Manager `Start` pages generate a CSRF token. The other MSP routes do not validate one.
- **HTTPS**: all MSP routes use `server.middleware.https`; the webhook, redirect and cancel URLs are
  built with `URLUtils.https(...).abs()`.
- **Live environment**: the test key is never used as a fallback.
- **Shopper messages**: configuration failures show one generic message; the cause is logged only.

---

## 9. Logging and diagnostics

- Connector diagnostics are written with `Logger.getLogger('multisafepay', 'MSP')`: file prefix
  `multisafepay` (custom log files `custom-multisafepay-*`), category **`MSP`**. A few messages in
  `Multisafepay.js`, `webhookHelper.js`, `hooks/authorize.js` and `MultisafepaySettings-Save` use
  the root logger.
- The `MSP` category must be enabled in Business Manager (**Administration → Operations → Custom
  Log Settings**) at the required level for its messages to be recorded. At `INFO` the connector
  logs request URLs, order numbers, statuses and results. Payloads that carry customer data (the
  `POST /orders` body, the webhook notification body, the capture response) are logged at `DEBUG`
  only; enable `DEBUG` for diagnosis on a test instance, not in production.
- The `custom.MSP.NotifyShipments` job reports failures in its Job History status message,
  independently of log settings.
- The order Payment tab renders the capture decision (gateway, statuses, preference and
  `supportsCapture` values) as an HTML comment, readable through the page source.

---

## 10. Build, deploy and testing

### Local setup
1. `npm install`
2. Create `dw.json` in the root with `hostname`, `username`, `password` (WebDAV access key),
   `code-version`.
3. `npm run build` compiles the client JS and SCSS of the `multisafepay` cartridge
   (`packageName` in `package.json`) into its `static` folder. It does not compile the SFRA
   base cartridges, which must already be built and deployed on the instance.
4. Upload `multisafepay` and `bm_multisafepay` with `npx sgmf-scripts --uploadCartridge <name>`,
   or use `npm run watch`. An upload replaces the whole cartridge on the instance.

### Deploy
1. Import `metadata/site-import` (Site Import & Export).
2. Ensure `multisafepay` precedes `app_storefront_base` in the cartridge path (the `address.xml`
   override and the checkout templates depend on it).
3. Make sure the `MultiSafepayPayment` payment method has a payment processor and the webhook URL
   is reachable from MSP.
4. Run **Sync & Import** on the settings page and confirm in Job History that
   `MSP-ImportPaymentMethods` finished OK; until it does, the `MSP_<gatewayId>` methods keep their
   previous country lists.
5. *(BNPL)* Create a job with the `custom.MSP.NotifyShipments` step and schedule it per site.

### Main NPM scripts
| Script | Action |
|---|---|
| `npm test` | Connector test suite: `node --test test/msp/*.test.js`. |
| `npm run test:msp` | Alias of `npm test`. |
| `npm run test:sfra` | SFRA base unit tests (Mocha via `sgmf-scripts`, `test/unit`). |
| `npm run compile:js` / `compile:scss` | Compiles client JS / CSS with `--openssl-legacy-provider` (`compileUnix:*` and `compilev16:*` variants exist). |
| `npm run build` | Compiles JS + fonts + SCSS. |
| `npm run watch` | Watch + automatic upload. |
| `npm run lint` | Lints JS + CSS. |
| `npm run cover` | SFRA coverage (`test/unit`). |
| `npm run test:integration` | SFRA integration tests (requires `dw.json`). |
| `npm run test:acceptance:*` | CodeceptJS acceptance tests (smoke/desktop/mobile/…). |

### Testing
The connector suite in `test/msp/` runs on Node's built-in test runner and needs no installed
dependencies. `test/msp/helpers/sfccModules.js` patches `Module._load` to serve stubs for the `dw/*`
and `*/cartridge/...` modules, because most SFCC requires in the cartridges are made inside
functions. The suites cover the payment-method mapper (including a recorded `/payment-methods`
response from the MSP test API, `fixtures-payment-methods.json`), the sync and the generated XML,
the checkout filter, the HTTP calls and verbs, the order payload, the shipment job, and contract
checks on templates and forms.

### Git hooks (Husky)
Configured in `package.json`:
- `pre-commit`: `npm run lint`
- `pre-push`: `npm run test`

### CI
`.github/workflows/test.yml` (GitHub Actions) runs `npm test` on every push and pull request, on
Node 22 and 24, without `npm install`.

---

## 11. MultiSafepay API reference

| Operation | Request |
|---|---|
| Test base | `https://testapi.multisafepay.com/v1/json/` |
| Live base | `https://api.multisafepay.com/v1/json/` |
| Payment methods (sync) | `GET /payment-methods?group_cards=<0\|1>&include_coupons=1` |
| Payment methods (`Multisafepay-GetPaymentMethods`) | `GET /payment-methods?country&currency&locale&group_cards=<0\|1>&include_coupons=1` |
| Component token / key check | `GET /auth/api_token` |
| Create order | `POST /orders` |
| Order status | `GET /orders/{orderNo}` |
| Mark shipped | `PATCH /orders/{orderNo}` |
| Capture | `POST /orders/{orderNo}/capture` |
| Refund | `POST /orders/{orderNo}/refunds` |
| Transactions | `GET /transactions?limit&offset` |

Authentication: `Authorization: Bearer <apiKey|token>` header. The MSP order ID is the SFCC order
number.

---

## 12. Operational notes and known limitations

- The order is placed on notification (webhook, or the `Multisafepay-Confirm` fallback query), not
  when the shopper is redirected to MSP.
- The payment-method list is rendered server-side when the billing step is rendered. Changing the
  billing country in the form does not refresh it. The billing address is saved on the basket when
  the payment step is submitted, and the list reflects the new country the next time the billing
  step is rendered.
- Country availability comes only from MSP's `allowed_countries`; to change it, change the method
  in the MSP account and re-run Sync & Import. Customer-type restrictions are not exposed by MSP;
  they are configured as customer groups on the `MSP_<gatewayId>` payment methods.
- Enabling Manual Capture affects orders created afterwards; the `capture: 'manual'` instruction is
  sent when the order is created.
- MSP capture is always for the full amount.
- A refund always needs an explicit amount; the order-detail box does not send a refund with an
  empty or non-positive amount field. A comma is accepted as the decimal separator.
- Dashboard pagination of `GET /transactions` uses `limit`/`offset`; if the endpoint ignores them,
  de-duplication stops after the first page.
- The OCAPI import requires an Account Manager API client with access to the Data API job
  executions resource and the corresponding OCAPI settings; without them the import is run
  manually.
- Recurring payments and POS / omnichannel payments are not included in this version (planned).
