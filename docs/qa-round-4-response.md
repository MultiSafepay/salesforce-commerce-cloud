# Response to the fourth round of QA validation

Reference: *BIP SFCC Integration – Fourth round of QA validation on sandbox* (MultiSafepay QA,
August 2026).

Every "Needs improvement" finding has been addressed. Three of them turned out to be the same
defect, described in detail in section 1. Two points (ADD-2, ADD-6) are scope questions rather
than defects and are answered at the end.

---

## Summary

| Point | Previous result | Status now |
|---|---|---|
| REQ-1.1.4 Payment methods synchronization flow | Needs improvement | **Fixed** — country availability now read from `allowed_countries`, checkout filters on the billing address, address form extended |
| REQ-1.2.2 Configuration reflected in checkout | OK | Unchanged |
| REQ-1.3.1 Components load correctly | Needs improvement | **Fixed** — same root cause as REQ-1.1.4 |
| REQ-1.4.3 Live environment uses live API key | OK | Unchanged |
| REQ-1.4.4 Invalid API key handled correctly | Needs improvement | **Fixed** — generic customer-facing message |
| REQ-2.1.1 Completed payment status synchronized | Needs improvement | **Fixed** — same root cause as REQ-1.1.4 (PayPal is an MSP-account setting, see below) |
| REQ-2.1.6 Shipment status sync for BNPL | Needs improvement | **Fixed** — wrong HTTP verb corrected, `msp-shipping` applied, setup instructions provided |
| REQ-2.2.1 Manual capture can be enabled | Needs improvement | **Fixed** — badge now requires `is_enabled` too |
| REQ-2.2.2 Full capture works correctly | Needs improvement | **Fixed** — button visibility, capture expiry, conditional `capture: manual` |
| ADD-1 Gift cards | OK | Unchanged |
| ADD-2 Recurring payments | Not implemented | Scope question — see below |
| ADD-3 Documentation | Not implemented | **Delivered** — see below |
| ADD-6 POS | Not implemented | Scope question — see below |
| ADD-7 Error initializing page | OK | Unchanged |

---

## 1. Missing payment methods — REQ-1.1.4, REQ-1.3.1, REQ-2.1.1

Your diagnosis was correct on both counts, and they compounded each other.

### What was happening

The synchronization called `GET /payment-methods?country=XX&currency=EUR` once per country
in an internal list, and rebuilt each method's country availability from *which probes had
returned it*. It never read `allowed_countries`.

That is where the `NL,DE,IT,BE,FR,ES,AT` list you could not trace came from: it was not a
configured value, it was the by-product of that probe loop. It broke in two ways:

* **`currency=EUR` was hardcoded**, so probes for PL, DK, SE, NO, GB, CZ, HU and RO returned
  nothing — those markets could never appear in any method's list.
* **A method with no restriction was pinned to the probe list.** Mastercard, which your API
  reports as `allowed_countries: []`, ended up stored as `DE,IT,BE,FR,ES,AT` — *without NL*.
  With a Dutch test address it was therefore filtered out, which is exactly what you observed.

That inferred list was also written into the SFCC payment-method definitions, so the platform's
own `isApplicable()` check re-applied the same wrong restriction — the `(6) FR, IT, DE, BE, AT,
ES` you screenshotted on `MSP_MASTERCARD`.

On top of that, the checkout filtered on the **shipping** address.

### Confirmed against your API

We ran the exact request the fixed sync now sends, against the sandbox account's test key:

| Query | Methods returned |
|---|---|
| `GET /payment-methods` — no country or currency filter | **30** |
| `GET /payment-methods?country=NL&currency=EUR` — the old probe | **16** |

The fourteen the old probe drops are exactly the fourteen listed in your REQ-2.1.1 table as
"The payment method doesn't appear in the checkout": Mastercard, Bancontact, MyBank, Amazon
Pay, KBC, Belfius, Direct Debit, Trustly, CBC, EPS, DotPay, MB Way, Multibanco and Bizum.
Every one of them is reported by your API with `allowed_countries: []` — no restriction at all.

Only one method in the whole catalogue is genuinely country-restricted: Riverty, to NL.

**in3 B2B**, the fifteenth entry on that list, is a different case: it carries a EUR 150
minimum and your test basket was EUR 64, so it was correctly withheld. That behaviour is right
and unchanged.

### What was changed

1. **One call, no filters.** The sync now calls `GET /payment-methods` without `country` or
   `currency` and reads each method's own restrictions from the response:
   * `allowed_countries: []` or absent → **no country restriction**, the method is offered
     everywhere;
   * `allowed_countries: ['NL']` → offered only to those countries.
2. **Filtering moved to the billing address**, as you suggested — that is where the payment is
   processed and what MultiSafepay validates against.
3. **Stale restrictions are cleared.** The generated `payment-methods.xml` now always contains
   a `<countries>` element, empty when there is no restriction, so the import removes the
   incorrect country lists already assigned to `MSP_*` methods by earlier syncs.
4. **The "Target Countries" preference has been removed.** It configured a mechanism that no
   longer exists; leaving it would keep suggesting that country availability is a Salesforce
   setting. It is not — it is your account's configuration, and the connector reads it.
5. **The Business Manager list now says "All countries"** for unrestricted methods instead of
   showing nothing, which is what made the data look arbitrary.

### On the address form

You were right that this blocked testing. The address form offered only United States,
Netherlands and China. It now covers the EU/EEA markets plus UK, Switzerland, US and China, so
country-restricted methods are reachable for both testing and real shoppers.

### One known limitation

The payment-method list is rendered when the billing step loads. Changing the billing country
*in the form* does not refresh the list until the step is submitted. Refreshing it live on
country change is an enhancement we can schedule if you consider it necessary for release.

### On PayPal

Confirmed — PayPal must be enabled on the MultiSafepay Merchant Panel account. Nothing on the
Salesforce side blocks it; once it is active on the account it will appear after the next
**Sync & Import**.

---

## 2. Invalid API key message — REQ-1.4.4

Agreed, the message disclosed too much. The storefront now shows a single neutral text for
every configuration failure:

> Online payment is temporarily unavailable. Please contact the store for assistance.

The same text is shown whether the key is invalid, missing or rejected — an anonymous shopper
can no longer infer the state of the integration. The technical detail (invalid vs not
configured, HTTP status) is written to the `multisafepay/MSP` custom log for the merchant. The
text lives in a resource bundle, so it can be translated per locale.

---

## 3. BNPL shipment synchronization — REQ-2.1.6

**The job was set up correctly on your side.** The failure was ours: `updateOrderShipped` sent
a **`POST`** to `orders/{order_id}`. We confirmed this against your test API:

| Request | Response |
|---|---|
| `PATCH /v1/json/orders/<unknown-id>` | `404 Invalid transaction ID` — verb accepted |
| `POST /v1/json/orders/<unknown-id>` | `405 Method not allowed` — verb rejected |

So the call could never take effect: no error surfaced in Salesforce and the job reported a
green run. It now uses **`PATCH`**.

Three further changes so this cannot fail silently again:

* Empty `tracktrace_code` / `carrier` / `ship_date` are now **omitted** instead of being sent
  as empty strings. When the SFCC shipment carries a tracking number, it is forwarded together
  with the carrier name.
* The job now returns **ERROR** with the MultiSafepay error text when a notification fails, so
  it is visible in **Job History** rather than swallowed.
* The job refuses to run if the `Multisafepay_ShipmentNotified` attribute is missing from the
  metadata — without it, it cannot remember what it already sent and would re-notify on every
  execution.

**Step-by-step setup instructions** are now in *Platform User Guide*, section 13, including how
to verify the result in Job History and in the Merchant Panel.

**`msp-shipping`** — corrected. The shipping-cost line in the order request now uses
`"merchant_item_id": "msp-shipping"`.

---

## 4. Manual capture — REQ-2.2.1, REQ-2.2.2

| Your finding | What was done |
|---|---|
| The Capture badge ignored `manual_capture.is_enabled` | Correct — it read `supported` only. A method is now marked capturable only when **both** `manual_capture.supported` and `manual_capture.is_enabled` are true. Re-run **Sync & Import** to refresh the badges. |
| `"capture": "manual"` sent for methods that do not support it | Corrected. The site preference expresses the merchant's intent; the selected method's own capability now decides whether it is honoured. iDEAL and similar methods no longer receive it. |
| No Capture option in the SFCC order details | The visibility rule was an allow-list on the financial status (`initialized`/`uncleared`). Any order whose financial status had not been stored — for instance one whose webhook was processed before that field was introduced — failed the check and the button never rendered. It is now a deny-list: an authorized payment offers Capture unless it is demonstrably settled (`completed`, `refunded`, `partial_refunded`, `declined`, `expired`, `cancelled`, `void`, `chargeback`). |
| No capture expiration date | Added. The deadline reported by MultiSafepay is stored and shown as **Capture Expiry** in the order's Payment tab, with a note that the authorization is released afterwards. |

Please retest the Capture button on a **freshly created** order: the evidence in the report
(order 00007504, 14/08) predates several of these changes.

---

## 5. Documentation — ADD-3

The documentation exists and is delivered with this round:

* `docs/platform user guide.md` — merchant-facing: setup, synchronization, managing methods,
  manual capture, refunds, dashboard, statuses, test→live switch, FAQ, and the new BNPL job
  scheduling section.
* `docs/technical documentation.md` — architecture, payment flow, per-component reference,
  metadata, API reference, operational notes, and a section per QA round including this one.

It was written in an earlier round but never handed over — our oversight, not a gap in the
work.

---

## 6. Scope questions — ADD-2 and ADD-6

These are not defects; they are not built.

* **ADD-2 Recurring payments** — no tokenization or recurring flow exists in the connector.
* **ADD-6 POS / omnichannel** — no C-TAP or SmartPOS integration exists. Your reading of the
  sandbox is accurate.

Both were listed in the SAL 23/01 project document. We need to agree with you whether they are
in scope for this release and, if so, on a delivery plan — they are development work, not
fixes, and cannot be closed as part of this round.

---

## Before retesting

1. **Import the metadata** (`metadata/site-import`) — it adds `Multisafepay_CaptureExpiry` and
   removes `Multisafepay_TargetCountries`.
2. **Re-run "Sync & Import"** on the MultiSafepay settings page. This is required: the country,
   currency and capture data stored by the previous sync is wrong, and both the checkout and
   the payment-method definitions read from it.
3. **Verify the import job succeeded** in *Administration → Operations → Job History*. This is
   what clears the stale country lists from the `MSP_*` payment methods.
4. **Schedule `MSP-NotifyShipments`** if you want to retest BNPL shipment sync — *Platform User
   Guide*, section 13.
5. Use a **new order** for the capture tests.
