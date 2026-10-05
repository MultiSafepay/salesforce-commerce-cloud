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

---

## 2. Prerequisites

Before you start you need:
- A **MultiSafepay account** (test and/or live) — sign up at
  [multisafepay.com](https://www.multisafepay.com/).
- The MSP **API key(s)**:
  - Test: from the [test merchant dashboard](https://testmerchant.multisafepay.com/)
  - Live: from the [merchant dashboard](https://merchant.multisafepay.com/)
  - MSP guide: [docs.multisafepay.com/docs/sites](https://docs.multisafepay.com/docs/sites)
- Access to the SFCC **Business Manager** with permissions on Site Preferences and (for the
  automatic import) on Account Manager / OCAPI.
- The `multisafepay` and `bm_multisafepay` cartridges installed in the site's cartridge path.

---

## 3. Initial setup (one-time)

### Step 0 — Import the metadata

The connector stores data on custom attributes and a custom object type that do
not exist in a stock Salesforce instance. **This import creates them, and it has to
run before anything else** — before setting the API keys, before the first
synchronization. Skipping it leaves the settings page and the order detail
partially blank, because the fields they read are not defined.

Re-run it whenever you deploy a version of the cartridges whose release notes
mention new or changed metadata. It is idempotent: importing the same archive
twice is harmless.

**The file.** `metadata/site-import` in the repository, packaged as a ZIP whose
internal structure is:

```
msp-metadata-import.zip
└── msp-metadata-import/
    └── meta/
        └── system-objecttype-extensions.xml
```

The folder name inside the archive must match the archive name, otherwise the
importer skips the file without saying so.

**The procedure.**

1. Go to **Administration → Site Development → Site Import & Export**.
2. Under **Upload Archive**, select **Local**, choose the ZIP and click **Upload**.
   The archive appears in the list below.
3. Select its radio button and click **Import**. Confirm.
4. Wait for the page to refresh: the archive appears in the **Status** list at the
   bottom of the page.

**The expected result.** The Status row must read **Success**. Click the process
name to open the job log and confirm these lines:

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
run that reports fewer elements imported an older archive.

You can confirm the result in the UI too: **Administration → Site Development →
System Object Types → Custom Object Definitions** must list **MSPPaymentMethod**.

> **Do not confuse this page with Administration → Site Development → Import &
> Export.** That page has its own separate *Meta Data* section with its own Status
> list, and entries there persist indefinitely — a red **Error** row from months
> ago stays visible forever and has nothing to do with your import. The Site
> Import & Export page is the one that matters, and its log is the authority.

### Step 1 — Open the settings page
In Business Manager: **Merchant Tools → Site Preferences → Multisafepay settings**
(MultiSafepay icon in the Site Preferences menu).

### Step 2 — Set the environment and keys
In the **Account settings** section:

| Field | Description |
|---|---|
| **Environment** | Choose `Test` for the test environment, `Live` for production. |
| **Multisafepay Test API Key** | The Test-environment API key (used when Environment = Test). |
| **Multisafepay Live API Key** | The Live-environment API key (used when Environment = Live). |
| **Multisafepay OMS Salesforce** | Enable if the system is integrated with Salesforce OMS. |
| **Manual Capture** | Enable to authorize payments without capturing them automatically (see §6). |
| **Group Card Methods** | Enable to show a single **"Credit Card"** method at checkout (grouped card schemes, `group_cards=1`). Disable to show Visa, Mastercard, Amex, Maestro individually (`group_cards=0`). **Re-run Sync & Import after changing this.** |

Click **Save Changes**. A green message confirms the save.

> ⚠️ The correct key is selected automatically based on the chosen environment.
> In **Live** mode the system never uses the Test key.

### Step 3 (optional) — Configure OCAPI for automatic method import
The automatic import of methods into Salesforce requires a one-time OCAPI configuration.
Expand the **"OCAPI setup"** panel on the settings page and follow the 3 points:

1. In **Account Manager**, create (or reuse) an API Client with OCAPI Data permissions.
2. In BM: **Administration → Site Development → Open Commerce API Settings → Data API →
   Global**, add the resource for `/sites/*/payment_methods/*` (method `put`) for your
   `client_id`.
3. In BM: **Merchant Tools → Site Preferences → Custom Preferences → Multisafepay**,
   set the **OCAPI Client ID** and **OCAPI Client Secret**.

> If OCAPI is not configured, the methods are still synchronized as Custom Objects but the
> import into SFCC (creation of the Payment Methods) must be run manually by importing the
> generated archive.

### Step 4 — Country availability (nothing to configure)
Country availability is **not configured in Salesforce**. It comes from MultiSafepay: the
Sync reads each method's `allowed_countries` and stores it as-is.

* A method with `allowed_countries: []` on the MSP side has **no country restriction** and is
  offered to every shopper.
* A method restricted by MultiSafepay (for example Riverty in NL only) is offered only to
  shoppers whose **billing address** is in one of those countries.

To change where a method is available, change it in your MultiSafepay account and re-run
**Sync & Import**. The former "Target Countries" preference has been removed: it produced a
guessed country list that hid methods MultiSafepay actually allowed everywhere.

---

## 4. Synchronizing and importing payment methods

The available payment methods depend on the MSP contract and the country. To align them:

1. On the **Multisafepay settings** page, in the **Payment Methods** box, click
   **↻ Sync & Import**.
2. The system:
   - queries MSP for each target country and builds per-country availability;
   - creates/updates the method list (Custom Object `MSPPaymentMethod`);
   - automatically disables methods no longer offered by MSP;
   - generates the Payment Methods archive and (if OCAPI is configured) launches the
     **`MSP-ImportPaymentMethods`** import job in Salesforce.
3. A message reports the outcome; for the import status check
   **Administration → Operations → Job History**.

> The Sync does **not** delete the existing configuration if MSP returns no methods
> (e.g. wrong key): you will instead receive an error message.

---

## 5. Managing payment methods

In the **Payment Methods** box each method shows: icon, name, gateway ID, an **Inline** badge
(methods with in-page data entry, e.g. cards), enabled countries and an **on/off** toggle.

- **Enable/disable** a method: use the toggle next to the method. The change is immediate,
  regenerates the Payment Methods archive and re-triggers the import so **Site Preferences and
  Ordering > Payment Methods stay aligned**.
- A method appears at the shopper's checkout only if **all** of these hold: it is **enabled**
  here; the cart's **country** is among its allowed countries; the cart **currency** is allowed;
  the cart **amount** is within the method's min/max; and the corresponding SFCC payment method
  (`MSP_<gateway>`) is **active** and applicable (customer group / customer type). Methods that
  fail any rule are neither shown nor selectable.

---

## 6. Manual Capture

Manual capture lets you **authorize** the payment at checkout and **capture** (charge) the
amount at a later time (e.g. at shipment).

### Enabling
Multisafepay settings → **Manual Capture** = enabled → **Save Changes**.

> ⚠️ **Enable it before placing the order you intend to capture.** The instruction not to
> capture automatically travels with the order at the moment it is created. Turning the
> setting on afterwards does not convert an order that was already placed and settled — that
> payment is captured, and no Capture button will appear for it. This is the most common
> reason the button seems to be missing.

### Which methods can be captured
Only methods whose MultiSafepay account reports both `manual_capture.supported` and
`manual_capture.is_enabled`. In practice these are the card schemes; instant methods such as
iDEAL and bank transfer cannot be captured, and buy-now-pay-later methods are settled by
notifying the shipment instead (see §13), never by the Capture button.

The settings page marks capturable methods with a **Capture** badge next to their name. That
badge is the authoritative list for your account — re-run **Sync & Import** after changing
manual capture in the MultiSafepay Admin Panel and the badges follow.

### Performing the capture
1. Open the order detail: **Merchant Tools → Ordering → Orders → [order]**.
2. In the MultiSafepay box, **Capture Status** reads *"Awaiting capture"*, and **Capture
   Expiry** shows the deadline after which MultiSafepay releases the authorization.
3. Click **CAPTURE FULL PAYMENT**.
4. Once captured, the status becomes *"Captured on [date/time]"*.

The **CAPTURE FULL PAYMENT** button and the Capture Status row appear only when **all** of
these hold:

| Condition | How to check it |
|---|---|
| Manual capture was active **when the order was placed** | The order shows a **Capture Expiry** value. MultiSafepay returns that deadline only for a payment it is holding as an authorization, so it is the proof that this order is capturable — enabling the setting after the order was placed does not make it so |
| The payment is authorized but not settled | **Order Status from MSP platform** = `completed`, and the payment is not yet captured, refunded, cancelled or expired |
| It has not been captured already | No *"Captured on …"* value |

The method also has to support capture (**Capture** badge on the settings page), and
Manual Capture has to be enabled in the settings — but both of those are enforced when the
order is created, which is what the Capture Expiry value records.

For orders that fall outside this, the button and the row are hidden on purpose.

> MultiSafepay capture always captures the **full** authorized amount. The amount field in the
> box applies to **refunds only**.

---

## 7. Refunds

Refunds (full or partial) are performed from the order detail in Business Manager.

1. Open **Ordering → Orders → [order]**.
2. In the MultiSafepay box:
   - Enter the **amount** to refund in the *"Enter amount to refund"* field.
   - Click **REFUND PAYMENT**.
3. MSP processes the refund; once confirmed:
   - **Full refund** → order payment status = *Not Paid*.
   - **Partial refund** → order payment status **stays *Paid*** (the order remains paid); the
     refunded amount is shown separately as **Amount Refunded** in the box.

> The payment-status update happens via webhook, when MSP confirms the actual processing of
> the refund (not on the mere request).

---

## 8. Transactions dashboard

**Analytics → Multisafepay dashboard** shows a summary based on MSP transactions:
- **Today's** and **total** transactions.
- **Today's** and **total** refunds.
- **7-day** trend charts (transactions and refunds).

The data comes in real time from the MSP API of the active environment.

---

## 9. Shopper payment experience

1. At **checkout**, in the payment step, the shopper sees the list of MSP methods
   available for their country/currency, each with a logo and name.
2. On selecting a method:
   - **Credit cards and "Inline" methods**: a data-entry form appears directly in the page
     (MultiSafepay Payment Component).
   - **Other methods** (iDEAL, PayPal, BNPL, etc.): no additional in-page fields.
3. At **Place Order**:
   - **Direct mode** (cards): the payment can be processed inline.
   - **Redirect mode**: the shopper is taken to the secure MSP payment page, completes the
     payment and is returned to the store.
4. **Confirmation**: on a successful return the shopper sees the order confirmation page and
   receives the confirmation email. On **cancellation**, the cart is restored so they can
   retry.
5. **Gift Certificate**: the shopper can apply/remove gift certificates at checkout; the
   remaining balance is handled by the selected MSP method.

> The payment page has a **1-hour expiry**: beyond that limit the payment session is no
> longer valid.

---

## 10. Order and payment statuses

MultiSafepay communicates the payment status via notifications (webhook). Mapping onto SFCC
orders:

| MSP status | Meaning | Effect on the SFCC order |
|---|---|---|
| `completed` / `shipped` | Payment successful | Order confirmed, **Paid**, email sent. |
| `initialized` | Payment started | Pending; no action. |
| `uncleared` | Under review / awaiting manual capture | Pending; no action. With Manual Capture, this is the *awaiting capture* state. |
| `reserved` | Action pending | Pending (e.g. capture/refund pending). |
| `refunded` | Full refund | **Not Paid**. |
| `partial_refunded` | Partial refund | **Stays Paid**; refunded amount shown as *Amount Refunded*. |
| `declined` | Declined | Order **failed**. |
| `expired` | Expired | Order **failed**. |
| `cancelled` / `void` | Cancelled | Order **failed**. |

In the BM order detail, the **MSP status** is shown with a color code:
🟢 green (completed/shipped) · 🟠 orange (refund) · 🔴 red (declined/expired/cancelled/void)
· ⚪ grey (others).

---

## 11. Switching from Test to Live

1. Verify that you have entered the **Live API Key** in the settings.
2. Change **Environment** to **Live** → **Save Changes**.
3. Run **Sync & Import** to align the live account's payment methods.
4. Verify that the desired methods are **enabled**.
5. Place a real test order (minimum amount) to validate the end-to-end flow, including
   webhook receipt and order confirmation.

> Test and Live use separate MSP keys and dashboards. Make sure the key matches the selected
> environment.

---

## 12. Troubleshooting (FAQ)

**Payment methods do not appear at checkout.**
- Verify that the active environment's **API key** is correct (an **invalid key hides all
  methods** and blocks checkout — see below).
- Run **Sync & Import** and check that the methods are **enabled**.
- Check the cart's country/currency/amount against the restrictions enabled on the method.

**Checkout shows "The MultiSafepay API key is invalid" and no methods / the pay button is disabled.**
- The active environment's API key is invalid (401/403). Fix the Test/Live API Key in Site
  Preferences; the block clears automatically once a valid key is validated. A missing key shows
  a "not configured" message instead. Transient connection errors do **not** block checkout.

**The Sync returns error 401 / "Authentication failed".**
- The API key is not valid for the selected environment. Fix it in Site Preferences.

**A European (e.g. Dutch "1012 AB") postal code is rejected at checkout.**
- Fixed: the address form now accepts numeric and alphanumeric postal codes. Ensure the
  `multisafepay` cartridge precedes `app_storefront_base` in the cartridge path.

**The "Sync & Import" button syncs but does not import into Salesforce.**
- The **OCAPI** configuration is missing (Client ID/Secret and Data API permissions). Complete
  the OCAPI setup (§3, Step 3) or manually import the generated archive.

**The order shows as "paid" only after a few moments.**
- Normal: payment confirmation happens via MSP's asynchronous **webhook**.

**I don't see the CAPTURE FULL PAYMENT button.**
- It appears only if **Manual Capture** is enabled, the payment **method supports capture**
  (card schemes; instant methods like iDEAL do not), the payment is **awaiting capture** (MSP
  status `uncleared`) and it has not already been captured.

**Dashboard charts (Revenue / Returns last 7 days) are empty.**
- Fixed. If still empty, there were simply no payments/refunds in the last 7 days for the active
  environment. The KPI cards show counts; the charts show revenue/refund amounts.

**A refund was requested but the status did not change.**
- The payment status updates when MSP **confirms** processing of the refund via webhook, not
  on the mere request. Check the MSP dashboard.

**Where do I find the technical logs?**
- Application logs are under the **MSP** category (custom log `multisafepay`) in
  **Administration → Site Development → Development Setup / Log Files**.

---

## 13. Scheduling the shipment notification job (BNPL)

Buy-now-pay-later providers (Riverty, Klarna, Billink, in3) only invoice the shopper once the
order has actually shipped. Marking an order as **Shipped** in Business Manager does not raise
a storefront event, so a scheduled job reports it to MultiSafepay.

Without this job, BNPL orders stay authorized on the MultiSafepay side and are never invoiced.

### Step 1 — Create the job

1. Go to **Administration → Operations → Jobs** and click **New Job**.
2. Name it, for example, `MSP-NotifyShipments`. Confirm.

### Step 2 — Add the job step

1. Open the **Job Steps** tab and click the **+** button.
2. Choose **Configure a step** → pick **`custom.MSP.NotifyShipments`**.
   *If it is not in the list, the `multisafepay` cartridge is not on the cartridge path of the
   site you selected, or the code version has not been activated.*
3. Give the step an ID, for example `notify-shipments-msp`.
4. In **Scope**, select the **site(s)** that use MultiSafepay (for example `RefArch`).
   The step is site-scoped: an organization-level scope will not work.
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
3. Run the job manually with **Run Now** on the job's page.
4. Check **Administration → Operations → Job History**:
   * **OK** — the log line reads `Notified N of M MultiSafepay order(s)`.
   * **ERROR** — the message carries the MultiSafepay error verbatim (for example
     `HTTP 401: Invalid API key`). Fix that and re-run.
5. In the MultiSafepay Merchant Panel the transaction status becomes **Shipped** and the BNPL
   provider invoices the shopper.

### What the job does and does not do

* It considers only orders that are **Shipped**, still **Open**, and paid with MultiSafepay.
* Each order is notified **once**: a flag on the order (`Multisafepay_ShipmentNotified`)
  prevents duplicates, so running the job more often is harmless.
* If the SFCC shipment carries a tracking number, it is forwarded together with the carrier
  name; otherwise the shipment is reported without tracking data, which MultiSafepay accepts.
* It does **not** capture card payments — that is the separate **Manual Capture** flow in
  section 6.

> **Prerequisite.** The job needs the `Multisafepay_ShipmentNotified` attribute from
> `metadata/site-import`. If the metadata has not been imported, the job reports an error
> rather than notifying MultiSafepay repeatedly on every run.
