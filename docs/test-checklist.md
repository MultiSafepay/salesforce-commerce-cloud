# MultiSafepay ↔ SFCC — End-to-end Test Checklist

Executable checklist to validate the QA re-testing fixes on a Commerce Cloud
sandbox connected to the MultiSafepay **test** account. Follow section 0 first,
then run the scenarios. Each scenario lists the related QA item, the steps and
the expected result. Tick the box when it passes.

Method references use this account's real test methods:
- **Support manual capture:** Visa, Mastercard, Maestro, Bancontact.
- **Inline component (has_fields & is_enabled):** cards, Bancontact, Direct Debit, Riverty, in3, in3 business, Billink.
- **Redirect only:** iDEAL, Klarna, PayPal, Trustly, etc.
- **Amount restriction examples:** in3 (min €50 / max €3000), in3 business (min €150), Bizum (min €0.50 / max €1000).

---

## 0. Environment setup (do once)

- [ ] **0.1** Deploy the latest code (branch `main`, ≥ commit `d381aca`) to the sandbox.
- [ ] **0.2** Cartridge path (Administration → Sites → Manage the Sites → [site] → Settings) is:
      `multisafepay:bm_multisafepay:app_storefront_base:...` (custom **before** base).
- [ ] **0.3** Import metadata: **Administration → Site Development → Site Import & Export** →
      import `metadata/site-import/meta/system-objecttype-extensions.xml`. Verify the new
      Site Preference **Group Card Methods** and the `MSPPaymentMethod` attributes
      `currencies, minAmount, maxAmount, supportsCapture` and the PaymentTransaction attribute
      `Multisafepay_FinancialStatus` exist.
- [ ] **0.4** Site Preferences → Multisafepay: **Environment = Test**, set the **Test API Key**.
- [ ] **0.5** (For import) set **OCAPI Client ID/Secret** + Data API permission for
      `payment_methods` (`put`), or plan to import the generated archive manually.
- [ ] **0.6** **Webhook reachable:** the sandbox host is publicly reachable and the MSP test
      account's notification URL points to `.../Multisafepay-Webhook` (no firewall/IP block).
- [ ] **0.7** BM → **Multisafepay settings → Sync & Import**. Expect success and the method list
      populated. Verify **Ordering → Payment Methods** now contains `MSP_*` methods.
- [ ] **0.8** Confirm no errors in the log category **MSP** (`custom-multisafepay-*`).

---

## 1. Payment methods synchronization (QA 1, 3)

- [ ] **1.1** Disable a method on the MSP test account → **Sync & Import** → the method no longer
      appears at checkout.
- [ ] **1.2** In BM Multisafepay settings, toggle a method **off** → it disappears from checkout
      AND from Ordering → Payment Methods (toggle now re-imports). Toggle **on** → reappears.
- [ ] **1.3** Change **Environment/API key** and re-Sync → the method list reflects the new
      account, not a stale snapshot.

## 2. Group card methods (QA 2)

- [ ] **2.1** **Group Card Methods = OFF** → Sync → checkout shows Visa, Mastercard, Maestro,
      Amex as separate options.
- [ ] **2.2** **Group Card Methods = ON** → Sync → checkout shows a single **"Credit Card"**
      option. (Re-run Sync after each change.)

## 3. Payment method restrictions (QA 4)

- [ ] **3.1 Amount:** cart total **€30**, select in3 → **not shown** (min €50). Cart **€60** →
      in3 **shown**. Cart **€3500** → in3 **not shown** (max €3000).
- [ ] **3.2 Currency:** if a non-EUR currency site is available, a EUR-only method (e.g. iDEAL)
      is **not shown**; a multi-currency method (e.g. Visa) **is shown**.
- [ ] **3.3 Country:** cart shipping country outside a method's allowed countries → method not
      shown (e.g. a NL-only method for a non-NL address).
- [ ] **3.4 Customer/user type:** in Ordering → Payment Methods, restrict `MSP_IDEAL` to the
      **Registered** customer group. As a **guest** → iDEAL **not shown**; logged-in **registered**
      → iDEAL **shown**. (Ensure the import job runs in MERGE mode so this survives a re-sync.)

## 4. Inline payment components (QA 5)

- [ ] **4.1** Select **Visa/Mastercard/Maestro** → inline card component renders.
- [ ] **4.2** Select **Bancontact, Direct Debit, Riverty, in3, in3 business, Billink** → inline
      component renders (has_fields & is_enabled = true).
- [ ] **4.3** Select **iDEAL** → **no** inline component (redirect).
- [ ] **4.4** **Direct Debit** specifically → component renders and a payment can be completed.

## 5. Invalid / missing API key (QA 7)

- [ ] **5.1** Set an **invalid** Test API Key → open checkout billing: **no methods shown**, a
      message "MultiSafepay API key is invalid", and the pay/place-order button is disabled.
- [ ] **5.2** Clear the API key → message "not configured", methods hidden, checkout blocked.
- [ ] **5.3** Restore a **valid** key → methods reappear and checkout proceeds (validation is
      cached per session; a new session re-validates).

## 6. Address mapping — house number (QA 8)

- [ ] **6.1** Billing `Address1 = "Via Roma 10"`, Address2 empty → in MSP order the request has
      `address1 = "Via Roma"`, `house_number = "10"` (check the `Multisafepay_log` on the
      transaction or the MSP dashboard). No duplication.
- [ ] **6.2** `Address1 = "Via Roma"`, `Address2 = "10"` → same result.
- [ ] **6.3** A BNPL method (Riverty/in3/Billink) completes with the split address (these require
      house number). Watch the postal-code format (see 7).

## 7. Zip / postal code (QA 9)

- [ ] **7.1** NL address `1012 AB` and `1012AB` → **accepted** at checkout (storefront + billing).
- [ ] **7.2** US ZIP `12345` still accepted.
- [ ] **7.3** Complete a **BNPL** order (Riverty) with a NL postal code → MSP does **not** decline
      with "Value format is incorrect: customer.address.postalCode".

## 8. Payment method override after redirect (QA 10)

- [ ] **8.1** Select **iDEAL**, on the MSP page pay with **Alipay+** (or any different method) →
      after the webhook, BM order detail shows gateway = the **actual** method (e.g. `ALIPAYPLUS`),
      Payment Info and Order Payment Details consistent, log shows the override, no residual iDEAL.

## 9. Live API key — order status (QA 6)

- [ ] **9.1** Complete a normal payment (e.g. Visa/iDEAL) → order becomes **Completed** with
      Payment Status **Paid**; no "payment processor is unknown".
- [ ] **9.2** If an order ends **Failed** despite a completed payment, capture: order number,
      the **MSP** log around the notification, and the `Multisafepay-Webhook` result
      (200 vs notifyError) → send for diagnosis (HMAC signature / processor / webhook not received).

## 10. Partial refund (QA 11)

- [ ] **10.1** On a paid order, refund a **partial** amount from BM order detail → after the MSP
      webhook, Payment Status **stays Paid**, and **Amount Refunded** shows the refunded value.
- [ ] **10.2** Full refund → Payment Status **Not Paid**.

## 11. Manual capture (QA 12, 13)

- [ ] **11.1** Enable **Manual Capture**. Place a **Visa** order → BM order detail shows
      **Capture Status = Awaiting capture** and the **CAPTURE FULL PAYMENT** button
      (order status completed, financial status initialized).
- [ ] **11.2** Click **CAPTURE FULL PAYMENT** → success; status becomes **Captured on [date]**,
      button disappears.
- [ ] **11.3** Place an **iDEAL** order (instant) → **no** capture button / status (method does
      not support capture; settles to financial `completed`).
- [ ] **11.4** Place a **BNPL** order (Klarna/Billink/Afterpay) which sits in `uncleared` →
      **no** capture button (BNPL is captured via shipment, `manual_capture.supported=false`).
- [ ] **11.5** A **completed/already-captured** order shows **no** capture button.
- [ ] **11.6** Confirm the amount field in the box is labelled for **refund only** and the button
      says capture is always **full**.

## 12. Gift cards (QA 14)

- [ ] **12.1** With a gift card / coupon available on the MSP account, after Sync it appears at
      checkout (the payment-methods call uses `include_coupons=1`). A coupon transaction is
      completed.

## 13. Dashboard (QA 15)

- [ ] **13.1** With payments/refunds in the last 7 days, **Analytics → Multisafepay dashboard**
      shows **Revenue Last 7 Days** and **Returns Last 7 Days** charts populated (amounts), and
      the KPI counters valued.
- [ ] **13.2 (pagination)** On an account with many transactions, verify the totals/charts reflect
      **all** transactions (not just the first page). If they look truncated, capture a raw
      `GET /transactions` response so the exact pagination params can be wired.

## 14. Second QA round

- [ ] **14.1 (REQ-2.1.1 A) BNPL not Failed:** complete a **Riverty** payment → the order is
      **placed** (not Failed). It is placed as authorized/pending (Not Paid); a later
      completed/shipped notification settles it to **Paid**. Repeat for Klarna / Billink / in3.
- [ ] **14.2 (REQ-1.3.1 / 2.1.1 C) missing methods:** after Sync, confirm the previously missing
      methods appear — MyBank, Amazon Pay, KBC, Bancontact, Belfius, Direct Debit, Trustly, CBC,
      EPS, **DotPay (PL)**, MB Way, Multibanco, Bizum.
- [ ] **14.3 (REQ-2.1.1 B) in3 B2B:** `in3 business` (IN3B2B) appears for a cart **≥ €150** in a
      supported country.
- [ ] **14.4 (REQ-1.2.2) restriction visibility:** the BM payment-methods list shows the
      **min/max amount** badge (e.g. in3 min 50 / max 3000) and the **currencies**.
- [ ] **14.5 (REQ-1.1.4) grouping:** with **Group Card Methods = ON** and after Sync, only a
      single **Credit Card** method shows at checkout; the individual brands are disabled and the
      preference persists across page reloads.
- [ ] **14.6 (ADD-1.3) gift-card breakdown:** place an order paying part with a **gift certificate**
      and the rest with an MSP method → the BM order detail shows a **Gift card breakdown**
      (each gift card amount + the remaining amount on the MSP method). Test with **two** gift cards.
- [ ] **14.7 (REQ-1.4.3) live status:** a completed live payment results in **Completed / Paid**
      with no "processor unknown". If Failed, send order number + MSP log + webhook result.

---

## Regression watch-list

- [ ] **R.1** Checkout is not accidentally emptied when `MSP_*` methods are not yet imported
      (methods still show; SFCC gate skipped for un-imported gateways).
- [ ] **R.2** Deploying code **before** importing metadata does not break Sync or checkout
      (defensive guards; new features simply inactive until imported).
- [ ] **R.3** Cards still render the inline component with `group_cards=0`.
- [ ] **R.4** Gift Certificate (SFCC native) flow still works alongside MSP methods.
- [ ] **R.5** Redirect and direct (component) payment modes both complete; direct falls back to
      redirect on failure.
- [ ] **R.6** Re-running Sync does not wipe manually-configured customer-group restrictions
      (import MERGE mode).

---

## Data to send back if something fails

- Order number + the **MSP** log lines around the event.
- The `Multisafepay-Webhook` render result (notify vs notifyError).
- For method-visibility issues: the cart country/currency/amount and the affected method's CO
  (`enabled, countries, currencies, minAmount, maxAmount, supportsCapture`).
- For API-shape issues: the raw `GET /payment-methods` or `GET /transactions` response.
