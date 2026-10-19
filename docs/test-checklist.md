# MultiSafepay for Salesforce B2C Commerce — End-to-end Test Checklist

The development team runs this checklist on a Commerce Cloud sandbox connected to a
MultiSafepay **test** account before every delivery. The filled-in copy, with its
evidence, is attached to the delivery.

## Test record

| | |
|---|---|
| Version tested (tag or commit) | |
| Sandbox and site ID | |
| MultiSafepay test account | |
| Date | |
| Tester | |
| `npm test` | pass / fail |
| `MSP` log category enabled | yes / no |
| Result summary | __ passed · __ failed · __ not applicable |
| Open defects | |

## How to use this checklist

- Each item is **action → expected result**. Tick the box only when the expected result
  is observed. Mark items that cannot apply (for example, no second currency on the site)
  as **N/A** and say why.
- **Record the evidence yourself** for every failed item, and for passed items where it
  is cheap: order number, screenshot of the Business Manager order detail (Payment tab),
  the transaction in the MultiSafepay dashboard, the Job History entry. Attach it to the
  test record.
- **Prefer evidence you can see.** That means the Business Manager order detail, the
  MultiSafepay dashboard, Job History and the API response. Log lines are supporting
  evidence only. The connector writes to the custom log category `MSP` (files
  `custom-multisafepay-*`), and an instance records it only when the category is enabled
  under **Administration → Operations → Custom Log Settings** (level INFO). If the
  category is disabled, every connector log line is discarded. A missing line then
  proves nothing.
- **Payment-method examples depend on the account.** Gateway names, amount limits, country
  restrictions and capture support all come from the test account's own MultiSafepay
  catalogue. The examples below (in3, Riverty, iDEAL, card schemes…) are illustrations.
  Before testing, read the real values on the settings page (badges, country line) and
  pick methods that match each scenario.

---

## 1. Setup and deploy

Run this section in full on every delivery.

- [ ] **1.1** Run `npm test` on the version being delivered → all tests pass.
- [ ] **1.2** Build and upload the version being delivered (`npm run build`, then upload
      the `multisafepay` and `bm_multisafepay` cartridges) and activate the code version
      → the sandbox runs the version recorded in the test record.
- [ ] **1.3** Check the cartridge paths (**Administration → Sites → Manage Sites**, the
      storefront site and Business Manager) → both contain `multisafepay` and
      `bm_multisafepay` **ahead of** `app_storefront_base`, as in the README
      (*Architecture*).
- [ ] **1.4** Zip the whole `metadata/site-import` folder (the folder inside the ZIP must
      have the same name as the ZIP file). Import it under **Administration → Site
      Development → Site Import & Export** → the Status row reads **Success**, and its log
      ends with `The instance import completed successfully.`
- [ ] **1.5** Check the imported metadata → **System Object Types → Custom Object
      Definitions** lists `MSPPaymentMethod`. **Merchant Tools → Site Preferences →
      Custom Preferences** shows the group **Multisafepay Account Settings**.
      **Administration → Operations → Services** lists `Multisafepay.GenerateApiToken`.
- [ ] **1.6** **Ordering → Payment Methods** contains the method `MultiSafepayPayment`,
      active, with payment processor `MultiSafepayPayment` → present. (The connector
      creates every order's payment instrument on this method. The `MSP_<gateway>`
      methods only decide what the checkout shows.)
- [ ] **1.7** Open **Merchant Tools → Site Preferences → Multisafepay settings**. Set
      **Environment = Test**, enter the **Multisafepay Test API Key** and click **Save
      Changes** → *Your Changes have been saved* appears.
- [ ] **1.8** Automatic import: OCAPI Client ID and Secret are set under **Custom
      Preferences → Multisafepay**. The API client may run the job (OCAPI Data API
      resource `/jobs/*/executions`, method `post`). The job
      **`MSP-ImportPaymentMethods`**, created by the metadata import, exists and imports the site archive
      `msp-payment-methods.zip`, which Sync & Import writes to the Impex
      `src/instance` folder → all three are in place. *(Without OCAPI, import
      `msp-payment-methods.zip` by hand from Site Import & Export after each sync. Record
      which mode was used.)*
- [ ] **1.9** Webhook reachability → the storefront can be reached from the internet at
      `https://<storefront host>/…/Multisafepay-Webhook`. Storefront password protection
      and IP restrictions are off, or they let the notifications through. Each order
      carries its own `notification_url`, so nothing needs to be set on the MultiSafepay
      account. Check 7.1 proves this end to end.
- [ ] **1.10** Logs (optional, for supporting evidence) → the custom log category `MSP` is
      enabled at INFO in **Custom Log Settings**. Record in the test record whether it was
      enabled.
- [ ] **1.11** **After every deploy:** (a) import the metadata (1.4), (b) click **↻ Sync &
      Import**, then (c) confirm in **Administration → Operations → Job History** that
      **`MSP-ImportPaymentMethods`** finished **OK** → all three done. Without (c), the
      `MSP_*` payment methods keep their old country lists and the checkout keeps the old
      restrictions, so a correct fix looks as if it has not worked.

---

## 2. Payment method sync

The sync makes **one** `GET /payment-methods` call with no `country` and no `currency`
filter (only `group_cards` and `include_coupons=1`). Each method keeps the
`allowed_countries` that MultiSafepay reports. **An empty list means available
everywhere.** Country availability is never configured in Salesforce and never inferred.

- [ ] **2.1** Click **↻ Sync & Import** → with OCAPI: *Done! Synced N methods. Import job
      triggered. Check Job History for status.* Without OCAPI: *Synced OK (N methods), but
      import failed: OCAPI credentials not configured.*
- [ ] **2.2** Compare the list with the methods enabled on the test account (MultiSafepay
      dashboard, or `GET /v1/json/payment-methods?include_coupons=1` called with the test
      key) → every enabled method is in the list. None is missing because of the
      countries it is restricted to.
- [ ] **2.3** Reload the settings page → every method shows its country line. A method
      that MultiSafepay reports with `allowed_countries: []` reads **All countries**. A
      restricted method lists exactly the countries the API reports. Where the API reports
      them, a method also shows **Currencies: …** and an amount badge (`min … / max …`).
      Methods with an in-page form show the **Inline** badge, and methods the account can
      capture manually show the **Capture** badge. *(The list drawn right after a sync
      shows only the name, the Inline badge and the country codes. Reload to see
      everything.)*
- [ ] **2.4** After the import job has run, open **Ordering → Payment Methods** → every
      synced gateway has an `MSP_<gateway>` method. A restricted method has the same
      countries as on the settings page. An unrestricted method has **no** country
      restriction.
- [ ] **2.5** Switch a method **off** on the settings page → it disappears from checkout
      on the next load of the payment step. After the import job, `MSP_<gateway>` is
      disabled in Ordering → Payment Methods. Switch it **on** → it shows at checkout
      again.
- [ ] **2.6** Deactivate a method on the MultiSafepay test account, then **Sync & Import**
      → after a reload, the method is still listed with its toggle **off**, and it does
      not show at checkout.
- [ ] **2.7** Reactivate that method on the MultiSafepay account and **Sync & Import** →
      the method stays **off**, because a sync never switches a method back on. Switch it
      on with the toggle → it shows at checkout.
- [ ] **2.8** Use a wrong Test API Key and click **Sync & Import** → *Error:
      Authentication failed (…). Please verify your MSP API key in Site Preferences.* The
      existing method list is unchanged. Restore the key.
- [ ] **2.9** Clear the Test API Key and click **Sync & Import** → *Error: No API key
      configured for the TEST environment. Please set Multisafepay_TestApiKey in Site
      Preferences.* Restore the key.
- [ ] **2.10** **Group Card Methods** on → **Save Changes** → **Sync & Import** → one
      grouped card method replaces the individual card schemes, which are switched off.
      The checkout shows only the grouped method. After a page reload, the **Group Card
      Methods** box is still ticked.
- [ ] **2.11** **Group Card Methods** off → **Save Changes** → **Sync & Import** → the
      grouped method is switched off and the individual schemes are listed again.
      They keep the **off** state from 2.10 (see 2.7): switch them on → each scheme shows
      as a separate option at checkout.

---

## 3. Checkout availability and restrictions

A method shows at checkout only when **all** of these hold:

- it is switched on, on the settings page;
- the **billing** address country is in its country list, or the list is empty;
- the basket currency is in its currency list, or the list is empty;
- the basket total is within its min/max;
- its `MSP_<gateway>` method is active and applicable to the customer (customer group,
  country, amount) in Ordering → Payment Methods. A gateway that has no `MSP_` method yet
  is shown anyway.

The list is built when the payment step loads. After changing the billing address,
submit the step (**Next: Place Order**) and reload the checkout page to see the new list.

- [ ] **3.1** **Country, unrestricted:** with a billing address in a country of your
      choice (for example NL), a method marked **All countries** (for example a card
      scheme) shows.
- [ ] **3.2** **Country, restricted:** pick a method whose settings page lists specific
      countries (for example Riverty, if the test account restricts it to NL). A billing
      address in a listed country → the method shows. A billing address outside the list
      → it does not show.
- [ ] **3.3** **Billing, not shipping:** shipping address **outside** the method's
      countries, billing address **inside** → the method **shows**. Reverse it (shipping
      inside, billing outside) → the method does **not** show.
- [ ] **3.4** **Amount:** pick a method with an amount badge (for example in3, if the test
      account reports min 50 / max 3000). A basket total (including shipping and tax)
      below the minimum → not shown. Within the range → shown. Above the maximum → not
      shown.
- [ ] **3.5** **Currency** *(N/A if the site has only one currency)*: in a non-EUR basket,
      a method whose **Currencies** line does not include that currency → not shown. A
      method without a currency restriction → shown.
- [ ] **3.6** **Customer group:** in Ordering → Payment Methods, restrict one
      `MSP_<gateway>` (for example `MSP_IDEAL`) to the customer group **Registered**. As a
      guest → not shown. Logged in as a registered customer → shown.
- [ ] **3.7** **Inactive in Salesforce:** deactivate one `MSP_<gateway>` in Ordering →
      Payment Methods → not shown, even though it is switched on in the settings page.
      Reactivate it.
- [ ] **3.8** **Nothing applicable:** make no method applicable (for example, switch them
      all off) → the payment step shows *No payment methods are available for this
      order. Please contact the store for assistance.* Restore.

---

## 4. Inline components and redirect

Whether a method opens an in-page form comes from the API
(`payment_components.has_fields` and `is_enabled`), stored at sync time, and is shown
as the **Inline** badge. No gateway is hard-coded.

- [ ] **4.1** Select a method with the **Inline** badge (for example a card scheme) → the
      MultiSafepay Payment Component form appears directly under that method's row.
- [ ] **4.2** Repeat 4.1 for every other method with the **Inline** badge on the test
      account (for example Direct Debit, or a BNPL method if badged) → each renders its
      form.
- [ ] **4.3** Select a method **without** the badge (for example iDEAL) → no in-page form.
      **Place Order** sends the shopper to the MultiSafepay payment page. After paying, the
      shopper comes back to the store's order confirmation page.
- [ ] **4.4** Complete a payment through the inline form (for example a test card) → the
      order is confirmed, after a 3-D Secure step if the card needs one. The MultiSafepay
      dashboard shows the transaction for the right amount.
- [ ] **4.5** Switch between an inline and a redirect method several times before paying
      → the form appears and disappears accordingly, and the payment completes with the
      method selected last.
- [ ] **4.6** On the MultiSafepay payment page, cancel and return to the store → the
      shopper lands on the checkout with the basket restored and can pay again.

---

## 5. API key handling

- [ ] **5.1** Save an **invalid** Test API Key, then open the checkout payment step → no
      method shows. The message reads *Online payment is temporarily unavailable. Please
      contact the store for assistance.* The **Next: Place Order** / **Place Order**
      buttons are disabled.
- [ ] **5.2** Clear the Test API Key → the **same** message, methods hidden, checkout
      blocked. The shopper is not told the cause: neither message mentions the API key
      or MultiSafepay.
- [ ] **5.3** Restore the valid key and reload the payment step → the methods come back
      in the same browser session, and checkout proceeds.
- [ ] **5.4** Set **Environment = Live** with **no** Live API Key → the checkout shows the
      message from 5.1. **Sync & Import** answers *No API key configured for the LIVE
      environment…*. The Test key is never used in Live. *(If the instance still has the
      legacy `Multisafepay_ClientKey` preference set, Live falls back to it. Clear it for
      this test.)* Set Environment back to **Test**.
- [ ] **5.5** With a valid key, open the browser's network tab on the payment step and
      select an inline method → the `Multisafepay-GetComponentToken` response carries a
      short-lived `apiToken`, not the API key. The API key appears nowhere in the page
      source.

---

## 6. Address and postal code

Read the address that MultiSafepay received in the MultiSafepay dashboard (the
transaction's customer details). The request payload also appears in the `MSP` log
(`[CreateOrder] Request payload`) when the category is enabled.

- [ ] **6.1** Billing *Address 1* `Via Roma 10`, *Address 2* empty → MultiSafepay
      receives street `Via Roma` and house number `10`. The number is not repeated in
      the street.
- [ ] **6.2** *Address 1* `Via Roma`, *Address 2* `10` → same result as 6.1.
- [ ] **6.3** *Address 1* `Kalverstraat 92A` → street `Kalverstraat`, house number `92A`.
- [ ] **6.4** The same checks on the **shipping** address → the delivery address is split
      the same way.
- [ ] **6.5** Postal codes `1012 AB`, `1012AB`, `12345`, `12345-6789` and `SW1A 1AA` →
      accepted in both the shipping form and the billing form.
- [ ] **6.6** Postal code `12` → rejected with *Must be between 3 to 10 characters
      required.*
- [ ] **6.7** Complete a BNPL order (a method that needs a house number, for example
      Riverty with an NL billing address) with `Kalverstraat 92` and `1012 AB` →
      MultiSafepay accepts it. There is no decline for the house number or for
      `customer.address.postalCode` format.

---

## 7. Payment status via webhook

Notifications are verified with HMAC-SHA512 over `timestamp:body`, keyed with the active
API key. Evidence: the Payment tab of the order in **Merchant Tools → Ordering →
Orders**, in particular the **Order Status from MSP platform** row, the order's Status and
Payment Status, and the transaction in the MultiSafepay dashboard.

- [ ] **7.1** Pay by card or iDEAL → within moments the order is placed (not *Failed*) with
      Payment Status **Paid**. *Order Status from MSP platform* shows `completed` in
      green, and *Transaction ID* is filled. The payment does not show *The payment
      processor is unknown*. The confirmation email is sent (if the sandbox sends mail).
- [ ] **7.2** Pay with a BNPL method that MultiSafepay leaves `uncleared` (for example
      Riverty, Klarna, Billink or in3, whichever the account offers) → the order is
      **placed**, not *Failed*, with Payment Status **Not Paid**. *Order Status from MSP
      platform* shows `uncleared`. The order becomes **Paid** only after the shipment
      notification (section 12).
- [ ] **7.3** Use a MultiSafepay test scenario that ends `declined` (see MultiSafepay's
      test payment documentation) → the order ends **Failed**. *Order Status from MSP
      platform* shows `declined` in red.
- [ ] **7.4** Start a redirect payment and cancel it on the MultiSafepay page → the basket
      is restored (4.6). Once MultiSafepay reports the order `cancelled` or `void` (or
      `expired`, one hour after the payment page was created), the original order is
      **Failed**.
- [ ] **7.5** Send an unsigned notification for an existing order: `POST` to
      `Multisafepay-Webhook?timestamp=1` with body
      `{"order_id":"<order no>","status":"completed"}` and no `auth` header → the
      notification is rejected: the response is not `[MULTISAFEPAY_OK]`, and the order's
      Status, Payment Status and Payment tab are unchanged.

---

## 8. Method changed on the MultiSafepay payment page

- [ ] **8.1** Select one redirect method at checkout (for example iDEAL). If the
      MultiSafepay payment page lets the shopper switch, pay with a **different** method
      → after the notification, the Payment tab's *Multisafepay_Gateway* row shows the
      gateway **actually used**. Nothing in *Payment info* still refers to the method
      first selected. *(With the log category enabled:
      `[Webhook] Payment method overridden for order … : <selected> → <used> (actual
      method used)`.)*

---

## 9. Refunds

Refunds are made from the order's Payment tab (amount field and **REFUND PAYMENT**).
The SFCC payment status changes when MultiSafepay **notifies** the refund, not when the
button is clicked.

- [ ] **9.1** On a paid order, enter a **partial** amount and click **REFUND PAYMENT** →
      the alert *Refund successful!* appears. After the notification, *Order Status from
      MSP platform* reads `partial_refunded` (orange). Payment Status **stays Paid**, and
      the box shows *Amount Refunded: <amount> <currency>*.
- [ ] **9.2** Refund the remaining amount → the status becomes `refunded` and Payment
      Status **Not Paid**. *Amount Refunded* shows the total refunded.
- [ ] **9.3** Leave the amount **empty** (then enter `0`) and click **REFUND PAYMENT** →
      the alert *Enter the amount to refund.* appears and no refund is requested. Enter
      an amount with a comma (e.g. `1,50`) → the refund is made for 1.50.
- [ ] **9.4** Try to refund more than the remaining amount → the alert *Refund failed:
      <MultiSafepay message>* appears, and nothing changes on the order.
- [ ] **9.5** Check the MultiSafepay dashboard for 9.1 and 9.2 → the refunds there match
      the amounts entered.

---

## 10. Manual capture

**Manual capture travels with the order.** The capture request (`capture: manual`) is
sent when the order is placed, and only when **Manual Capture** is on **and** the method
has the **Capture** badge (`manual_capture.supported` and `is_enabled` on the account).
Turning the setting on later does not make an existing order capturable.

Each order's Payment tab also carries an HTML comment that starts with `MSP capture
decision:` (View Source). It shows the values that decided whether the button appears,
whatever the log settings.

- [ ] **10.1** Turn **Manual Capture** on → **Save Changes**. Note which methods carry the
      **Capture** badge (for example the card schemes on the test account). That badge
      list is the authority for this account.
- [ ] **10.2** Place an order with a method that has the **Capture** badge → the Payment
      tab shows *Capture Status: Awaiting capture* and *Capture Expiry: <deadline>*. It
      also shows the **CAPTURE FULL PAYMENT** button with the note *MultiSafepay capture
      always captures the full authorized amount. The amount field above applies to
      refunds only.* *Order Status from MSP platform* reads `completed`. The HTML comment
      ends with `showCapture=true`. The MultiSafepay dashboard shows the payment
      authorized and not captured.
- [ ] **10.3** Click **CAPTURE FULL PAYMENT** and confirm *Are you sure you want to capture
      this payment?* → the page reloads with *Capture Status: Captured on <timestamp>*.
      The button and the Capture Expiry row are gone. MultiSafepay shows the full amount
      captured.
- [ ] **10.4** With Manual Capture on, pay with a method **without** the Capture badge
      (for example iDEAL) → no Capture Status row and no button. The payment settles
      immediately.
- [ ] **10.5** With Manual Capture on, pay with a BNPL method (status `uncleared`) → no
      capture button. BNPL is settled by the shipment notification (section 12), never by
      this button.
- [ ] **10.6** Turn Manual Capture **off**, place a card order, then turn it **on** and
      open that order → no capture button and no Capture Status. The payment was
      captured when the order was placed, and the HTML comment shows
      `financialStatus=completed`.
- [ ] **10.7** Place an order as in 10.2, then turn Manual Capture **off** and open it →
      the **CAPTURE FULL PAYMENT** button is still there. The order's Capture Expiry is
      what proves it can be captured. Capture it.
- [ ] **10.8** An order already captured (10.3) or fully refunded → no capture button.

---

## 11. Gift cards and coupons

- [ ] **11.1** At the payment step, enter a valid Salesforce gift certificate code that
      covers **part** of the total in **GIFT CARD** and click **APPLY** → the line
      *Gift Certificate: <masked code>* appears with **Remove**.
- [ ] **11.2** Pay the rest with a MultiSafepay method → the MultiSafepay transaction
      amount equals the order total minus the gift certificate. The Payment tab shows
      **Gift card breakdown**, with *Gift card <masked code>: <amount>* and
      *<gateway> (remaining): <amount>*. Together they add up to the order total.
- [ ] **11.3** Apply a **second** code on the same basket → it **replaces** the first.
      There is one gift certificate per order, so the order then shows a single gift card
      line.
- [ ] **11.4** Apply an invalid code → *There is no valid certificate with the following
      code: <code>*.
- [ ] **11.5** Click **Remove** → the gift certificate is removed, and the MultiSafepay
      method covers the full total again.
- [ ] **11.6** *(N/A if the test account has none)* MultiSafepay gift cards / coupons:
      after **Sync & Import**, the account's gift-card methods are in the settings list
      (the sync requests them with `include_coupons=1`) and show at checkout. Pay part with
      a gift card on the MultiSafepay page and the rest with another method → the
      Payment tab shows **MSP payment breakdown**, with one line per part.
- [ ] **11.7** Apply a basket-level promotion coupon, then pay with a BNPL method →
      MultiSafepay accepts the order, and the transaction amount equals the discounted
      total.

---

## 12. BNPL shipment notification

BNPL providers invoice only once the order has shipped. The job step
**`custom.MSP.NotifyShipments`** (site-scoped) selects orders with Shipping Status
**Shipped** and Status **Open** that were paid with MultiSafepay. For each one it sends
`PATCH /orders/{order_id}` with `status: shipped` and:

- `tracktrace_code`: the shipment's tracking number, or else the order number;
- `carrier`: the shipping method's name, or else `Unknown`;
- `ship_date`: the time of the run.

It then flags the order (`Multisafepay_ShipmentNotified`) so that it is never notified
twice. Any rejection ends the step in **ERROR** and names the order.

- [ ] **12.1** **Administration → Operations → Jobs** → a job with the step
      `custom.MSP.NotifyShipments` exists, scoped to the site under test.
- [ ] **12.2** Take a BNPL order from 7.2 (Status **Open**, Payment Status **Not Paid**)
      with no tracking number. Set its **Shipping Status** to **Shipped** and click **Run
      Now** → Job History shows **OK** with *Notified 1 of M MultiSafepay order(s).* M
      counts every shipped, open MultiSafepay order on the site, including the ones
      already notified.
- [ ] **12.3** In the MultiSafepay dashboard, check that transaction → its status is
      **shipped**, with the order number as tracking code, the shipping method's name as
      carrier (or `Unknown`), and the run time as ship date. Once MultiSafepay sends the
      `shipped` notification, the SFCC order is **Paid** and *Order Status from MSP
      platform* shows `shipped` in green.
- [ ] **12.4** Repeat 12.2 with a tracking number set on the shipment → MultiSafepay
      receives that tracking number instead of the order number.
- [ ] **12.5** Click **Run Now** again → **OK** with *Notified 0 of M…*. None of the
      orders already notified is sent again, and the MultiSafepay transaction is
      unchanged.
- [ ] **12.6** **Rejection:** mark another MultiSafepay order Shipped. Save an invalid
      Test API Key and click **Run Now** → Job History shows **ERROR** with *… of M
      MultiSafepay order(s) could not be notified. Last error: order <order no> - HTTP
      <code>: <MultiSafepay message>*. The order is not flagged. Restore the key and click
      **Run Now** → **OK**, and the order is notified.
- [ ] **12.7** Clear the API key and click **Run Now** → **ERROR** *No MultiSafepay API key
      configured.* Restore the key.
- [ ] **12.8** Mark Shipped an order paid only with a non-MultiSafepay method → the job
      ignores it. It does not count in M.
- [ ] **12.9** Mark Shipped a MultiSafepay **card** order → the job notifies it too: the
      job is not limited to BNPL, and MultiSafepay accepts the `shipped` update.

---

## 13. Transactions dashboard

**Merchant Tools → Analytics → Multisafepay dashboard** reads the active environment's
transactions live from MultiSafepay.

- [ ] **13.1** With payments and refunds made today (sections 7 and 9) → *Today's orders*,
      *Total orders*, *Today's refunds* and *Total refunds* match the MultiSafepay
      dashboard for the same environment.
- [ ] **13.2** The charts *Chart showing revenue over the last 7 days* and *Chart showing
      returns over the last 7 days* → show **amounts**, not counts, on the right days.
      They match the MultiSafepay dashboard.
- [ ] **13.3** *(Pagination, needs more than 100 transactions on the account)* → *Total
      orders* and *Total refunds* match the MultiSafepay dashboard and are not capped at
      the first page (100).

---

## 14. Regression

- [ ] **14.1** A method synced but missing from Ordering → Payment Methods (for example
      `MSP_<gateway>` deleted) → still shows at checkout. Restore it with **Sync & Import**.
- [ ] **14.2** Re-run **Sync & Import** after 3.6 → the customer-group restriction on that
      `MSP_<gateway>` is still there after the import job.
- [ ] **14.3** With **Group Card Methods** off, every card scheme still renders the inline
      form (4.1).
- [ ] **14.4** Redirect payments and inline payments both complete in the same session,
      one after the other.
- [ ] **14.5** A Salesforce gift certificate together with a MultiSafepay method still
      completes (11.2) after every other section has run.
- [ ] **14.6** After the last configuration change, run the after-deploy steps (1.11) once
      more and place one card order and one redirect order → both are **Paid**.
