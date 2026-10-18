# Platform User Guide — MultiSafepay for Salesforce Commerce Cloud

> Operational guide for **merchants and administrators** who manage MultiSafepay payments
> from the Salesforce B2C Commerce Business Manager, plus an overview of the shopper's
> payment experience.

---

## Table of Contents
1. [Who this guide is for](#1-who-this-guide-is-for)
2. [Prerequisites](#2-prerequisites)
3. [Initial setup (one-time)](#3-initial-setup-one-time)
4. [Synchronizing and importing payment methods](#4-synchronizing-and-importing-payment-methods)
5. [Managing payment methods](#5-managing-payment-methods)
6. [Manual Capture](#6-manual-capture)
7. [Refunds](#7-refunds)
8. [Transactions dashboard](#8-transactions-dashboard)
9. [Shopper payment experience](#9-shopper-payment-experience)
10. [Order and payment statuses](#10-order-and-payment-statuses)
11. [Switching from Test to Live](#11-switching-from-test-to-live)
12. [Troubleshooting (FAQ)](#12-troubleshooting-faq)
13. [Scheduling the shipment notification job (BNPL)](#13-scheduling-the-shipment-notification-job-bnpl)

---

## 1. Who this guide is for

- **Merchants / e-commerce managers**: account configuration, payment-method management,
  refunds and monitoring.
- **Business Manager administrators**: initial setup, OCAPI, Test/Live environments.
- **Support teams**: understanding order statuses and capture/refund operations.

No programming knowledge is required. For technical details see the companion
[Technical Documentation](./technical%20documentation.md).

**Scope of this version.** Recurring payments and POS / omnichannel payments are not
included.

---

## 2. Prerequisites

Before you start you need:
- A **MultiSafepay account** (test and/or live) — sign up at
  [multisafepay.com](https://www.multisafepay.com/).
- The MultiSafepay **API key(s)**:
  - Test: from the [test merchant dashboard](https://testmerchant.multisafepay.com/)
  - Live: from the [merchant dashboard](https://merchant.multisafepay.com/)
  - MultiSafepay guide: [docs.multisafepay.com/docs/sites](https://docs.multisafepay.com/docs/sites)
- Access to the SFCC **Business Manager** with permissions on Site Preferences and (for the
  automatic import) on Account Manager / OCAPI.
- The `multisafepay` and `bm_multisafepay` cartridges installed: `multisafepay` in the
  storefront site's cartridge path **ahead of** `app_storefront_base`, and `bm_multisafepay`
  in the Business Manager cartridge path.

---

## 3. Initial setup (one-time)

### Step 0 — Import the metadata

The connector stores data on custom attributes and a custom object type that do
not exist in a stock Salesforce instance. **This import creates them, and it has to
run before anything else** — before setting the API keys, before the first
synchronization. Without it the settings page and the order detail are partially
blank, because the fields they read are not defined.

Import it again **after every deploy** of the cartridges (see
[After every deploy](#after-every-deploy)). The import is idempotent: importing the same
archive twice is harmless.

**The file.** `metadata/site-import` in the repository, packaged as a ZIP whose
internal structure is:

```
msp-metadata-import.zip
└── msp-metadata-import/
    ├── services.xml
    └── meta/
        └── system-objecttype-extensions.xml
```

The folder name inside the archive must match the archive name, otherwise the
importer skips the file without reporting it.

**The procedure.**

1. Go to **Administration → Site Development → Site Import & Export**.
2. Under **Upload Archive**, select **Local**, choose the ZIP and click **Upload**.
   The archive appears in the list below.
3. Select its radio button and click **Import**. Confirm.
4. Wait for the page to refresh: the archive appears in the **Status** list at the
   bottom of the page.

**The expected result.** The Status row must read **Success**. Click the process
name to open the job log. The metadata part of the log contains lines like these:

```
Archive validation completed without errors.
============ Starting import unit MetaDataImport
Importing file instance/msp-metadata-import/meta/system-objecttype-extensions.xml ...
Processed 3 type-extension elements successfully
Processed 1 custom-type element successfully
Processed 4 total elements
============ Import Results (SUMMARY)
The instance import completed successfully.
```

**3 type-extensions** (SitePreferences, Order, PaymentTransaction) and
**1 custom-type** (MSPPaymentMethod) is the whole of the connector's metadata. A
run that reports fewer elements imported an older archive. `services.xml` (the
`Multisafepay.GenerateApiToken` service) is imported by the same archive and appears
in the log as a separate section.

You can confirm the result in the UI too: **Administration → Site Development →
Custom Object Types** must list **MSPPaymentMethod**.

> **Do not confuse this page with Administration → Site Development → Import &
> Export.** That page has its own separate *Meta Data* section with its own Status
> list, and entries there persist — an old **Error** row stays visible and has
> nothing to do with your import. The Site Import & Export page is the one that
> matters, and its log is the authority.

### Step 1 — Open the settings page
In Business Manager: **Merchant Tools → Site Preferences → Multisafepay settings**
(MultiSafepay icon in the Site Preferences menu). The page has an **Account settings**
section and a **Payment Methods** box.

### Step 2 — Set the environment and keys
In the **Account settings** section:

| Field | Description |
|---|---|
| **Environment** | Choose `Test` for the MultiSafepay test environment, `Live` for production. |
| **Multisafepay Test API Key** | The Test-environment API key (used when Environment = Test). |
| **Multisafepay Live API Key** | The Live-environment API key (used when Environment = Live). |
| **Multisafepay OMS Salesforce** | Records whether the site is integrated with Salesforce Order Management. This version of the connector stores the setting but does not change its behaviour based on it. |
| **Manual Capture** | Enable to authorize payments without capturing them automatically (see §6). |
| **Group Card Methods** | Enable to show a single **"Credit Card"** method at checkout (card schemes grouped, `group_cards=1`). Disable to show Visa, Mastercard, Amex and Maestro individually (`group_cards=0`). **Re-run Sync & Import after changing this.** |

Click **Save Changes**. A confirmation banner (*"Your Changes have been saved"*) appears.
**Cancel** discards unsaved changes by reloading the page.

> The key is selected automatically from the chosen environment. In **Live** mode the
> connector never uses the Test key. If the key for the active environment is empty, the
> connector falls back to the legacy `Multisafepay_ClientKey` preference, when one is set.

### Step 3 (optional) — Configure OCAPI for automatic method import
**Sync & Import** can import the payment methods into Salesforce automatically by starting
the `MSP-ImportPaymentMethods` job through OCAPI (see §4). This requires a one-time
configuration. The **"OCAPI setup"** panel on the settings page summarizes it:

1. In **Account Manager**, create (or reuse) an API Client. The connector requests its
   access token with the client-credentials grant and sends the client ID and secret as
   HTTP Basic credentials.
2. In BM: **Administration → Site Development → Open Commerce API Settings → Data API →
   Global**, grant your `client_id` the resource the connector calls to start the job,
   `/jobs/*/executions` with method `post`. For example:
   ```json
   {"_v":"24.5","clients":[{"client_id":"YOUR_CLIENT_ID","resources":[
     {"resource_id":"/jobs/*/executions","methods":["post"],"read_attributes":"(**)","write_attributes":"(**)"}
   ]}]}
   ```
   The same snippet is shown in the *OCAPI setup* panel on the settings page.
3. In BM: **Merchant Tools → Site Preferences → Custom Preferences → Multisafepay Account
   Settings**, set **OCAPI Client ID** and **OCAPI Client Secret**.

The job itself must exist on the instance with the ID **`MSP-ImportPaymentMethods`**. It
imports the archive `msp-payment-methods.zip` that the sync writes to the instance import
folder (`IMPEX/src/instance`) — for example with the system job step **ImportSiteArchive**.

> If OCAPI is not configured, the methods are still synchronized as Custom Objects, but
> the creation of the SFCC Payment Methods is not started. Import the generated
> `msp-payment-methods.zip` manually from **Administration → Site Development → Site
> Import & Export**.

### Step 4 — Country availability (nothing to configure)
Country availability is **not configured in Salesforce**. It comes from MultiSafepay: the
Sync reads each method's `allowed_countries` and stores it as-is.

* A method with `allowed_countries: []` on the MultiSafepay side has **no country
  restriction** and is offered to every shopper.
* A method that MultiSafepay restricts to certain countries (for example NL only) is
  offered only to shoppers whose **billing address** is in one of those countries.

To change where a method is available, change it in your MultiSafepay account and re-run
**Sync & Import**.

---

## 4. Synchronizing and importing payment methods

The available payment methods depend on your MultiSafepay account. To align them:

1. On the **Multisafepay settings** page, in the **Payment Methods** box, click
   **↻ Sync & Import**.
2. The connector:
   - requests your full payment-method catalogue from MultiSafepay in a single call to
     `/payment-methods`, without any country or currency filter (card grouping follows
     **Group Card Methods**; gift cards and coupons are included);
   - stores each method with the restrictions MultiSafepay reports for it — allowed
     countries, allowed currencies, minimum/maximum amount — and whether it supports
     manual capture (Custom Object `MSPPaymentMethod`);
   - adds new methods as **enabled** and disables methods MultiSafepay no longer offers;
   - generates the Payment Methods archive and, if OCAPI is configured, starts the
     **`MSP-ImportPaymentMethods`** job, which creates or updates the SFCC payment methods
     `MSP_<gateway>` under **Merchant Tools → Ordering → Payment Methods**, including their
     country lists.
3. A message at the top of the box reports the outcome:
   - *"Done! Synced N methods. Import job triggered. Check Job History for status."*
   - *"Synced OK (N methods), but import failed: …"* — the methods were stored but the
     import job was not started (see §12).
   - *"Error: …"* — nothing was changed (for example an invalid API key).
4. Check **Administration → Operations → Job History** and confirm that
   **`MSP-ImportPaymentMethods`** finished **OK**.

> The Sync does **not** clear the existing configuration if MultiSafepay returns no
> methods (for example with a wrong key): you receive an error message instead.

### After every deploy

After every deploy of the cartridges:

1. Import the metadata (§3, Step 0).
2. Re-run **Sync & Import**.
3. Confirm in **Job History** that **`MSP-ImportPaymentMethods`** finished **OK**.

The third step applies the synchronized country lists to the `MSP_*` payment methods. If
it is skipped, checkout keeps the previous restrictions.

---

## 5. Managing payment methods

In the **Payment Methods** box each method shows its icon, name and gateway ID, an
**on/off** toggle, and:

- an **Inline** badge for methods with in-page data entry (MultiSafepay Payment Component);
- a **Capture** badge for methods that support manual capture (§6);
- a **min / max** badge when MultiSafepay sets an amount range for the method;
- its allowed countries, or **All countries** when MultiSafepay reports no country
  restriction;
- its allowed currencies, when MultiSafepay restricts them.

The list shown right after a sync is condensed; reload the page to see all badges.

- **Enable/disable** a method with its toggle. The change applies to checkout immediately,
  and the connector regenerates the Payment Methods archive and starts the import job again
  so **Merchant Tools → Ordering → Payment Methods** stays aligned.
- A method appears at the shopper's checkout only if **all** of these hold:
  - it is **enabled** here;
  - the shopper's **billing country** is among its allowed countries, or the method has
    no country restriction;
  - the cart **currency** is among its allowed currencies, or it has no currency
    restriction;
  - the cart **amount** is within the method's min/max;
  - the corresponding SFCC payment method (`MSP_<gateway>`), once imported, is **active**
    and applicable (customer group, country, currency, amount range).

  Methods that fail any rule are neither shown nor selectable. Until a billing address is
  entered, the shipping country (or the storefront locale) is used for the country rule.

---

## 6. Manual Capture

Manual capture lets you **authorize** the payment at checkout and **capture** (charge) the
amount later (for example at shipment).

### Enabling
Multisafepay settings → **Manual Capture** = enabled → **Save Changes**.

> **Enable it before the order you intend to capture is placed.** Whether a payment is
> authorized for manual capture is decided when the order is placed, and travels with the
> order. Turning the setting on afterwards does not make an order that was already placed
> capturable — that payment is captured automatically, and no Capture button appears for
> it.

### Which methods can be captured
Only methods for which MultiSafepay reports both `manual_capture.supported` and
`manual_capture.is_enabled`. These are typically card schemes; instant methods such as
iDEAL and bank transfer cannot be captured, and buy-now-pay-later methods are settled by
notifying the shipment instead (see §13), never by the Capture button.

For any other method, the Manual Capture setting has no effect: the order is processed
as usual.

The settings page marks capturable methods with a **Capture** badge. That badge is the
authoritative list for your account — after changing manual capture in your MultiSafepay
account, re-run **Sync & Import** and the badges follow.

### Performing the capture
1. Open the order detail: **Merchant Tools → Ordering → Orders → [order]**, and open its
   **Payment** tab.
2. In the MultiSafepay box, **Capture Status** reads *"Awaiting capture"*, and **Capture
   Expiry** shows the deadline after which MultiSafepay releases the authorization.
3. Click **CAPTURE FULL PAYMENT** and confirm.
4. Once captured, the page reloads and the status reads *"Captured on [date/time]"*.

The **CAPTURE FULL PAYMENT** button appears only when **all** of these hold:

| Condition | How to check it |
|---|---|
| The payment was placed with manual capture | The box shows a **Capture Expiry** value. MultiSafepay returns that deadline only for a payment it holds as an authorization |
| The payment is authorized but not settled | **Order Status from MSP platform** = `completed`, and the payment is not yet captured, refunded, cancelled, declined or expired |
| It has not been captured already | **Capture Status** does not read *"Captured on …"* |

For orders that fall outside these conditions, the button is hidden.

> MultiSafepay capture always captures the **full** authorized amount. The amount field in
> the box applies to **refunds only**.

---

## 7. Refunds

Refunds (full or partial) are performed from the order detail in Business Manager.

1. Open **Merchant Tools → Ordering → Orders → [order]**, and open its **Payment** tab.
2. In the MultiSafepay box:
   - Enter the **amount** to refund in the refund amount field (the full order amount for
     a full refund).
   - Click **REFUND PAYMENT**.
3. A message confirms the request (*"Refund successful!"*) or shows the reason it failed.
4. Once MultiSafepay has processed the refund:
   - **Full refund** → order payment status = *Not Paid*.
   - **Partial refund** → order payment status **stays *Paid***; the refunded amount is
     shown separately as **Amount Refunded** in the box.

> The payment status changes when MultiSafepay confirms the refund through its
> notification (webhook), not when the refund is requested.

---

## 8. Transactions dashboard

**Merchant Tools → Analytics → Multisafepay dashboard** shows a summary of your
MultiSafepay transactions:
- **Today's orders** and **Total orders** (number of payment transactions).
- **Today's refunds** and **Total refunds** (number of refund transactions).
- Charts of **revenue** and **returns** (amounts) over the last 7 days.

The data is read from the MultiSafepay API of the active environment each time the page
opens.

---

## 9. Shopper payment experience

1. At **checkout**, in the payment step, the shopper sees the MultiSafepay methods
   available for their billing country, cart currency and cart amount, each with a logo
   and name. The first method is preselected.
2. On selecting a method:
   - **"Inline" methods** (for example credit cards): a data-entry form appears directly in
     the page (MultiSafepay Payment Component).
   - **Other methods** (iDEAL, PayPal, BNPL, etc.): no additional in-page fields.
3. At **Place Order**:
   - **Inline methods**: the payment data entered in the page is sent directly
     (*direct* mode). If MultiSafepay does not accept the direct request, the connector
     retries it as a redirect.
   - **Other methods** (*redirect* mode): the shopper is taken to the secure MultiSafepay
     payment page, completes the payment and is returned to the store.
4. **Confirmation**: on a successful return the shopper sees the order confirmation page
   and receives the confirmation email. If the payment was not completed, the shopper is
   returned to the cart. On **cancellation**, the cart is restored and the shopper is
   returned to checkout to retry.
5. **Gift Certificate**: the shopper can apply/remove gift certificates at checkout; the
   remaining balance is paid with the selected MultiSafepay method.

> The MultiSafepay payment page **expires after 1 hour**: after that the payment session
> is no longer valid.

---

## 10. Order and payment statuses

MultiSafepay communicates the payment status through notifications (webhook). The webhook
address is sent with every payment, so nothing needs to be configured for it on the
MultiSafepay side. Mapping onto SFCC orders:

| MultiSafepay status | Meaning | Effect on the SFCC order |
|---|---|---|
| `completed` / `shipped` | Payment successful | Order placed, payment status **Paid**, ready for export, confirmation email sent. |
| `uncleared` | Authorized, not yet settled (typical of BNPL before shipment) | Order placed, payment status **Not Paid**, confirmation email sent. A later `completed` / `shipped` sets it to **Paid**. |
| `initialized` | Payment started | No action. |
| `reserved` | Action pending (for example a refund) | No action; the status is recorded. |
| `refunded` | Full refund | Payment status **Not Paid**. |
| `partial_refunded` | Partial refund | Payment status **stays Paid**; refunded amount shown as *Amount Refunded*. |
| `declined` | Declined | Order **failed**. |
| `expired` | Expired | Order **failed**. |
| `cancelled` / `void` | Cancelled | Order **failed**. |

A card payment held for manual capture reports `completed` as its order status; the Capture
button (§6) settles it.

### The MultiSafepay box in the order detail

The order's **Payment** tab in Business Manager contains a MultiSafepay box with:

- **Multisafepay_Gateway** — the method actually used (if the shopper switched method on
  the MultiSafepay payment page, the method they paid with);
- **Transaction ID**;
- **Order Status from MSP platform**, colour-coded: green (completed/shipped), orange
  (refunded/partial_refunded), red (declined/expired/cancelled/void), grey (others);
- **Capture Status** and **Capture Expiry**, for payments placed with manual capture;
- **Amount Refunded**, once a refund has been processed;
- a **Gift card breakdown** when gift certificates were used, and an **MSP payment
  breakdown** when the payment was split on the MultiSafepay payment page;
- the refund amount field, **REFUND PAYMENT** and, when applicable, **CAPTURE FULL
  PAYMENT**.

---

## 11. Switching from Test to Live

1. Enter the **Multisafepay Live API Key** in the settings.
2. Change **Environment** to **Live** → **Save Changes**.
3. Run **Sync & Import** to load the live account's payment methods, and confirm that
   **`MSP-ImportPaymentMethods`** finished **OK** in Job History.
4. Verify that the desired methods are **enabled**.
5. Place a real order (minimum amount) to validate the end-to-end flow, including
   webhook receipt and order confirmation.

> Test and Live use separate MultiSafepay keys and dashboards. Make sure the key matches
> the selected environment.

---

## 12. Troubleshooting (FAQ)

**Payment methods do not appear at checkout.**
- *Cause:* the method is disabled, does not pass one of the checkout rules (billing
  country, currency, amount, SFCC payment method active and applicable — see §5), or the
  last import did not run.
- *What to do:* check the method's toggle and badges on the settings page; run **Sync &
  Import** and confirm **`MSP-ImportPaymentMethods`** finished **OK**; check the
  `MSP_<gateway>` method under **Merchant Tools → Ordering → Payment Methods**.

**Checkout shows "Online payment is temporarily unavailable. Please contact the store for assistance." and the pay button is disabled.**
- *Cause:* the API key of the active environment is missing, or MultiSafepay rejects it
  (401/403). The shopper always sees the same generic message; the reason is written to
  the `MSP` log category (see the last entry).
- *What to do:* enter a valid key for the active environment in the settings. The block
  clears as soon as a valid key is in place. Temporary connection errors do not block
  checkout.

**Checkout shows "No payment methods are available for this order."**
- *Cause:* the key is valid, but no enabled method passes the checkout rules for this cart,
  or no method has been synchronized yet.
- *What to do:* see the first entry.

**Sync & Import reports "Authentication failed (401)".**
- *Cause:* the API key is not valid for the selected environment.
- *What to do:* correct the key for the active environment in the settings and run the
  sync again.

**Sync & Import reports "No payment methods could be retrieved from the MSP API".**
- *Cause:* MultiSafepay returned an empty catalogue for this key — wrong account or
  environment, or no payment methods active on the account. The existing configuration is
  left unchanged.
- *What to do:* check the key and the payment methods activated in your MultiSafepay
  account.

**Sync & Import reports "Synced OK (N methods), but import failed: …".**
- *Cause:* the methods were stored, but the import job could not be started.
  *"OCAPI credentials not configured"* means the OCAPI Client ID or Secret is empty;
  *"Job trigger failed (HTTP …)"* means OCAPI refused the request or the job
  `MSP-ImportPaymentMethods` does not exist.
- *What to do:* complete the OCAPI setup (§3, Step 3), or import the generated archive
  manually.

**A country or method change made on MultiSafepay does not show at checkout.**
- *Cause:* **Sync & Import** has not been run since the change, or the
  `MSP-ImportPaymentMethods` job did not finish OK, so the SFCC payment methods keep their
  previous country lists.
- *What to do:* run **Sync & Import** and confirm the job finished **OK** in Job History.

**The settings page or the order detail is partly blank.**
- *Cause:* the metadata has not been imported on this instance.
- *What to do:* import it (§3, Step 0), then run **Sync & Import**.

**A European postal code (for example Dutch "1012 AB") is rejected at checkout.**
- *Cause:* the base SFRA address form accepts only US and Canadian formats. The
  `multisafepay` cartridge replaces it with a form that accepts numeric and alphanumeric
  postal codes, but only when it precedes `app_storefront_base` in the cartridge path.
- *What to do:* put `multisafepay` ahead of `app_storefront_base` in the site's cartridge
  path.

**The order shows as paid only after a few moments.**
- *Cause:* payment confirmation arrives through MultiSafepay's asynchronous notification
  (webhook). This is expected.

**The CAPTURE FULL PAYMENT button is not shown.**
- *Cause:* one of the conditions in §6 does not hold. Most often the order was placed
  before **Manual Capture** was enabled, the method does not support capture (no
  **Capture** badge), or the payment has already been captured.
- *What to do:* check the conditions in §6. An order placed without manual capture is
  captured automatically and cannot be captured from Business Manager.

**Dashboard charts (revenue / returns over the last 7 days) are empty.**
- *Cause:* there were no payments or refunds in the last 7 days in the active environment.
  The cards show counts; the charts show amounts.

**A refund was requested but the payment status did not change.**
- *Cause:* the payment status changes when MultiSafepay **confirms** the refund through
  the webhook, not when it is requested.
- *What to do:* check the transaction in your MultiSafepay dashboard.

**The shipment notification job ends in ERROR.**
- See §13, Step 4.

**Where do I find the technical logs?**
- The connector writes its diagnostics to the custom log category **`MSP`**, in log files
  whose names start with `custom-multisafepay`. Custom log categories are recorded only
  when they are enabled: go to **Administration → Operations → Custom Log Settings** and
  enable the `MSP` category at the level you need (INFO for full traces).
- Read the files under **Administration → Site Development → Development Setup → Log
  Files**.

---

## 13. Scheduling the shipment notification job (BNPL)

Buy-now-pay-later providers (Riverty, Klarna, Billink, in3) invoice the shopper only once
the order has shipped. Marking an order as **Shipped** in Business Manager does not raise
a storefront event, so a scheduled job reports it to MultiSafepay.

Without this job, BNPL orders stay authorized on the MultiSafepay side and are never
invoiced.

### Step 1 — Create the job

1. Go to **Administration → Operations → Jobs** and click **New Job**.
2. Name it, for example, `MSP-NotifyShipments`. Confirm.

### Step 2 — Add the job step

1. Open the **Job Steps** tab and click the **+** button.
2. Choose **Configure a step** → pick **`custom.MSP.NotifyShipments`**.
   *If it is not in the list, the `multisafepay` cartridge is not on the cartridge path of
   the site you selected, or the code version has not been activated.*
3. Give the step an ID, for example `notify-shipments-msp`.
4. In **Scope**, select the **site(s)** that use MultiSafepay (for example `RefArch`).
   The step is site-scoped: an organization-level scope does not work.
5. Save.

### Step 3 — Schedule it

1. Open the **Schedule and History** tab.
2. Tick **Enabled**.
3. Set a **Recurring Interval** — hourly is a sensible default.
4. Save.

### Step 4 — Verify

1. Place a test order with a BNPL method and let it complete.
2. In **Merchant Tools → Ordering → Orders**, open the order and set its
   **Shipping Status** to **Shipped**.
3. Run the job with **Run Now** on the job's page.
4. Check **Administration → Operations → Job History**:
   * **OK** — the status message reads `Notified N of M MultiSafepay order(s).`
   * **ERROR** — the status message names the failing order and carries the MultiSafepay
     error, for example
     `1 of 3 MultiSafepay order(s) could not be notified. Last error: order <order number> - HTTP <status>: <MultiSafepay error>`.
     *"No MultiSafepay API key configured."* means the active environment has no key.
     Fix the cause and run the job again; orders that failed are retried on the next run.
5. In the MultiSafepay dashboard the transaction status becomes **Shipped** and the BNPL
   provider invoices the shopper.

### What the job does and does not do

* It considers only orders that are **Shipped**, still **Open**, and paid with
  MultiSafepay.
* It updates each order on MultiSafepay to status **shipped** (an HTTP `PATCH` to the
  MultiSafepay order). If MultiSafepay rejects an update, the job ends in **ERROR** and
  names the failing order.
* Each order is notified **once**: a flag on the order (`Multisafepay_ShipmentNotified`)
  prevents duplicates, so running the job more often is harmless.
* Every update carries the three fields MultiSafepay requires with status *shipped*:
  - **tracking code** — the shipment's tracking number, or the order number when the
    shipment has none;
  - **carrier** — the shipment's shipping method name, or `Unknown` when there is none;
  - **ship date** — the time of the job run.
* It does **not** capture card payments — that is the separate **Manual Capture** flow in
  section 6.

> **Prerequisite.** The job needs the `Multisafepay_ShipmentNotified` attribute from
> `metadata/site-import`. If the metadata has not been imported, the job reports an error
> instead of notifying MultiSafepay again on every run.
