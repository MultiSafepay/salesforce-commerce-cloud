# Progetto SFCC-Multisafepay

## Percorso del progetto

Il codice del progetto si trova al seguente path:

```
C:\Users\gbrossa\SFCC-Multisafepay
```

## Tipo di progetto

Si tratta di un progetto **Salesforce Commerce Cloud (SFCC)**, e quindi di un progetto **Node.js**.

Le istruzioni di compilazione (build), i task disponibili e le dipendenze sono definite nel file `package.json` presente nella root del progetto.

## Struttura delle cartridge

Il progetto contiene **5 cartridge** in totale, ma quelle di interesse su cui è necessario intervenire per eventuali modifiche sono:

- **`bm_multisafepay`**: cartridge custom relativa al **Business Manager**.
- **`multisafepay`**: cartridge che agisce direttamente sul **sito** (storefront).

## Note

- Per le modifiche lato back-office (configurazioni, pannelli custom nel Business Manager) intervenire su `bm_multisafepay`.
- Per le modifiche lato front-end/storefront (comportamento del pagamento sul sito) intervenire su `multisafepay`.
