'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var HELPER = 'cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js';

/**
 * Loads the helper with a recording HTTPClient stub.
 * @param {Object} [opts] - {environment, responses: [{statusCode, text, errorText}]}
 * @returns {Object} {helper, calls}
 */
function loadHelper(opts) {
    var options = opts || {};
    var responses = options.responses || [{ statusCode: 200, text: '{"success":true}' }];
    var calls = [];
    var callIndex = 0;

    /** Recording dw.net.HTTPClient stub. */
    function HTTPClient() {
        var call = { headers: {}, method: null, url: null, body: null };
        calls.push(call);
        var response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex++;
        this.setRequestHeader = function (name, value) { call.headers[name] = value; };
        this.open = function (method, url) { call.method = method; call.url = url; };
        this.send = function (body) {
            call.body = body === undefined ? null : body;
            this.statusCode = response.statusCode;
            this.text = response.text;
            this.errorText = response.errorText || '';
        };
    }

    sfcc.reset();
    sfcc.registerAll({
        '*/cartridge/config/apiConfig': { getApplicablePaymentMethods: {}, createOrder: {} },
        'dw/util/HashMap': function () {},
        'dw/util/Calendar': function (date) { this.date = date; },
        'dw/util/StringUtils': { formatCalendar: function () { return '2026-09-02 10:00:00'; } },
        'dw/system/Logger': sfcc.loggerStub(),
        'dw/net/HTTPClient': HTTPClient,
        'dw/svc/LocalServiceRegistry': { createService: function () { return {}; } },
        'dw/system': {
            Site: {
                getCurrent: function () {
                    return {
                        getCustomPreferenceValue: function (id) {
                            if (id === 'Multisafepay_Environment') { return options.environment || 'test'; }
                            if (id === 'Multisafepay_GroupCards') { return options.groupCards === true; }
                            return null;
                        }
                    };
                }
            }
        }
    });
    return { helper: sfcc.loadCartridgeModule(HELPER), calls: calls };
}

test.describe('getApplicablePaymentMethods - endpoint', function () {
    test.it('omits country and currency when the caller does not provide them', function () {
        var ctx = loadHelper();
        ctx.helper.getApplicablePaymentMethods({ apiToken: 'k' });
        var url = ctx.calls[0].url;
        assert.ok(url.indexOf('country=') === -1, 'the sync must not pre-filter by country: ' + url);
        assert.ok(url.indexOf('currency=') === -1, 'the sync must not pre-filter by currency: ' + url);
    });

    test.it('still produces a valid query string with no optional params', function () {
        var ctx = loadHelper();
        ctx.helper.getApplicablePaymentMethods({ apiToken: 'k' });
        assert.strictEqual(
            ctx.calls[0].url,
            'https://testapi.multisafepay.com/v1/json/payment-methods?group_cards=0&include_coupons=1'
        );
    });

    test.it('includes country, currency and locale when a caller does pass them', function () {
        var ctx = loadHelper();
        ctx.helper.getApplicablePaymentMethods({ apiToken: 'k', country: 'NL', currency: 'EUR', locale: 'en_NL' });
        var url = ctx.calls[0].url;
        assert.ok(url.indexOf('?country=NL') > -1, url);
        assert.ok(url.indexOf('&currency=EUR') > -1, url);
        assert.ok(url.indexOf('&locale=en_NL') > -1, url);
        assert.ok(url.indexOf('&group_cards=0') > -1, url);
    });

    test.it('reflects the Group Card Methods preference', function () {
        var ctx = loadHelper({ groupCards: true });
        ctx.helper.getApplicablePaymentMethods({ apiToken: 'k' });
        assert.ok(ctx.calls[0].url.indexOf('group_cards=1') > -1, ctx.calls[0].url);
    });

    test.it('targets the live host in the live environment', function () {
        var ctx = loadHelper({ environment: 'live' });
        ctx.helper.getApplicablePaymentMethods({ apiToken: 'k' });
        assert.ok(ctx.calls[0].url.indexOf('https://api.multisafepay.com/') === 0, ctx.calls[0].url);
    });

    test.it('surfaces an authentication failure instead of an empty catalogue', function () {
        var ctx = loadHelper({ responses: [{ statusCode: 401, errorText: '{"error_info":"Invalid API key"}' }] });
        var result = ctx.helper.getApplicablePaymentMethods({ apiToken: 'bad' });
        assert.strictEqual(result.error, true);
        assert.strictEqual(result.statusCode, 401);
        assert.strictEqual(result.error_info, 'Invalid API key');
    });
});

test.describe('updateOrderShipped - BNPL shipment notification', function () {
    test.it('uses PATCH on the order resource', function () {
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', '00007601', {});
        assert.strictEqual(ctx.calls[0].method, 'PATCH');
        assert.strictEqual(ctx.calls[0].url, 'https://testapi.multisafepay.com/v1/json/orders/00007601');
    });

    test.it('sends status shipped and authenticates the call', function () {
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', '00007601', {});
        assert.strictEqual(JSON.parse(ctx.calls[0].body).status, 'shipped');
        assert.strictEqual(ctx.calls[0].headers.Authorization, 'Bearer key');
        assert.strictEqual(ctx.calls[0].headers['Content-Type'], 'application/json');
    });

    test.it('always sends the three fields MSP requires, never blank', function () {
        // Observed against the MultiSafepay test API: a body of {"status":"shipped"}
        // is answered with HTTP 410 "Required fields: tracktrace_code, carrier,
        // ship_date". An earlier version omitted them when empty, on the strength
        // of a note that had never been tested against the API.
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', '00007601', { tracktrace_code: '', carrier: '', ship_date: '' });
        var body = JSON.parse(ctx.calls[0].body);
        assert.ok(body.tracktrace_code, 'tracktrace_code must be present and non-empty');
        assert.ok(body.carrier, 'carrier must be present and non-empty');
        assert.ok(body.ship_date, 'ship_date must be present and non-empty');
    });

    test.it('falls back to the order number when there is no tracking code', function () {
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', '00007601', { carrier: 'PostNL', ship_date: '2026-09-02 10:00:00' });
        assert.strictEqual(JSON.parse(ctx.calls[0].body).tracktrace_code, '00007601');
    });

    test.it('forwards the tracking data when it is available', function () {
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', '00007601', {
            tracktrace_code: 'TR01', carrier: 'PostNL', ship_date: '2026-08-25 10:00:00'
        });
        assert.deepStrictEqual(JSON.parse(ctx.calls[0].body), {
            status: 'shipped', tracktrace_code: 'TR01', carrier: 'PostNL', ship_date: '2026-08-25 10:00:00'
        });
    });

    test.it('escapes the order number in the path', function () {
        var ctx = loadHelper();
        ctx.helper.updateOrderShipped('key', 'a b/c', {});
        assert.ok(ctx.calls[0].url.indexOf('a%20b%2Fc') > -1, ctx.calls[0].url);
    });

    test.it('never falls back to POST', function () {
        // Verified against the live MSP test API: POST /orders/{id} answers
        // 405 "Method not allowed". A fallback could only produce a second
        // failing call and a misleading log line.
        var ctx = loadHelper({ responses: [{ statusCode: 405, errorText: '{"error_info":"Method not allowed"}' }] });
        var result = ctx.helper.updateOrderShipped('key', '00007601', {});
        assert.strictEqual(ctx.calls.length, 1, 'exactly one request');
        assert.strictEqual(ctx.calls[0].method, 'PATCH');
        assert.strictEqual(result.success, false);
    });

    test.it('reports a transport failure with its status code', function () {
        var ctx = loadHelper({ responses: [{ statusCode: 401, errorText: '{"error_info":"Invalid API key"}' }] });
        var result = ctx.helper.updateOrderShipped('key', '00007601', {});
        assert.strictEqual(result.success, false);
        assert.ok(String(result.data).indexOf('401') > -1, result.data);
        assert.ok(String(result.data).indexOf('Invalid API key') > -1, result.data);
    });

    test.it('reports an application-level MSP failure returned with HTTP 200', function () {
        var ctx = loadHelper({
            responses: [{ statusCode: 200, text: '{"success":false,"error_info":"Order not found"}' }]
        });
        var result = ctx.helper.updateOrderShipped('key', 'nope', {});
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.data, 'Order not found');
    });
});
