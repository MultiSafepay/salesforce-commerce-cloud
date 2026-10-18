"use strict";

var server = require('server');
var Transaction = require('dw/system/Transaction');
var CustomObjectMgr = require('dw/object/CustomObjectMgr');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');
var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');

/**
 * Reads one custom attribute, tolerating an attribute the metadata does not define.
 * Never throws.
 * describe().getCustomAttributeDefinition() is not used: it has reported attributes as
 * undefined on objects that carry them, which silently emptied the values behind it.
 * @param {dw.object.ExtensibleObject} extObj - object to read from
 * @param {string} attrId - custom attribute id
 * @param {*} fallback - value returned when the attribute is missing or empty
 * @returns {*} the stored value, or `fallback`
 */
function readCustom(extObj, attrId, fallback) {
  try {
    var value = extObj.custom[attrId];
    return (value === undefined || value === null) ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

/**
 * Writes one custom attribute, tolerating an attribute the metadata does not define:
 * writing an undefined attribute throws "Unknown dynamic property" and would abort
 * the whole Sync. Never throws.
 * @param {dw.object.ExtensibleObject} extObj - object to write to
 * @param {string} attrId - custom attribute id
 * @param {*} value - value to store
 * @returns {boolean} whether the value was stored
 */
function setCustom(extObj, attrId, value) {
  try {
    // eslint-disable-next-line no-param-reassign
    extObj.custom[attrId] = value;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Gets an OCAPI access token using configured client credentials.
 * @returns {string|null} access token or null if failed
 */
function getOCAPIToken() {
  var HTTPClient = require('dw/net/HTTPClient');
  var Encoding = require('dw/crypto/Encoding');
  var Bytes = require('dw/util/Bytes');

  var clientId = currentSite.getCustomPreferenceValue('Multisafepay_OCAPI_ClientId');
  var clientSecret = currentSite.getCustomPreferenceValue('Multisafepay_OCAPI_ClientSecret');

  if (!clientId || !clientSecret) {
    return null;
  }

  var authClient = new HTTPClient();
  authClient.open('POST', 'https://account.demandware.com/dw/oauth2/access_token');
  var credentials = Encoding.toBase64(new Bytes(clientId + ':' + clientSecret, 'UTF-8'));
  authClient.setRequestHeader('Authorization', 'Basic ' + credentials);
  authClient.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  authClient.send('grant_type=client_credentials');

  if (authClient.statusCode !== 200) {
    Logger.error('[OCAPI] Failed to get token. Status: {0}', authClient.statusCode);
    return null;
  }

  return JSON.parse(authClient.text).access_token;
}

/**
 * Generates a Payment Methods XML in the IMPEX directory (site archive format).
 * Uses only native SFCC dw/io APIs.
 * @param {Array} methods - array of {gatewayId, name, enabled, countries}
 * @returns {boolean} true if file was generated successfully
 */
function generatePaymentMethodsXML(methods) {
  var File = require('dw/io/File');
  var FileWriter = require('dw/io/FileWriter');
  var XMLStreamWriter = require('dw/io/XMLStreamWriter');

  try {
    // Payment methods must be in sites/<siteId>/ within the archive
    var siteId = currentSite.getID();
    var siteDir = new File(File.IMPEX + '/src/instance/msp-payment-methods/sites/' + siteId);
    if (!siteDir.exists()) {
      siteDir.mkdirs();
    }

    var xmlFile = new File(File.IMPEX + '/src/instance/msp-payment-methods/sites/' + siteId + '/payment-methods.xml');
    var fileWriter = new FileWriter(xmlFile, 'UTF-8');
    var xsw = new XMLStreamWriter(fileWriter);

    xsw.writeStartDocument('UTF-8', '1.0');
    xsw.writeCharacters('\n');
    xsw.writeStartElement('payment-settings');
    xsw.writeDefaultNamespace('http://www.demandware.com/xml/impex/paymentsettings/2009-09-15');
    xsw.writeCharacters('\n');

    for (var i = 0; i < methods.length; i++) {
      var method = methods[i];
      var methodId = 'MSP_' + method.gatewayId;

      xsw.writeCharacters('  ');
      xsw.writeStartElement('payment-method');
      xsw.writeAttribute('method-id', methodId);
      xsw.writeCharacters('\n');

      xsw.writeCharacters('    ');
      xsw.writeStartElement('name');
      xsw.writeAttribute('xml:lang', 'x-default');
      xsw.writeCharacters(method.name || method.gatewayId);
      xsw.writeEndElement();
      xsw.writeCharacters('\n');

      xsw.writeCharacters('    ');
      xsw.writeStartElement('description');
      xsw.writeAttribute('xml:lang', 'x-default');
      xsw.writeCharacters((method.name || method.gatewayId) + ' via MultiSafepay');
      xsw.writeEndElement();
      xsw.writeCharacters('\n');

      xsw.writeCharacters('    ');
      xsw.writeStartElement('enabled-flag');
      xsw.writeCharacters(method.enabled ? 'true' : 'false');
      xsw.writeEndElement();
      xsw.writeCharacters('\n');

      xsw.writeCharacters('    ');
      xsw.writeStartElement('processor-id');
      xsw.writeCharacters('MultiSafepayPayment');
      xsw.writeEndElement();
      xsw.writeCharacters('\n');

      // Allowed countries.
      // `method.countries` is empty when MSP reports allowed_countries: [] — i.e.
      // the method has NO country restriction. In that case the <countries>
      // element is still written, but EMPTY, so the import CLEARS any country
      // list a previous (incorrect) import had assigned to the SFCC payment
      // method. Omitting the element entirely would leave the stale restriction
      // in place and the method would keep disappearing at checkout.
      xsw.writeCharacters('    ');
      xsw.writeStartElement('countries');
      var countryList = (method.countries || '').split(',');
      var writtenCountries = 0;
      for (var c = 0; c < countryList.length; c++) {
        var cc = countryList[c].trim().toUpperCase();
        if (cc) {
          if (writtenCountries === 0) { xsw.writeCharacters('\n'); }
          xsw.writeCharacters('      ');
          xsw.writeEmptyElement('country');
          xsw.writeAttribute('country-code', cc);
          xsw.writeCharacters('\n');
          writtenCountries++;
        }
      }
      if (writtenCountries > 0) { xsw.writeCharacters('    '); }
      xsw.writeEndElement();
      xsw.writeCharacters('\n');

      xsw.writeCharacters('  ');
      xsw.writeEndElement();
      xsw.writeCharacters('\n');
    }

    xsw.writeEndElement();
    xsw.writeEndDocument();
    xsw.close();
    fileWriter.close();

    // Try to create ZIP archive (preferred by ImportSiteArchive)
    try {
      var archiveDir = new File(File.IMPEX + '/src/instance/msp-payment-methods');
      var zipFile = new File(File.IMPEX + '/src/instance/msp-payment-methods.zip');
      if (zipFile.exists()) {
        zipFile.remove();
      }
      archiveDir.zip(zipFile);
      Logger.info('[GenerateXML] Created ZIP archive with {0} methods', methods.length);
    } catch (zipErr) {
      Logger.warn('[GenerateXML] ZIP creation failed ({0}), using directory fallback', zipErr.message);
    }

    Logger.info('[GenerateXML] Written payment-methods.xml with {0} methods', methods.length);
    return true;
  } catch (e) {
    Logger.error('[GenerateXML] Error: {0}', e.message);
    return false;
  }
}

/**
 * Triggers the MSP-ImportPaymentMethods job via OCAPI.
 * @returns {Object} {success: boolean, message: string}
 */
function triggerImportJob() {
  var HTTPClient = require('dw/net/HTTPClient');
  var System = require('dw/system/System');

  var accessToken = getOCAPIToken();
  if (!accessToken) {
    return { success: false, message: 'OCAPI credentials not configured.' };
  }

  var instanceHostname = System.getInstanceHostname();
  var jobUrl = 'https://' + instanceHostname + '/s/-/dw/data/v24_5/jobs/MSP-ImportPaymentMethods/executions';

  var client = new HTTPClient();
  client.open('POST', jobUrl);
  client.setRequestHeader('Authorization', 'Bearer ' + accessToken);
  client.setRequestHeader('Content-Type', 'application/json');
  client.send('{}');

  if (client.statusCode === 200 || client.statusCode === 202) {
    Logger.info('[TriggerImport] Job triggered successfully');
    return { success: true, message: 'Import job triggered. Check Job History for status.' };
  }

  var errorDetail = client.text || 'no details';
  Logger.error('[TriggerImport] Failed. Status: {0}, Body: {1}', client.statusCode, errorDetail);
  return { success: false, message: 'Job trigger failed (HTTP ' + client.statusCode + '): ' + errorDetail };
}

server.get('Start', csrfProtection.generateToken, function (_req, res, next) {
  // Load existing synced payment methods for the template
  var methods = [];
  try {
    var cos = CustomObjectMgr.getAllCustomObjects('MSPPaymentMethod');
    while (cos.hasNext()) {
      var co = cos.next();
      methods.push({
        gatewayId: co.custom.gatewayId,
        name: co.custom.name,
        iconUrl: co.custom.iconUrl || '',
        enabled: co.custom.enabled !== false,
        requiresComponent: co.custom.requiresComponent === true,
        sortOrder: co.custom.sortOrder || 0,
        countries: co.custom.countries || '',
        // Surface the MSP amount/currency restrictions in the BM so the
        // merchant can see them (read defensively when metadata is imported).
        // String(): a custom string attribute is a Java String object.
        currencies: String(readCustom(co, 'currencies', '')),
        minAmount: readCustom(co, 'minAmount', 0) || 0,
        maxAmount: readCustom(co, 'maxAmount', 0) || 0,
        supportsCapture: readCustom(co, 'supportsCapture', false) === true
      });
    }
    cos.close();
    methods.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  } catch (e) {
    Logger.error('[Settings] Error loading payment methods: {0}', e.message);
  }

  // Resolve the Group Card Methods preference here (guarded) instead of in an
  // <isscript> in the template — inline template scripting on this BM page was
  // interfering with the new Business Manager page initialization.
  var groupCardsEnabled = false;
  try {
    groupCardsEnabled = currentSite.getCustomPreferenceValue('Multisafepay_GroupCards') === true;
  } catch (prefErr) {
    Logger.warn('[Settings] Multisafepay_GroupCards not available (metadata not imported?): {0}', prefErr.message);
  }

  res.render('multisafepaySettings/settings', { paymentMethods: methods, groupCardsEnabled: groupCardsEnabled });
  return next();
});

function setCustomPreference(field, value) {
  var customPreference = null;
  if (currentSite) {
    currentSite.setCustomPreferenceValue(field, value);
    customPreference = currentSite.getCustomPreferenceValue(field);
  }
  return customPreference;
}
server.post('Save', server.middleware.https, function (req, res, next) {
  var Logger = require('dw/system/Logger');
  Logger.debug('MultisafepaySettings-Save called');
  try {
    var requestBody = JSON.parse(req.body);
    requestBody.settings.forEach(function (setting) {
      Transaction.wrap(function () {
        setCustomPreference(setting.key, setting.value);
      });
    });
    res.json({
      success: true
    });
  } catch (error) {
    res.json({
      success: false
    });
  }
  return next();
});

server.post('RefundOrder', server.middleware.https, function (req, res, next) {
  var amount = JSON.parse(req.body).amount;
  var orderNumber = JSON.parse(req.body).orderNumber;
  var currencyCode = JSON.parse(req.body).currencyCode;
  var invoiceNo = JSON.parse(req.body).invoiceNo;
  var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
  var refundOrderResult = multisafepayHelper.refundOrder(clientKey, amount, orderNumber, currencyCode, invoiceNo);
  res.json({
    success: refundOrderResult.success,
    data: refundOrderResult.data
  });
  return next();
});

server.post('CaptureOrder', server.middleware.https, function (req, res, next) {
  var requestBody = JSON.parse(req.body);
  var orderNumber = requestBody.orderNumber;
  var amount = requestBody.amount;
  var currencyCode = requestBody.currencyCode;
  var clientKey = multisafepayHelper.getActiveApiKey(currentSite);

  Logger.info('[CaptureOrder] Starting capture for order {0}, amount={1}, currency={2}', orderNumber, amount, currencyCode);
  var captureResult = multisafepayHelper.captureOrder(clientKey, orderNumber, amount, currencyCode);
  Logger.info('[CaptureOrder] Result: success={0}', captureResult.success);
  Logger.debug('[CaptureOrder] Response: {0}', JSON.stringify(captureResult.data));

  var capturedAt = '';

  // If capture succeeded, store the timestamp on the order
  if (captureResult.success) {
    capturedAt = new Date().toISOString();
    try {
      var OrderMgr = require('dw/order/OrderMgr');
      var order = OrderMgr.getOrder(orderNumber);
      Logger.info('[CaptureOrder] Order found: {0}', !!order);
      if (order) {
        var paymentInstruments = order.getPaymentInstruments('MultiSafepayPayment');
        Logger.info('[CaptureOrder] PaymentInstruments count: {0}', paymentInstruments.length);
        if (paymentInstruments.length > 0) {
          var pi = paymentInstruments[0];
          Transaction.wrap(function () {
            pi.paymentTransaction.custom.Multisafepay_CapturedAt = capturedAt;
          });
          Logger.info('[CaptureOrder] CapturedAt saved: {0}', capturedAt);
        }
      }
    } catch (e) {
      Logger.error('[CaptureOrder] Failed to save capture timestamp: {0} - {1}', e.message, e.stack);
    }
  }

  res.json({
    success: captureResult.success,
    data: captureResult.data,
    capturedAt: capturedAt
  });
  return next();
});

/**
 * SyncPaymentMethods — Fetches the merchant's full payment-method catalogue from
 * MSP in a single call, stores it as Custom Objects (including the API-reported
 * country/currency/amount restrictions) and triggers the payment-methods import job.
 */
server.post('SyncPaymentMethods', server.middleware.https, function (req, res, next) {
  try {
    var clientKey = multisafepayHelper.getActiveApiKey(currentSite);

    if (!clientKey) {
      var envLabel = (currentSite.getCustomPreferenceValue('Multisafepay_Environment') || 'test').toUpperCase();
      var missingPref = envLabel === 'LIVE' ? 'Multisafepay_LiveApiKey' : 'Multisafepay_TestApiKey';
      Logger.error('[SyncPaymentMethods] API key not configured for {0} environment ({1}).', envLabel, missingPref);
      res.json({ success: false, errorMessage: 'No API key configured for the ' + envLabel + ' environment. Please set ' + missingPref + ' in Site Preferences.' });
      return next();
    }

    // ONE call to /payment-methods with no `country`/`currency` filter. MSP then
    // returns the merchant's whole catalogue, each entry carrying its own
    // `allowed_countries` / `allowed_currencies`.
    //
    // Semantics (as documented by MultiSafepay):
    //   allowed_countries: []        -> available in EVERY country (no restriction)
    //   allowed_countries: ['NL',..] -> restricted to exactly those countries
    //
    // The previous implementation probed one country at a time with a hardcoded
    // currency=EUR and rebuilt the country list from which probes happened to
    // return the method. That inferred list was both incomplete (non-EUR markets
    // could never be discovered) and wrong (methods with NO restriction ended up
    // pinned to the probe list, e.g. Mastercard losing NL), which is exactly why
    // roughly half of the catalogue disappeared from checkout.
    var DTO = {
      apiToken: clientKey
      // country/currency/locale intentionally omitted — see helper.
    };
    var payments = multisafepayHelper.getApplicablePaymentMethods(DTO);

    if (payments && payments.error) {
      if (payments.statusCode === 401 || payments.statusCode === 403) {
        Logger.error('[SyncPaymentMethods] Authentication failed ({0}). Check your API key.', payments.statusCode);
        res.json({ success: false, errorMessage: 'Authentication failed (' + payments.statusCode + '). Please verify your MSP API key in Site Preferences.' });
        return next();
      }
      Logger.error('[SyncPaymentMethods] MSP API error: {0}', payments.error_info);
      res.json({ success: false, errorMessage: 'The MultiSafepay API returned an error: ' + payments.error_info });
      return next();
    }

    var allMethods = {}; // {gatewayId: <mapApiPaymentMethod shape>}

    if (payments && payments.data) {
      for (var pi = 0; pi < payments.data.length; pi++) {
        // The API contract (allowed_countries semantics, component flags,
        // manual-capture gating, cents->major conversion) lives in one place:
        // multisafepayHelper.mapApiPaymentMethod. See its JSDoc.
        var mapped = multisafepayHelper.mapApiPaymentMethod(payments.data[pi]);
        if (mapped && !allMethods[mapped.gatewayId]) {
          allMethods[mapped.gatewayId] = mapped;
        }
      }
    }

    if (Object.keys(allMethods).length === 0) {
      Logger.error('[SyncPaymentMethods] MSP returned an empty catalogue. Aborting to prevent clearing existing methods.');
      res.json({ success: false, errorMessage: 'No payment methods could be retrieved from the MSP API. Check your API key and that payment methods are active on your MultiSafepay account.' });
      return next();
    }

    var synced = [];
    var sortIndex = 0;
    var restrictionAttrsWarned = false;

    Transaction.wrap(function () {
      // Create/update methods
      var gatewayIds = Object.keys(allMethods);
      for (var i = 0; i < gatewayIds.length; i++) {
        var gatewayId = gatewayIds[i];
        var info = allMethods[gatewayId];
        var countriesStr = info.countries || '';

        var co = CustomObjectMgr.getCustomObject('MSPPaymentMethod', gatewayId);
        if (!co) {
          co = CustomObjectMgr.createCustomObject('MSPPaymentMethod', gatewayId);
          co.custom.enabled = true;
          co.custom.sortOrder = sortIndex;
        }

        co.custom.name = info.name;
        co.custom.iconUrl = info.iconUrl;
        co.custom.requiresComponent = info.requiresComponent;
        co.custom.countries = countriesStr;
        // Restriction/capture attributes. Each is written on its own, so an
        // un-imported attribute is skipped without aborting the core sync.
        var restrictionsStored = setCustom(co, 'currencies', info.currencies || '');
        restrictionsStored = setCustom(co, 'minAmount', info.minAmount || 0) && restrictionsStored;
        restrictionsStored = setCustom(co, 'maxAmount', info.maxAmount || 0) && restrictionsStored;
        restrictionsStored = setCustom(co, 'supportsCapture', info.supportsCapture === true) && restrictionsStored;
        if (!restrictionsStored && !restrictionAttrsWarned) {
          restrictionAttrsWarned = true;
          Logger.warn('[SyncPaymentMethods] MSPPaymentMethod metadata is missing the restriction/capture attributes (currencies, minAmount, maxAmount, supportsCapture). Import metadata/site-import to enable them. Core sync proceeds without them.');
        }

        synced.push({
          gatewayId: gatewayId,
          name: info.name,
          iconUrl: info.iconUrl,
          enabled: co.custom.enabled !== false,
          requiresComponent: co.custom.requiresComponent,
          sortOrder: co.custom.sortOrder || sortIndex,
          countries: countriesStr
        });
        sortIndex++;
      }

      // Disable methods no longer present in the MSP catalogue
      var allCos = CustomObjectMgr.getAllCustomObjects('MSPPaymentMethod');
      while (allCos.hasNext()) {
        var existingCo = allCos.next();
        var existingId = existingCo.custom.gatewayId;
        if (!allMethods[existingId] && existingCo.custom.enabled !== false) {
          existingCo.custom.enabled = false;
          existingCo.custom.countries = '';
          Logger.info('[SyncPaymentMethods] Disabled removed method: {0}', existingId);
        }
      }
      allCos.close();
    });

    synced.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    Logger.info('[SyncPaymentMethods] Synced {0} methods (country availability read from allowed_countries)', synced.length);

    // Auto-import: generate XML and trigger job
    var importResult = { success: false, message: '' };
    var xmlOk = generatePaymentMethodsXML(synced);
    if (xmlOk) {
      importResult = triggerImportJob();
    } else {
      importResult.message = 'XML generation failed.';
    }

    res.json({
      success: true,
      methods: synced,
      importResult: importResult
    });
  } catch (e) {
    Logger.error('[SyncPaymentMethods] Error: {0}', e.message);
    res.json({ success: false, errorMessage: e.message });
  }
  return next();
});

/**
 * TogglePaymentMethod — Enables or disables a specific MSP payment method.
 */
server.post('TogglePaymentMethod', server.middleware.https, function (req, res, next) {
  try {
    var requestBody = JSON.parse(req.body);
    var gatewayId = requestBody.gatewayId;
    var enabled = requestBody.enabled;

    var co = CustomObjectMgr.getCustomObject('MSPPaymentMethod', gatewayId);
    if (!co) {
      res.json({ success: false, errorMessage: 'Payment method not found: ' + gatewayId });
      return next();
    }

    Transaction.wrap(function () {
      co.custom.enabled = enabled;
    });

    Logger.info('[TogglePaymentMethod] {0} set to {1}', gatewayId, enabled ? 'enabled' : 'disabled');

    // Reflect the enable/disable in Ordering > Payment Methods immediately
    // by regenerating the XML and re-triggering the import job, so the two panels
    // cannot drift out of sync. Non-fatal if OCAPI import is not configured — the
    // Custom Object (single source of truth for checkout) is already updated.
    var toggleMethods = [];
    var toggleCos = CustomObjectMgr.getAllCustomObjects('MSPPaymentMethod');
    while (toggleCos.hasNext()) {
      var tco = toggleCos.next();
      toggleMethods.push({
        gatewayId: tco.custom.gatewayId,
        name: tco.custom.name || tco.custom.gatewayId,
        enabled: tco.custom.enabled !== false,
        countries: tco.custom.countries || ''
      });
    }
    toggleCos.close();

    var toggleImport = { success: false, message: 'Import not triggered.' };
    if (generatePaymentMethodsXML(toggleMethods)) {
      toggleImport = triggerImportJob();
    }

    res.json({ success: true, importResult: toggleImport });
  } catch (e) {
    Logger.error('[TogglePaymentMethod] Error: {0}', e.message);
    res.json({ success: false, errorMessage: e.message });
  }
  return next();
});

/**
 * ImportPaymentMethods — Generates XML and triggers the import job via OCAPI.
 */
server.post('ImportPaymentMethods', server.middleware.https, function (req, res, next) {
  try {
    // Load all Custom Objects
    var methods = [];
    var cos = CustomObjectMgr.getAllCustomObjects('MSPPaymentMethod');
    while (cos.hasNext()) {
      var co = cos.next();
      methods.push({
        gatewayId: co.custom.gatewayId,
        name: co.custom.name || co.custom.gatewayId,
        enabled: co.custom.enabled !== false,
        countries: co.custom.countries || ''
      });
    }
    cos.close();

    if (methods.length === 0) {
      res.json({ success: false, errorMessage: 'No payment methods to import. Run Sync first.' });
      return next();
    }

    // Step 1: Generate the XML file
    var xmlOk = generatePaymentMethodsXML(methods);
    if (!xmlOk) {
      res.json({ success: false, errorMessage: 'Failed to generate XML file.' });
      return next();
    }

    // Step 2: Trigger the import job
    var result = triggerImportJob();
    res.json({
      success: result.success,
      message: result.message
    });
  } catch (e) {
    Logger.error('[ImportPaymentMethods] Error: {0}', e.message);
    res.json({ success: false, errorMessage: e.message });
  }
  return next();
});

module.exports = server.exports();