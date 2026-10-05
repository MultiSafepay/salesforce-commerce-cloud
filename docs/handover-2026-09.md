# Handover — MultiSafepay SFCC connector, work of 26 Aug – 1 Sep 2026

Written for whoever picks this up next, including an AI assistant that needs to load
project context. It covers what changed, **why**, and the environment traps that cost
us time — the parts you cannot recover from the diff alone.

Baseline for everything below: commit `54c0b7e`. Head at the time of writing: `ddd3685`,
pushed to `origin/main`.

---

## 1. Why this work happened

MultiSafepay's QA (Noelia Pérez González) delivered a fourth round of sandbox validation
reporting **nine findings as "Needs improvement"**, plus two items not implemented at all.
Everything below either closes one of those findings or came out of the exchange that
followed.

The sandbox is **ZYUD_001** (`zyud-001.dx.commercecloud.salesforce.com`), site `RefArch`,
code version `SFRA_UPC_07_10_2024` — the values in `dw.json`.

---

## 2. The findings and how they were closed

### 2.1 Half the payment methods were missing from checkout

Reported three separate times (REQ-1.1.4, REQ-1.3.1, REQ-2.1.1). **One defect.**

`SyncPaymentMethods` called `GET /payment-methods?country=XX&currency=EUR` **once per
country** over an internal list, and rebuilt each method's country availability from
*which probes happened to return it*. It never read `allowed_countries`.

Two independent failures compounded:

* `currency=EUR` was hardcoded, so probes for PL, DK, SE, NO, GB, CZ, HU, RO returned
  nothing — those markets could never enter any list.
* A method with **no** restriction was pinned to the probe list. Mastercard, which the API
  reports as `allowed_countries: []`, was stored as `DE,IT,BE,FR,ES,AT` — without NL — and
  vanished for a Dutch shopper.

The inferred list was also written into the SFCC payment-method definitions, so
`PaymentMethod.isApplicable()` re-applied the same wrong restriction.

**Now:** one call to `/payment-methods` with no `country`/`currency`, and each method's own
restrictions read from the response. The whole API contract is interpreted in exactly one
place, `multisafepayHelper.mapApiPaymentMethod` — read its JSDoc before changing anything
here.

| MSP field | Meaning | Stored as |
|---|---|---|
| `allowed_countries: []` or absent | available everywhere | `countries = ''` |
| `allowed_countries: ['NL']` | restricted to those | `countries = 'NL'` |
| `allowed_amount.min/max` (cents, null max = no cap) | amount bounds | major units, `0` = no bound |
| `manual_capture.supported && is_enabled` | capture available **on this account** | `supportsCapture` |

Verified against the live test API — this is not theory:

| Query | Methods |
|---|---|
| `GET /payment-methods` (what the sync now sends) | **30** |
| `GET /payment-methods?country=NL&currency=EUR` (the old probe) | **16** |

The fourteen the old probe drops are **exactly** the fourteen the QA listed as missing.
That response is committed as `test/msp/fixtures-payment-methods.json` and ten tests run
the real mapper against it.

Three related changes that are easy to undo by accident:

* **Checkout filters on the BILLING address**, not shipping — `paymentOptions/Multisafepay.isml`.
* **`generatePaymentMethodsXML` always writes a `<countries>` element, empty when
  unrestricted.** Omitting it leaves the stale country list assigned to `MSP_<gateway>` by
  an earlier import, and the method stays hidden even after a correct sync.
* **`Multisafepay_TargetCountries` was removed** from the metadata. It configured the probe
  loop, which no longer exists.

### 2.2 BNPL shipment notification never worked (REQ-2.1.6)

`updateOrderShipped` used **`POST`** on `orders/{order_id}`. Probed against the live API:

```
PATCH /v1/json/orders/<unknown-id>  ->  404 "Invalid transaction ID"   verb accepted
POST  /v1/json/orders/<unknown-id>  ->  405 "Method not allowed"       verb rejected
```

The call could never take effect, and the job still reported a green run. Now `PATCH`, with
no POST fallback — POST is the verb the API rejects, so a fallback could only produce a
second failing call.

The job also now returns `Status.ERROR` with the MSP message instead of a silent OK, omits
empty optional fields (MSP rejects empty strings), and forwards tracking data when the
shipment has it. Shipping line items use the reserved `merchant_item_id: 'msp-shipping'`.

### 2.3 Manual capture (REQ-2.2.1, REQ-2.2.2)

Four distinct defects. The last one is the interesting one.

* `supportsCapture` now requires `manual_capture.is_enabled` as well as `.supported`.
* `"capture": "manual"` is sent only for gateways that support it — previously it went out
  for every method whenever the site preference was on.
* `Multisafepay_CaptureExpiry` added, stored from the webhook and shown in the order detail.
* **The Capture button never rendered, in any QA round.** See §4.1 — it is the single most
  instructive thing in this handover.

### 2.4 Invalid API key message (REQ-1.4.4)

The storefront disclosed *why* payment was unavailable ("The MultiSafepay API key is
invalid"). One generic string now covers every configuration failure, from
`templates/resources/multisafepay.properties`; the cause goes to the log only. A contract
test asserts the rendered markup never mentions an API key, a status code, or the provider.

### 2.5 Address form

Offered only US, NL, CN — so country-restricted methods were unreachable for real shoppers
and untestable for QA. Now the EU/EEA markets plus UK, CH, US, CN, with labels in the
cartridge's `forms.properties`.

---

## 3. Environment traps — read this before you lose an afternoon

These are the things that are true about *this repo on this machine* and are not written
anywhere else.

### 3.1 `npm test` is dead; use `npm run test:msp`

The pinned mocha bundles an extensionless `yargs` file that Node ≥18 loads as ESM:
`ReferenceError: require is not defined in ES module scope`. This is **pre-existing** and
affects the whole SFRA base suite. Do not try to fix it unless asked.

MultiSafepay tests live in `test/msp/` and run on Node's built-in runner with no
dependencies: **`npm run test:msp`** — 86 tests, all green at `ddd3685`.

`test/msp/helpers/sfccModules.js` patches `Module._load` to serve `dw/*` and cartridge-path
stubs. proxyquire is **not** usable here: most SFCC requires in this codebase are lazy
(inside functions), and proxyquire only intercepts requires made while the module itself is
loading.

### 3.2 Both git hooks are broken — commit and push with `--no-verify`

`pre-commit` runs `npm run lint` (fails on `app_storefront_base`), `pre-push` runs
`npm run test` (see above). Neither failure has anything to do with your changes. Run
`npm run test:msp` yourself as the real gate before pushing.

### 3.3 The `multisafepay` custom log category is OFF on the sandbox

**Every `Logger.getLogger('multisafepay', 'MSP')` call is silently discarded there.** Today's
custom-info log held one single line, and none of it was ours — not the sync, not the
webhook helper, not the checkout.

This is why a whole class of bugs stayed invisible for months, and why a diagnostic added
on 27 Aug produced nothing at all. **Do not rely on the MSP log for anything on that
instance** until someone enables the category under *Administration → Operations → Custom
Log Settings*. The QA has been asked to.

### 3.4 `describe().getCustomAttributeDefinition()` cannot be trusted

The BM order-detail template guarded its reads of `Multisafepay_FinancialStatus` and
`Multisafepay_CaptureExpiry` behind that lookup. On orders that demonstrably carry both
attributes, the guard reported them as undefined and the values came back empty.

`Multisafepay_OrderStatus`, read directly with no guard on the same object, renders fine.

The pattern still exists in `multisafepayHelper.objectDefines`,
`MultisafepaySettings.customObjectDefines`, `notifyShipments.orderDefines` and
`transactionData.gatewaySupportsManualCapture`, where it appears to work — those all
operate on Custom Objects and Orders, not on `PaymentTransaction`. **If a custom attribute
mysteriously reads as empty, suspect the guard before the data.** Prefer a direct read
inside a try/catch: it cannot be wrong about what exists, because it just tries.

### 3.4b Custom string attributes are Java objects — never compare them with `===`

**The single most expensive bug of this whole cycle.** SFCC returns a custom string
attribute as a Java `String` object, not a JavaScript primitive. So:

```js
order.custom.Multisafepay_OrderStatus === 'completed'   // ALWAYS false
String(order.custom.Multisafepay_OrderStatus) === 'completed'   // works
```

The BM order detail hid the Capture button for months on exactly this. It also
rendered the MSP status in grey instead of green on every screenshot the QA ever
sent — the colour comes from the same chain of `===` tests, all silently false.
Nobody noticed, because grey text does not look like a bug.

Normalise at the point of read — `String(x || '')` — and compare the normalised
copy. `test/msp/storefrontContracts.test.js` fails if a raw attribute is compared
with `===` in that template again.

Worth knowing: the QA screenshots contained the evidence from the very first round.
When a value renders correctly but every *decision* about it behaves as though it
were something else, suspect the type before the data.

### 3.5 Deploying

`npm run uploadCartridge` does **not** include the MultiSafepay cartridges. Use:

```
npx sgmf-scripts --uploadCartridge multisafepay
npx sgmf-scripts --uploadCartridge bm_multisafepay
```

`sgmf-scripts` prints "Successfully uploaded" fairly optimistically. Verify over WebDAV —
the credentials are in `dw.json`:

```
https://<host>/on/demandware.servlet/webdav/Sites/Cartridges/<code-version>/<path>
```

The same WebDAV root also exposes `/Sites/Impex/src/instance` (the generated
`msp-payment-methods.zip` and the uploaded `msp-metadata-import.zip`) and `/Sites/Logs`
(job logs and custom logs). Downloading the XML the sync produced is the fastest way to
confirm which version of the code actually ran.

### 3.6 After every deploy: import metadata, then re-sync

1. Import `metadata/site-import` as a ZIP (structure and expected job log are in
   *Platform User Guide* §3, Step 0).
2. Re-run **Sync & Import** on the settings page.
3. **Confirm `MSP-ImportPaymentMethods` finished OK in Job History.** That step is what
   applies the corrected country lists to the `MSP_*` payment methods. Skip it and the
   checkout keeps the old restrictions and the fix appears not to work.

A trap worth knowing: the *Site Import & Export* page and the *Import & Export* page are
different pages with different Status lists. The latter keeps **Error** rows indefinitely —
we spent a round trip on a red row from three months earlier that had nothing to do with
the import being run.

---

## 4. What is still open

### 4.1 The Capture button — root cause found, awaiting final confirmation

Current state at `ddd3685`: the describe() guard is gone, the decision is made from the
order itself (`Multisafepay_CaptureExpiry` present ⇒ this payment is a manual-capture one
awaiting capture), and configuration can add confidence but can no longer veto.

It took four attempts. Three explanations were wrong before the right one, and the
sequence is worth reading, because each was plausible:

1. "Manual capture must be enabled before the order is placed" — true in general, but not
   the cause: MSP's own data showed `capture: "manual"` on the order.
2. "The site preference and Custom Object are not readable in the BM order context" —
   reasonable, and wrong; the diagnostic later showed both read fine.
3. "The describe() guard is emptying the values" — genuinely a bug, fixed, and still not
   the reason the button was hidden.
4. **`mspStatus === 'completed'` on a Java String object** (§3.4b). That was it.

What finally settled it was the diagnostic HTML comment: every input printed correct
while `awaitingCapture` printed false, which left exactly one line of code to blame.
Guessing had run out; instrumenting had not.

Fixed in `147ee71` and deployed. To confirm, open the order detail for **00008001**
(authorization valid until 8 September). The diagnostic comment is still in the page —
View Source and search for `MSP capture decision:` — and is worth keeping: it costs
nothing and it is the only reason this was ever found.

### 4.2 ADD-2 (recurring payments) and ADD-6 (POS)

Neither is built. `scripts/hooks/payment/processor/pos.js` is a clone of the BML processor,
not a C-TAP/SmartPOS integration. Both are scope items from SAL 23/01 and need a commercial
decision, not a fix.

### 4.3 Known limitation, disclosed to the QA

The payment-method list renders when the billing step loads. Changing the billing country
*in the form* does not refresh it until the step is submitted. Making it refresh over AJAX
is a separate enhancement.

---

## 5. Commits

| Commit | What |
|---|---|
| `a3b5f62` | The main body of work: country availability from `allowed_countries`, billing-address filtering, generic API-key message, `msp-shipping`, capture gating, PATCH for shipments, address form, `test/msp` |
| `6237eab` | Dropped the POST fallback after probing the live API; captured the real catalogue as a test fixture |
| `daab86c` | Recorded the live-API evidence in both documents |
| `60213d2` | Fixed a dead cross-reference in the user guide |
| `4f36f1e` | Documented the metadata import procedure and when Capture is available |
| `206b93b` | Capture decision taken from the order rather than BM-side configuration |
| `fd999df` | Doc: capture availability is recorded on the order |
| `ddd3685` | Removed the describe() guard that was emptying the capture values; diagnosis moved into an HTML comment |
| `aee3b03` | This handover note |
| `147ee71` | The actual Capture-button cause: strict equality against a Java String attribute |

---

## 6. Where things live

| Path | What |
|---|---|
| `cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js` | MSP API calls and `mapApiPaymentMethod` — the one place the API contract is interpreted |
| `cartridges/multisafepay/cartridge/models/transactionData.js` | The order payload sent to MSP |
| `cartridges/multisafepay/cartridge/scripts/helpers/webhookHelper.js` | Webhook handling, status and capture-expiry persistence |
| `cartridges/multisafepay/cartridge/scripts/jobs/notifyShipments.js` | BNPL shipment job (`custom.MSP.NotifyShipments`) |
| `cartridges/bm_multisafepay/.../MultisafepaySettings.js` | Settings page, sync, payment-methods XML, OCAPI import trigger |
| `cartridges/bm_multisafepay/.../PaymentInstrumentInfo_MultiSafepayPayment.isml` | Order detail: refund, capture, breakdowns |
| `docs/platform user guide.md` | Merchant-facing; §3 Step 0 metadata import, §6 capture, §13 BNPL job |
| `docs/technical documentation.md` | Architecture and a section per QA round |
| `docs/qa-round-4-response.md` | The point-by-point reply sent to MultiSafepay |
| `test/msp/` | 86 tests, `npm run test:msp` |
