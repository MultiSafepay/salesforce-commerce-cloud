'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var HELPER = 'cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js';

/**
 * Loads multisafepayHelper with the stubs it needs at module load time.
 * @returns {Object} the helper module
 */
function loadHelper() {
    sfcc.reset();
    sfcc.registerAll({
        '*/cartridge/config/apiConfig': {},
        'dw/util/HashMap': function () {},
        'dw/system/Logger': sfcc.loggerStub()
    });
    return sfcc.loadCartridgeModule(HELPER);
}

test.describe('mapApiPaymentMethod — MSP API contract', function () {
    test.it('treats an EMPTY allowed_countries as "no restriction", not as a country list', function () {
        var helper = loadHelper();
        // This is the exact shape MSP returns for Billink and Mastercard:
        // no country restriction at all.
        var result = helper.mapApiPaymentMethod({
            id: 'MASTERCARD',
            name: 'MasterCard',
            allowed_countries: []
        });
        assert.strictEqual(result.countries, '',
            'an empty allowed_countries must map to an empty string so the method is offered everywhere');
    });

    test.it('treats a MISSING allowed_countries as "no restriction"', function () {
        var helper = loadHelper();
        var result = helper.mapApiPaymentMethod({ id: 'IDEAL', name: 'iDEAL' });
        assert.strictEqual(result.countries, '');
    });

    test.it('keeps a populated allowed_countries as an upper-cased CSV', function () {
        var helper = loadHelper();
        var result = helper.mapApiPaymentMethod({
            id: 'AFTERPAY',
            name: 'Riverty',
            allowed_countries: ['nl', ' BE ']
        });
        assert.strictEqual(result.countries, 'NL,BE');
    });

    test.it('drops malformed country codes instead of emitting them', function () {
        var helper = loadHelper();
        var result = helper.mapApiPaymentMethod({
            id: 'X',
            allowed_countries: ['NL', 'NLD', '', 'B']
        });
        assert.strictEqual(result.countries, 'NL');
    });

    test.it('converts allowed_amount from cents to major units, treating null max as no cap', function () {
        var helper = loadHelper();
        var result = helper.mapApiPaymentMethod({
            id: 'IDEAL',
            allowed_amount: { min: 100, max: null }
        });
        assert.strictEqual(result.minAmount, 1);
        assert.strictEqual(result.maxAmount, 0, 'null max must mean "no upper bound"');
    });

    test.it('requires BOTH manual_capture.supported and is_enabled for the Capture badge', function () {
        var helper = loadHelper();
        var cases = [
            { mc: { supported: true, is_enabled: true }, expected: true },
            { mc: { supported: true, is_enabled: false }, expected: false },
            { mc: { supported: false, is_enabled: true }, expected: false },
            { mc: undefined, expected: false }
        ];
        cases.forEach(function (c) {
            var result = helper.mapApiPaymentMethod({ id: 'VISA', manual_capture: c.mc });
            assert.strictEqual(result.supportsCapture, c.expected,
                'manual_capture=' + JSON.stringify(c.mc));
        });
    });

    test.it('reads the payment-component flags from either API shape', function () {
        var helper = loadHelper();
        var topLevel = helper.mapApiPaymentMethod({
            id: 'A', payment_components: { is_enabled: true, has_fields: true }
        });
        var underApps = helper.mapApiPaymentMethod({
            id: 'B', apps: { payment_components: { is_enabled: true, has_fields: true } }
        });
        var disabled = helper.mapApiPaymentMethod({
            id: 'C', apps: { payment_components: { is_enabled: false, has_fields: true } }
        });
        assert.strictEqual(topLevel.requiresComponent, true);
        assert.strictEqual(underApps.requiresComponent, true);
        assert.strictEqual(disabled.requiresComponent, false);
    });

    test.it('falls back through name -> description -> id so the CO name is never empty', function () {
        var helper = loadHelper();
        assert.strictEqual(helper.mapApiPaymentMethod({ id: 'X', name: 'Nice' }).name, 'Nice');
        assert.strictEqual(helper.mapApiPaymentMethod({ id: 'X', description: 'Desc' }).name, 'Desc');
        assert.strictEqual(helper.mapApiPaymentMethod({ id: 'X' }).name, 'X');
    });

    test.it('returns null for an entry without an id', function () {
        var helper = loadHelper();
        assert.strictEqual(helper.mapApiPaymentMethod({ name: 'orphan' }), null);
        assert.strictEqual(helper.mapApiPaymentMethod(null), null);
    });
});
