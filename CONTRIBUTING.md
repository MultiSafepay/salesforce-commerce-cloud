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
- [Platform behaviours to know](#platform-behaviours-to-know)
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
npm test
```

This is the gate. It runs in under a second, needs no installed dependencies, and must
be green. CI runs it on every push and pull request.

- `npm run test:sfra` runs the original SFRA unit suite. It does not cover MultiSafepay code.
- When you fix a behaviour, add the test that would have caught it. Tests live in
  `test/msp/`. The `dw/*` modules are stubbed in `test/msp/helpers/sfccModules.js`.

---

## Commit messages

A short imperative subject line, then a body that explains **why**. Write down what was
observed, what caused it and why this fix and not another. The diff already shows *what*
changed. The reason is usually not visible in the code, and it is the part the next
person will need.

```
Send tracking code, carrier and ship date when notifying a shipment

MultiSafepay rejects a "shipped" update without tracktrace_code, carrier
and ship_date (HTTP 410). Orders marked shipped from Business Manager
usually have no tracking number, so the job sent neither field …
```

If the reason behind a line of code is not obvious from the code itself, also put it in
a comment next to that line.

---

## Deploying a change

```
npm run build
npx sgmf-scripts --uploadCartridge multisafepay
npx sgmf-scripts --uploadCartridge bm_multisafepay
```

An upload replaces the whole cartridge on the instance, so build first: the compiled
storefront assets of `multisafepay` are not in the repository. `npm run build` compiles
the `multisafepay` client code only; the SFRA base cartridges are built and deployed on
their own. After every deploy:

1. Import `metadata/site-import`.
2. Re-run **Sync & Import** on the Multisafepay settings page.
3. Confirm in *Job History* that **`MSP-ImportPaymentMethods`** finished OK.

Without step 3 a correct fix looks as though it has not worked.

---

## Platform behaviours to know

These are easy to get wrong and hard to notice when you do.

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
  `Logger.getLogger('multisafepay', …)` line is discarded. Enable it under
  *Administration → Operations → Custom Log Settings* before relying on the logs.

---

## Credentials

API keys, OCAPI secrets and WebDAV access keys never go into the repository, a commit or
a message. `dw.json` is gitignored. Keep it that way.
