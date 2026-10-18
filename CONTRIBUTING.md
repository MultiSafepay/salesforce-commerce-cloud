<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/multisafepay-logo-dark.png">
    <img src="docs/assets/multisafepay-logo.png" alt="MultiSafepay" width="300">
  </picture>
</p>

# Contributing

## Contents

- [Authors](#authors)
- [Where changes go](#where-changes-go)
- [Before you commit](#before-you-commit)
- [Commit messages](#commit-messages)
- [Deploying a change](#deploying-a-change)
- [Traps already paid for](#traps-already-paid-for)
- [Credentials](#credentials)
- [Back to README](./README.md)

---

## Authors

<p align="center">
  <a href="https://www.bip-group.it"><img src="docs/assets/bip-logo.png" alt="BIP" width="110"></a>
</p>

<p align="center">
  The MultiSafepay connector for Salesforce B2C Commerce was designed and built at
  <a href="https://www.bip-group.it"><b>BIP</b></a> by
</p>

<table align="center">
  <tr>
    <td align="center">
      <a href="https://github.com/gbrossa97">
        <img src="https://github.com/gbrossa97.png?size=160" width="80" alt="Giorgia Brossa"><br>
        <b>Giorgia Brossa</b></a><br>
      <sub>@gbrossa97</sub>
    </td>
    <td align="center">
      <a href="https://github.com/Silverhand96">
        <img src="https://github.com/Silverhand96.png?size=160" width="80" alt="Mattia Lusian"><br>
        <b>Mattia Lusian</b></a><br>
      <sub>@Silverhand96</sub>
    </td>
  </tr>
</table>

The Storefront Reference Architecture it builds on (`app_storefront_base`,
`bm_app_storefront_base`, `modules`) is © Salesforce, under the terms in
[license.txt](license.txt).

---

## Where changes go

| Change | Cartridge |
|---|---|
| Checkout, payment hooks, webhook, order payload, shipment job | `cartridges/multisafepay` |
| Settings page, Sync & Import, dashboard, order detail | `cartridges/bm_multisafepay` |
| Site preferences, custom attributes, custom objects, services | `metadata/site-import` |

**Never edit `app_storefront_base`.** To change SFRA behaviour, override the file in
`multisafepay`. The cartridge path loads it first.

Everything about how a MultiSafepay `/payment-methods` response is interpreted lives in
`multisafepayHelper.mapApiPaymentMethod`. Change it there and nowhere else.

---

## Before you commit

```
npm run test:msp
```

This is the gate. It runs in under a second and must be green.

- `npm test` runs the SFRA base suite. That suite does not start on current Node
  versions and says nothing about MultiSafepay code.
- The husky hooks are broken for the same reasons (`pre-commit` lints the SFRA base,
  `pre-push` runs `npm test`). Commit and push with `--no-verify` **after** running
  `test:msp` yourself.
- When you fix a behaviour, add the test that would have caught it. Tests live in
  `test/msp/`. The `dw/*` modules are stubbed in `test/msp/helpers/sfccModules.js`.

---

## Commit messages

A short imperative subject line, then a body that explains **why**. Write down what was
observed, what caused it and why this fix and not another. The diff already shows *what*
changed. The reason is usually not visible in the code, and it is the part the next
person will need.

```
Fix MSP-NotifyShipments: send the fields MSP requires for status shipped

MSP-NotifyShipments failed on the QA sandbox, 7 of 7 orders, with
HTTP 410: Required fields: tracktrace_code, carrier, ship_date …
```

If the reason behind a line of code is not obvious from the code itself, also put it in
a comment next to that line.

---

## Deploying a change

```
npx sgmf-scripts --uploadCartridge multisafepay
npx sgmf-scripts --uploadCartridge bm_multisafepay
```

`npm run uploadCartridge` uploads the SFRA base only. After every deploy:

1. Import `metadata/site-import`.
2. Re-run **Sync & Import** on the Multisafepay settings page.
3. Confirm in *Job History* that **`MSP-ImportPaymentMethods`** finished OK.

Without step 3 a correct fix looks as though it has not worked.

---

## Traps already paid for

Each of these cost at least one QA round. The full story is in the
[handover](docs/handover-2026-09.md).

- **Custom string attributes are Java `String` objects.**
  `order.custom.Foo === 'completed'` is always false, whatever the value. Normalise
  with `String(x || '')` where you read the attribute, and compare that copy.
- **`describe().getCustomAttributeDefinition()` can report existing attributes as
  undefined.** Read the attribute directly inside a `try/catch` instead.
- **`allowed_countries: []` means available everywhere.** Never infer a country list,
  and never pass `country` or `currency` to `/payment-methods`, because that
  pre-filters the catalogue.
- **MultiSafepay order updates use `PATCH`.** `POST` returns 405, and a job that does not
  check the response still reports OK.
- **A green job is not proof.** Check the effect on the MultiSafepay side.
- **Manual capture applies only from the moment it is enabled.** Turning the setting on
  later does not make an order that was already placed capturable.
- **The `multisafepay` log category may be disabled on an instance.** In that case every
  `Logger.getLogger('multisafepay', …)` line is discarded. When a diagnostic has to
  survive, render it into the page as an HTML comment.

---

## Credentials

API keys, OCAPI secrets and WebDAV access keys never go into the repository, a commit or
a message. `dw.json` is gitignored. Keep it that way.
