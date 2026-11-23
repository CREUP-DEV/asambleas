# AutoFirma client

`autoscript.js` is the JavaScript client (version 1.9.0) of
[AutoFirma](https://firmaelectronica.gob.es/Home/Descargas.html), the
signing application of the Gobierno de España, as shipped with its
integration kit (Cliente @firma, GPL 2+ / EUPL 1.1), and as the CREUP
Intranet serves it for its attendance certificates. The page of the acta de
acuerdos loads it on demand to sign the record with the signer's own
certificate (`app/composables/agreements-record/autofirma.ts`). Keep it as
shipped: replace the whole file to upgrade it.
