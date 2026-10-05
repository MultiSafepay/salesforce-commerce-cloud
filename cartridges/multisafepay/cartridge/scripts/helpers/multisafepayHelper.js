"use strict";

var apiConfig = require('*/cartridge/config/apiConfig');
var HashMap = require('dw/util/HashMap');
var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');

// NOTE: manual-capture support and the inline Payment Component decision are both
// taken from the live /payment-methods response (manual_capture.supported and
// apps.payment_components.has_fields && is_enabled respectively) and persisted on
// the MSPPaymentMethod Custom Objects at sync time — there is no hardcoded gateway
// list here (items 5 & 12).

var service;
var serviceCallback = {
    parseResponse: function (svc, client) {
        if (client.text) {
            return JSON.parse(client.text);
        }
        return client;
    },
    createRequest: function (svc, args) {
        if (args) {
            return args;
        }
        return null;
    },
};

function getCustomPreference(field,currentSite) {
  var customPreference = null;
  // getCustomPreferenceValue throws for an attribute whose DEFINITION is not
  // present in the instance metadata. Guard it so that deploying the code before
  // (re-)importing the metadata degrades gracefully (feature off) instead of
  // breaking payment-method sync/checkout. See "deploy prerequisites".
  try {
    if (currentSite && currentSite.getCustomPreferenceValue(field)) {
      customPreference = currentSite.getCustomPreferenceValue(field);
    }
  } catch (e) {
    Logger.warn('[getCustomPreference] Preference "{0}" not available (metadata not imported?): {1}', field, e.message);
  }
  return customPreference;
}

/**
 * Returns the MSP API base URL for the currently configured environment.
 * Test: https://testapi.multisafepay.com/v1/json/
 * Live: https://api.multisafepay.com/v1/json/
 * @returns {string} base URL (always ends with /)
 */
function getApiBaseUrl() {
    var dwsystem = require('dw/system');
    var site = dwsystem.Site.getCurrent();
    var environment = getCustomPreference('Multisafepay_Environment', site);
    // Case-insensitive: the stored preference value casing is inconsistent across
    // the codebase (templates compare 'TEST', this helper historically 'live').
    return String(environment).toLowerCase() === 'live'
        ? 'https://api.multisafepay.com/v1/json/'
        : 'https://testapi.multisafepay.com/v1/json/';
}

/**
 * Returns the active API key based on the configured environment (test/live).
 * Falls back to legacy Multisafepay_ClientKey if new keys are not configured.
 * @param {dw.system.Site} site - the current site
 * @returns {string|null} the active API key
 */
function getActiveApiKey(site) {
    var environment = getCustomPreference('Multisafepay_Environment', site);

    if (String(environment).toLowerCase() === 'live') {
        // Prefer the dedicated live key; fall back to the legacy single ClientKey
        // for merchants that configured live mode before LiveApiKey existed.
        // Never fall back to the test key in live mode.
        var liveKey = getCustomPreference('Multisafepay_LiveApiKey', site);
        if (!liveKey) {
            liveKey = getCustomPreference('Multisafepay_ClientKey', site);
            if (!liveKey) {
                Logger.error('[getActiveApiKey] Live environment selected but neither Multisafepay_LiveApiKey nor Multisafepay_ClientKey is configured.');
            }
        }
        return liveKey;
    }

    // Test environment: prefer new dedicated test key, fall back to legacy single key.
    var testKey = getCustomPreference('Multisafepay_TestApiKey', site);
    if (!testKey) {
        testKey = getCustomPreference('Multisafepay_ClientKey', site);
    }
    return testKey;
}

function getApplicablePaymentMethods(DTO) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.getApplicablePaymentMethods, serviceCallback);
    // Use the rich 'payment-methods' endpoint (returns name, icon_urls,
    // payment_components). The legacy 'gateways' endpoint only returns
    // id + description, which left CO name/iconUrl undefined after eabb4c5.
    var endpoint = getApiBaseUrl() + 'payment-methods';
    // REQ-1.1.4 / REQ-1.3.1 / REQ-2.1.1: `country` and `currency` are OPTIONAL.
    // When omitted, MSP returns the merchant's full catalogue together with each
    // method's own `allowed_countries` / `allowed_currencies`, which is the
    // authoritative restriction data. The sync deliberately omits them so no
    // method is silently dropped from the catalogue (the previous per-country
    // probe with a fixed currency=EUR could never discover non-EUR markets and
    // inferred wrong country lists). Callers that genuinely want a pre-filtered
    // list (not the sync) may still pass them.
    var separator = '?';
    if (DTO.country) {
        endpoint += separator + 'country=' + DTO.country;
        separator = '&';
    }
    if (DTO.currency) {
        endpoint += separator + 'currency=' + DTO.currency;
        separator = '&';
    }
    if (DTO.locale) {
        endpoint += separator + 'locale=' + DTO.locale;
        separator = '&';
    }
    // group_cards is driven by the Merchant Tools > Site Preferences >
    // MultiSafepay Settings > "Group Card Methods" toggle (item 2).
    //  - true  (1): card schemes are bundled into a single "Credit Card" method
    //  - false (0): each card scheme (VISA, MASTERCARD, AMEX, MAESTRO) is a
    //               separate method with its own name/icon.
    // DTO.groupCards is resolved by the caller; when unset, fall back to the
    // Multisafepay_GroupCards Site Preference so every call site stays consistent.
    var groupCardsPref = DTO.groupCards;
    if (groupCardsPref === undefined || groupCardsPref === null) {
        var dwsystemGC = require('dw/system');
        groupCardsPref = getCustomPreference('Multisafepay_GroupCards', dwsystemGC.Site.getCurrent());
    }
    var groupCards = groupCardsPref === true || groupCardsPref === 1 || groupCardsPref === '1' ? '1' : '0';
    endpoint += separator + 'group_cards=' + groupCards;
    separator = '&';
    // include_coupons=1 makes the endpoint also return available gift cards /
    // coupon methods so they can be shown at checkout (item 14).
    endpoint += separator + 'include_coupons=1';

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer '+ DTO.apiToken);
    var result;

    Logger.info('[GetPaymentMethods] GET {0}', endpoint);
    httpSvc.open( "GET", endpoint,
        false,
        null,
        null );
    httpSvc.send();

    if (httpSvc.statusCode == 200){
        result = JSON.parse(httpSvc.text);
        Logger.info('[GetPaymentMethods] Response 200 - {0} methods returned', result.data ? result.data.length : 0);
    }else{
        var errorText = '';
        try { errorText = JSON.parse(httpSvc.errorText).error_info || httpSvc.errorText; } catch (e) { errorText = httpSvc.errorText; }
        Logger.error('[GetPaymentMethods] Error {0}: {1}', httpSvc.statusCode, errorText);
        result = { error: true, statusCode: httpSvc.statusCode, error_info: errorText };
    }

    return result;
}

function createOrder(apiToken, transactionData) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.createOrder, serviceCallback);
    var endpoint = getApiBaseUrl() + 'orders';
    var result

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer '+ apiToken);

    var requestBody = JSON.stringify(transactionData.transactionData, null, 2);
    Logger.info('[CreateOrder] POST {0}', endpoint);
    Logger.info('[CreateOrder] Request payload:\n{0}', requestBody);
    httpSvc.open( "POST", endpoint, false, null, null);
    httpSvc.setRequestHeader('Content-Type', 'application/json')
    httpSvc.send(requestBody);
    if (httpSvc.statusCode == 200){
        result = { success: true, data: JSON.parse(httpSvc.text) };
        Logger.info('[CreateOrder] Response 200 - order_id: {0}, payment_url: {1}',
            result.data.data ? result.data.data.order_id : 'N/A',
            result.data.data ? result.data.data.payment_url : 'N/A');
    }else {
        var errorInfo = 'Unknown error (HTTP ' + httpSvc.statusCode + ')';
        try {
            var errorBody = JSON.parse(httpSvc.errorText);
            errorInfo = errorBody.error_info || JSON.stringify(errorBody);
        } catch (parseErr) {
            errorInfo = httpSvc.errorText || errorInfo;
        }
        Logger.error('[CreateOrder] Error {0}: {1}', httpSvc.statusCode, errorInfo);
        result = { success: false, statusMessage: errorInfo };
    }

    return result;
}

function calculateTransaction(transactionData, map){
    if(map.get(transactionData)){
        map.put(transactionData, map.get(transactionData)+1);
    }else{
        map.put(transactionData, 1);
    }
    return map;
}

function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

function Last7Days () {
    var result = [];
    for (var i=0; i<7; i++) {
        var d = new Date();
        d.setDate(d.getDate() - i);
        // Zero-padded ISO date (YYYY-MM-DD) so keys match the transaction
        // dates derived from `created.split('T')[0]` (item 15). Without padding,
        // single-digit months/days (e.g. 2026-7-8) never matched the ISO keys
        // (2026-07-08), leaving the dashboard charts empty.
        result.push(d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()));
    }
    result.reverse();
    return result;
}

/**
 * Fetches MSP transactions with defensive pagination (item 15 / QA point 4).
 *
 * The live account can process several transactions per minute, so a single page
 * would undercount the dashboard. This loops over pages accumulating rows.
 *
 * IMPORTANT: the exact pagination parameters for `GET /transactions` must be
 * confirmed against the MSP API — `limit`/`offset` are used here. Content-based
 * de-duplication makes a wrong guess safe: if the endpoint ignores the params and
 * keeps returning the same page, no new rows are added and the loop stops (no
 * double-counting, degrades to single-page behaviour). `MAX_PAGES` is a hard cap.
 *
 * @param {string} apiToken - MSP API key
 * @returns {Array} combined, de-duplicated transaction rows
 */
function fetchTransactionsPaginated(apiToken) {
    var HTTPClient = require('dw/net/HTTPClient');
    var baseEndpoint = getApiBaseUrl() + 'transactions';
    var all = [];
    var seen = {};
    var PAGE_SIZE = 100;
    var MAX_PAGES = 200; // hard safety cap (~20k rows)

    for (var page = 1; page <= MAX_PAGES; page++) {
        var offset = (page - 1) * PAGE_SIZE;
        var endpoint = baseEndpoint + '?limit=' + PAGE_SIZE + '&offset=' + offset;
        var httpSvc = new HTTPClient();
        httpSvc.setRequestHeader('Authorization', 'Bearer ' + apiToken);
        httpSvc.open('GET', endpoint, false, null, null);
        httpSvc.send();

        if (httpSvc.statusCode != 200) {
            Logger.error('[GetAllTransactions] Page {0} error {1}: {2}', page, httpSvc.statusCode, httpSvc.errorText);
            break;
        }

        var body = JSON.parse(httpSvc.text);
        var pageData = (body && body.data) ? body.data : body;
        if (!pageData || !pageData.length) {
            break;
        }

        var newCount = 0;
        for (var i = 0; i < pageData.length; i++) {
            var tx = pageData[i];
            var dedupId = tx.transaction_id || tx.order_id
                || (String(tx.type) + '|' + String(tx.created) + '|' + String(tx.amount) + '|' + String(tx.psp_id || tx.description || i));
            if (seen[dedupId]) {
                continue;
            }
            seen[dedupId] = true;
            all.push(tx);
            newCount++;
        }
        Logger.info('[GetAllTransactions] Page {0}: {1} rows ({2} new), total {3}', page, pageData.length, newCount, all.length);

        // Stop on the last page, or when the endpoint ignored pagination (no new rows).
        if (newCount === 0 || pageData.length < PAGE_SIZE) {
            break;
        }
    }
    return all;
}

function getAllTransactions(apiToken) {
    var transactions = fetchTransactionsPaginated(apiToken);

    var result = {
        todayTransactions: 0,
        totalTransactions: 0,
        todayRefunds: 0,
        totalRefunds: 0,
        transactionsChart: [],
        refundChart: []
    };

    var today = new Date();
    var todayString = today.toISOString().split('T')[0];
    // Count maps drive the KPI cards; amount maps drive the Revenue/Returns
    // charts. MSP amounts are in minor units (cents) → divide by 100.
    var mapTransactions = new HashMap(); // date -> payment count
    var mapRefund = new HashMap();       // date -> refund count
    var mapRevenue = new HashMap();      // date -> revenue amount
    var mapRefundAmount = new HashMap(); // date -> refunded amount
    for (var i = 0, l = transactions.length; i < l; i++) {
        var tx = transactions[i];
        var txDay = tx.created ? tx.created.split('T')[0] : null;
        if (!txDay) { continue; }
        var txAmount = Math.abs(Number(tx.amount) || 0) / 100;
        if (tx.type == 'payment') {
            result.totalTransactions++;
            mapTransactions = calculateTransaction(txDay, mapTransactions);
            mapRevenue.put(txDay, (mapRevenue.get(txDay) || 0) + txAmount);
        }
        if (tx.type == 'refund') {
            result.totalRefunds++;
            mapRefund = calculateTransaction(txDay, mapRefund);
            mapRefundAmount.put(txDay, (mapRefundAmount.get(txDay) || 0) + txAmount);
        }
    }
    result.totalTransactions = JSON.stringify(result.totalTransactions);
    result.todayTransactions = JSON.stringify(mapTransactions.get(todayString)? mapTransactions.get(todayString) : 0);
    result.todayRefunds = JSON.stringify(mapRefund.get(todayString)? mapRefund.get(todayString) : 0);
    result.totalRefunds = JSON.stringify(result.totalRefunds);
    var last7Days = Last7Days();
    for (var d = 0; d < last7Days.length; d++) {
        // Round revenue/refund to 2 decimals for a clean chart axis.
        var rev = mapRevenue.get(last7Days[d]) ? Math.round(mapRevenue.get(last7Days[d]) * 100) / 100 : 0;
        result.transactionsChart.push(rev);
        var refAmt = mapRefundAmount.get(last7Days[d]) ? Math.round(mapRefundAmount.get(last7Days[d]) * 100) / 100 : 0;
        result.refundChart.push(refAmt);
    }
    result.transactionsChart = JSON.stringify(result.transactionsChart);
    result.refundChart = JSON.stringify(result.refundChart);

    return result;
}

function refundOrder(apiToken, amount, orderNumber, currencyCode, invoiceNo) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.refundOrder, serviceCallback);
    var endpoint = getApiBaseUrl() + 'orders/' + encodeURIComponent(orderNumber) + '/refunds';
    var result;

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer '+ apiToken);

    var refundBody = JSON.stringify({
        amount: Math.round(amount * 100),
        currency: currencyCode
    });
    Logger.info('[RefundOrder] POST {0}', endpoint);
    Logger.info('[RefundOrder] Request: {0}', refundBody);
    httpSvc.open( "POST", endpoint,
        false,
        null,
        null );
    httpSvc.setRequestHeader('Content-Type', 'application/json');
    httpSvc.send(refundBody);

    if (httpSvc.statusCode == 200){
        result = { success: true, data: JSON.parse(httpSvc.text) };
        Logger.info('[RefundOrder] Response 200 - success');
    }else {
        Logger.error('[RefundOrder] Error {0}: {1}', httpSvc.statusCode, httpSvc.errorText);
        result = { success: false, data: JSON.parse(httpSvc.errorText).error_info };
    }

    return result;
}

function getOrderStatus(apiToken, orderNumber) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.createOrder, serviceCallback);
    var endpoint = getApiBaseUrl() + 'orders/' + encodeURIComponent(orderNumber);

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer ' + apiToken);

    Logger.info('[GetOrderStatus] GET {0}', endpoint);
    httpSvc.open('GET', endpoint, false, null, null);
    httpSvc.send();

    if (httpSvc.statusCode == 200) {
        var result = JSON.parse(httpSvc.text);
        Logger.info('[GetOrderStatus] Response 200 - status: {0}', result.data ? result.data.status : 'N/A');
        return { success: true, data: result.data };
    }

    Logger.error('[GetOrderStatus] Error {0}: {1}', httpSvc.statusCode, httpSvc.errorText);
    return { success: false };
}

/**
 * Marks an MSP order as shipped. For BNPL methods (Riverty/Klarna/Billink/in3)
 * this is what triggers the financial-status change (invoice/capture) on the MSP
 * side.
 *
 * REQ-2.1.6: MultiSafepay exposes order updates as **PATCH** /orders/{order_id}.
 * The previous implementation used POST. Verified against the live test API:
 *   PATCH /orders/<unknown-id>  -> 404 "Invalid transaction ID"  (verb accepted)
 *   POST  /orders/<unknown-id>  -> 405 "Method not allowed"      (verb rejected)
 * so the old call could never take effect, which is why the scheduled job
 * appeared to do nothing while still reporting a successful run.
 *
 * Optional fields (tracktrace_code, carrier, ship_date) are omitted when empty:
 * MSP rejects empty strings for them.
 *
 * @param {string} apiToken - MSP API key
 * @param {string} orderNumber - the SFCC order number (= MSP order_id)
 * @param {Object} shipmentData - optional {tracktrace_code, carrier, ship_date}
 * @returns {Object} result with success flag and data
 */
function updateOrderShipped(apiToken, orderNumber, shipmentData) {
    var HTTPClient = require('dw/net/HTTPClient');
    var endpoint = getApiBaseUrl() + 'orders/' + encodeURIComponent(orderNumber);

    var body = { status: 'shipped' };
    var data = shipmentData || {};
    if (data.tracktrace_code) { body.tracktrace_code = data.tracktrace_code; }
    if (data.carrier) { body.carrier = data.carrier; }
    if (data.ship_date) { body.ship_date = data.ship_date; }
    var payload = JSON.stringify(body);

    var svc = new HTTPClient();
    svc.setRequestHeader('Authorization', 'Bearer ' + apiToken);
    svc.open('PATCH', endpoint, false, null, null);
    svc.setRequestHeader('Content-Type', 'application/json');
    Logger.info('[UpdateOrderShipped] PATCH {0} - {1}', endpoint, payload);
    svc.send(payload);

    if (svc.statusCode === 200) {
        var responseData = JSON.parse(svc.text);
        if (responseData.success === false) {
            Logger.error('[UpdateOrderShipped] MSP error for order {0}: {1}', orderNumber, responseData.error_info);
            return { success: false, data: responseData.error_info };
        }
        Logger.info('[UpdateOrderShipped] Order {0} marked shipped on MSP', orderNumber);
        return { success: true, data: responseData };
    }

    var errText;
    try { errText = JSON.parse(svc.errorText).error_info || svc.errorText; } catch (e) { errText = svc.errorText; }
    Logger.error('[UpdateOrderShipped] Order {0} failed - HTTP {1}: {2}', orderNumber, svc.statusCode, errText);
    return { success: false, data: 'HTTP ' + svc.statusCode + ': ' + errText };
}

/**
 * Captures a previously authorized (manual capture) order on MultiSafepay.
 * @param {string} apiToken - MSP API key
 * @param {string} orderNumber - the order number
 * @param {number} amount - the amount to capture in major currency units
 * @param {string} currencyCode - ISO currency code
 * @returns {Object} result with success flag and data
 */
function captureOrder(apiToken, orderNumber, amount, currencyCode) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.captureOrder, serviceCallback);
    var endpoint = getApiBaseUrl() + 'orders/' + encodeURIComponent(orderNumber) + '/capture';
    var result;

    // If no amount provided, get it from the order
    if (!amount) {
        var OrderMgr = require('dw/order/OrderMgr');
        var order = OrderMgr.getOrder(orderNumber);
        if (order) {
            amount = order.totalGrossPrice.value;
        }
    }

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer ' + apiToken);

    var captureBody = JSON.stringify({
        amount: Math.round(amount * 100),
        new_order_status: 'completed'
    });
    Logger.info('[CaptureOrder] POST {0}', endpoint);
    Logger.info('[CaptureOrder] Request: {0}', captureBody);
    httpSvc.open('POST', endpoint, false, null, null);
    httpSvc.setRequestHeader('Content-Type', 'application/json');
    httpSvc.send(captureBody);

    if (httpSvc.statusCode == 200) {
        var responseData = JSON.parse(httpSvc.text);
        if (responseData.success === false) {
            Logger.error('[CaptureOrder] MSP error {0}: {1}', responseData.error_code, responseData.error_info);
            result = { success: false, data: responseData.error_info };
        } else {
            Logger.info('[CaptureOrder] Response 200 - capture successful');
            result = { success: true, data: responseData };
        }
    } else {
        Logger.error('[CaptureOrder] Error {0}: {1}', httpSvc.statusCode, httpSvc.errorText);
        result = { success: false, data: JSON.parse(httpSvc.errorText).error_info };
    }

    return result;
}

/**
 * Generates a short-lived API token for use with the MSP Payment Component on the frontend.
 * Tokens are valid for 600 seconds.
 * @param {string} apiKey - the MSP API key
 * @returns {Object} result with success flag and api_token
 */
function generateApiToken(apiKey) {
    var LocalServiceRegistry = require('dw/svc/LocalServiceRegistry');
    service = LocalServiceRegistry.createService(apiConfig.generateApiToken, serviceCallback);
    var endpoint = getApiBaseUrl() + 'auth/api_token';

    var HTTPClient = require('dw/net/HTTPClient');
    var httpSvc = new HTTPClient();
    httpSvc.setRequestHeader('Authorization', 'Bearer ' + apiKey);

    Logger.info('[GenerateApiToken] GET {0}', endpoint);
    httpSvc.open('GET', endpoint, false, null, null);
    httpSvc.send();

    if (httpSvc.statusCode == 200) {
        var result = JSON.parse(httpSvc.text);
        Logger.info('[GenerateApiToken] Response 200 - token generated');
        return { success: true, apiToken: result.data.api_token, statusCode: 200 };
    }

    Logger.error('[GenerateApiToken] Error {0}: {1}', httpSvc.statusCode, httpSvc.errorText);
    // statusCode lets callers distinguish an invalid API key (401/403) from a
    // transient error (network / 5xx) so only the former blocks checkout (item 7).
    return { success: false, statusCode: httpSvc.statusCode, invalidKey: httpSvc.statusCode === 401 || httpSvc.statusCode === 403 };
}

/**
 * Returns true when the object's type defines the given custom attribute.
 * Avoids "Unknown dynamic property" errors when the metadata has not been
 * imported yet. Never throws.
 * @param {dw.object.ExtensibleObject} extObj - object to inspect
 * @param {string} attrId - custom attribute id
 * @returns {boolean} whether the attribute is defined
 */
function objectDefines(extObj, attrId) {
    try {
        var def = extObj.describe();
        return !!(def && def.getCustomAttributeDefinition(attrId));
    } catch (e) {
        return false;
    }
}

/**
 * Maps one entry of the MSP /payment-methods response onto the flat shape stored
 * on the MSPPaymentMethod Custom Object.
 *
 * This is the single place where the MSP API contract is interpreted, so the
 * rules below hold identically for the BM sync, the checkout filter and the
 * tests:
 *
 *  - countries   `allowed_countries: []` (or absent) means NO country
 *                restriction and maps to an EMPTY string. A non-empty list maps
 *                to its upper-cased CSV. (REQ-1.1.4 — the previous per-country
 *                probe inferred this list instead of reading it, which pinned
 *                unrestricted methods to an arbitrary set of countries.)
 *  - currencies  `allowed_currencies` CSV, empty = no restriction.
 *  - min/max     `allowed_amount.min|max` are in CENTS; converted to major units.
 *                0 / null mean "no bound".
 *  - component   inline Payment Component only when the API reports both
 *                has_fields and is_enabled (either at the top level or under
 *                `apps`, depending on the API shape).
 *  - capture     manual capture requires BOTH `supported` (the method can do it)
 *                AND `is_enabled` (the merchant's MSP account has it switched
 *                on) — REQ-2.2.1.
 *
 * @param {Object} apiMethod - one entry of the MSP /payment-methods `data` array
 * @returns {Object|null} the Custom Object shape, or null when the entry has no id
 */
function mapApiPaymentMethod(apiMethod) {
    if (!apiMethod || !apiMethod.id) {
        return null;
    }

    var pc = apiMethod.payment_components
        || (apiMethod.apps && apiMethod.apps.payment_components)
        || {};
    var requiresComponent = pc.is_enabled === true && pc.has_fields === true;

    var countries = '';
    if (apiMethod.allowed_countries && apiMethod.allowed_countries.length) {
        countries = [].slice.call(apiMethod.allowed_countries)
            .map(function (c) { return String(c).trim().toUpperCase(); })
            .filter(function (c) { return c.length === 2; })
            .join(',');
    }

    var currencies = '';
    var allowedCurrencies = apiMethod.allowed_currencies || apiMethod.currencies;
    if (allowedCurrencies && allowedCurrencies.length) {
        currencies = [].slice.call(allowedCurrencies)
            .map(function (c) { return String(c).trim().toUpperCase(); })
            .join(',');
    }

    var minAmount = 0;
    var maxAmount = 0;
    if (apiMethod.allowed_amount) {
        minAmount = Number(apiMethod.allowed_amount.min) || 0;
        maxAmount = Number(apiMethod.allowed_amount.max) || 0;
    }
    if (minAmount > 0) { minAmount /= 100; }
    if (maxAmount > 0) { maxAmount /= 100; }

    var mc = apiMethod.manual_capture || {};

    return {
        gatewayId: apiMethod.id,
        name: apiMethod.name || apiMethod.description || apiMethod.id,
        iconUrl: (apiMethod.icon_urls && apiMethod.icon_urls.medium) ? apiMethod.icon_urls.medium : '',
        requiresComponent: requiresComponent,
        countries: countries,
        currencies: currencies,
        minAmount: minAmount,
        maxAmount: maxAmount,
        supportsCapture: mc.supported === true && mc.is_enabled === true
    };
}

/**
 * Returns enabled MSP payment methods from Custom Objects, sorted by sortOrder.
 * @returns {Array} array of {gatewayId, name, iconUrl, requiresComponent}
 */
function getEnabledMSPMethods() {
    var CustomObjectMgr = require('dw/object/CustomObjectMgr');
    var methods = [];
    var cos = CustomObjectMgr.getAllCustomObjects('MSPPaymentMethod');
    // Whether the newer restriction/capture attributes exist in the metadata —
    // resolved once from the first CO so a pending metadata import cannot break
    // checkout rendering (reading an undefined attribute would otherwise throw).
    var hasRestrictionAttrs = null;
    while (cos.hasNext()) {
        var co = cos.next();
        if (hasRestrictionAttrs === null) {
            hasRestrictionAttrs = objectDefines(co, 'currencies');
        }
        if (co.custom.enabled !== false) {
            methods.push({
                gatewayId: co.custom.gatewayId,
                name: co.custom.name || co.custom.gatewayId,
                iconUrl: co.custom.iconUrl || '',
                // item 5: the inline component decision comes exclusively from the
                // API flags captured at sync time (payment_components.has_fields &&
                // is_enabled). No hardcoded gateway list.
                requiresComponent: co.custom.requiresComponent === true,
                supportsCapture: hasRestrictionAttrs ? co.custom.supportsCapture === true : false,
                countries: co.custom.countries || '',
                currencies: hasRestrictionAttrs ? (co.custom.currencies || '') : '',
                minAmount: hasRestrictionAttrs ? (co.custom.minAmount || 0) : 0,
                maxAmount: hasRestrictionAttrs ? (co.custom.maxAmount || 0) : 0,
                sortOrder: co.custom.sortOrder || 0
            });
        }
    }
    cos.close();
    methods.sort(function (a, b) { return a.sortOrder - b.sortOrder; });
    return methods;
}

/**
 * Returns the MSP payment methods that must be shown at checkout, applying, in
 * order:
 *   1. enabled MSPPaymentMethod Custom Objects only (disabled = hidden);
 *   2. MSP restriction data captured at sync time — country, currency and
 *      min/max amount (item 4);
 *   3. the SFCC `Ordering > Payment Methods` gate on the matching
 *      `MSP_<gatewayId>` method: dropped if inactive, otherwise kept only if
 *      `isApplicable()` passes (customer group / customer type, country, currency,
 *      amount). A gateway with no imported SFCC method yet is kept so checkout is
 *      not broken during a partial rollout (items 1 & 3).
 *
 * @param {dw.customer.Customer} currentCustomer - the current customer (the ISML
 *        implicit `customer`, a dw.customer.Customer)
 * @param {string} countryCode - ISO 3166-1 alpha-2 country code
 * @param {number} amount - order total in major currency units
 * @param {string} currencyCode - ISO 4217 currency code of the basket
 * @returns {Array} filtered array of {gatewayId, name, iconUrl, requiresComponent, ...}
 */
function getApplicableMSPMethods(currentCustomer, countryCode, amount, currencyCode) {
    var PaymentMgr = require('dw/order/PaymentMgr');
    var coMethods = getEnabledMSPMethods();

    var upperCountry = countryCode ? String(countryCode).toUpperCase() : '';
    var upperCurrency = currencyCode ? String(currencyCode).toUpperCase() : '';
    var numericAmount = typeof amount === 'number' ? amount : parseFloat(amount) || 0;

    // --- Restriction filtering from the synced MSP data (item 4) -------------
    // country, currency and min/max amount are enforced directly from the
    // Custom Object so that a method not meeting the criteria is never shown,
    // regardless of the SFCC Ordering > Payment Methods import state (item 1).
    coMethods = coMethods.filter(function (method) {
        // Country restriction
        if (method.countries) {
            var countryList = method.countries.split(',').map(function (c) { return c.trim().toUpperCase(); });
            if (upperCountry && countryList.indexOf(upperCountry) === -1) {
                return false;
            }
        }
        // Currency restriction
        if (method.currencies) {
            var currencyList = method.currencies.split(',').map(function (c) { return c.trim().toUpperCase(); });
            if (upperCurrency && currencyList.indexOf(upperCurrency) === -1) {
                return false;
            }
        }
        // Minimum / maximum amount restriction (0 = no bound)
        if (method.minAmount && numericAmount > 0 && numericAmount < method.minAmount) {
            return false;
        }
        if (method.maxAmount && method.maxAmount > 0 && numericAmount > method.maxAmount) {
            return false;
        }
        return true;
    });

    // --- SFCC Ordering > Payment Methods gate (items 3 & 4) ------------------
    // For each surviving gateway, consult its SFCC MSP_<gateway> payment method:
    //  - method not imported yet  → keep (partial-rollout safety)
    //  - method exists but inactive → drop (disabled in Ordering > Payment Methods)
    //  - method active            → keep only if isApplicable() passes
    //                               (customer group / customer type, country,
    //                                currency and amount range restrictions).
    // This makes Ordering > Payment Methods a real, respected source of truth.
    return coMethods.filter(function (method) {
        var sfccMethod = PaymentMgr.getPaymentMethod('MSP_' + method.gatewayId);
        if (!sfccMethod) {
            return true;
        }
        if (!sfccMethod.active) {
            return false;
        }
        return sfccMethod.isApplicable(currentCustomer, countryCode, numericAmount);
    });
}

module.exports = {
  getApplicablePaymentMethods: getApplicablePaymentMethods,
  getCustomPreference: getCustomPreference,
  getActiveApiKey: getActiveApiKey,
  getApiBaseUrl: getApiBaseUrl,
  createOrder: createOrder,
  getAllTransactions: getAllTransactions,
  refundOrder: refundOrder,
  captureOrder: captureOrder,
  updateOrderShipped: updateOrderShipped,
  getOrderStatus: getOrderStatus,
  generateApiToken: generateApiToken,
  getEnabledMSPMethods: getEnabledMSPMethods,
  getApplicableMSPMethods: getApplicableMSPMethods,
  mapApiPaymentMethod: mapApiPaymentMethod
};
