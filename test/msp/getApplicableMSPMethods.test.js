'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var HELPER = 'cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js';

/**
 * Builds a Custom Object stub for one MSPPaymentMethod.
 * @param {Object} attrs - custom attribute values
 * @returns {Object} a CO stub exposing describe()/custom
 */
function co(attrs) {
    var custom = Object.assign({
        gatewayId: attrs.gatewayId,
        name: attrs.gatewayId,
        iconUrl: '',
        enabled: true,
        requiresComponent: false,
        sortOrder: 0,
        countries: '',
        currencies: '',
        minAmount: 0,
        maxAmount: 0,
        supportsCapture: false
    }, attrs);
    return {
        custom: custom,
        describe: function () {
            return {
                getCustomAttributeDefinition: function (id) {
                    return Object.prototype.hasOwnProperty.call(custom, id) ? { id: id } : null;
                }
            };
        }
    };
}

/**
 * Loads the helper with a stubbed Custom Object store and payment-method registry.
 * @param {Array} methods - attribute objects for the MSPPaymentMethod Custom Objects
 * @param {Object} [sfccMethods] - {MSP_<gateway>: {active, applicable}} overrides
 * @returns {Object} the helper module
 */
function loadHelper(methods, sfccMethods) {
    sfcc.reset();
    var cos = methods.map(co);
    sfcc.registerAll({
        '*/cartridge/config/apiConfig': {},
        'dw/util/HashMap': function () {},
        'dw/system/Logger': sfcc.loggerStub(),
        'dw/object/CustomObjectMgr': {
            getAllCustomObjects: function () {
                var i = 0;
                return {
                    hasNext: function () { return i < cos.length; },
                    next: function () { return cos[i++]; },
                    close: function () {}
                };
            }
        },
        'dw/order/PaymentMgr': {
            getPaymentMethod: function (id) {
                if (!sfccMethods || !Object.prototype.hasOwnProperty.call(sfccMethods, id)) {
                    return null; // not imported yet -> partial-rollout safety
                }
                var def = sfccMethods[id];
                return {
                    active: def.active !== false,
                    isApplicable: function () { return def.applicable !== false; }
                };
            }
        }
    });
    return sfcc.loadCartridgeModule(HELPER);
}

/**
 * @param {Array} result - the filtered method list
 * @returns {Array} just the gateway ids
 */
function ids(result) {
    return result.map(function (m) { return m.gatewayId; });
}

test.describe('getApplicableMSPMethods - country filtering', function () {
    test.it('shows an unrestricted method (empty countries) in EVERY country', function () {
        var helper = loadHelper([{ gatewayId: 'MASTERCARD', countries: '' }]);
        ['NL', 'DE', 'PL', 'BR', 'JP'].forEach(function (country) {
            assert.deepStrictEqual(
                ids(helper.getApplicableMSPMethods({}, country, 100, 'EUR')),
                ['MASTERCARD'],
                'MASTERCARD must be offered in ' + country
            );
        });
    });

    test.it('regression: Mastercard is offered to a NL shopper', function () {
        // MASTERCARD went missing at checkout with a NL
        // billing address, because the sync had pinned it to DE,IT,BE,FR,ES,AT.
        // With allowed_countries: [] correctly mapped to an empty string, it shows.
        var helper = loadHelper([
            { gatewayId: 'MASTERCARD', countries: '' },
            { gatewayId: 'IDEAL', countries: 'NL' }
        ]);
        assert.deepStrictEqual(
            ids(helper.getApplicableMSPMethods({}, 'NL', 64, 'EUR')).sort(),
            ['IDEAL', 'MASTERCARD']
        );
    });

    test.it('hides a country-restricted method outside its countries', function () {
        var helper = loadHelper([{ gatewayId: 'AFTERPAY', countries: 'NL' }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 100, 'EUR')), ['AFTERPAY']);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'DE', 100, 'EUR')), []);
    });

    test.it('matches the country case-insensitively and ignores stray whitespace', function () {
        var helper = loadHelper([{ gatewayId: 'X', countries: ' nl , be ' }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'nl', 10, 'EUR')), ['X']);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'BE', 10, 'EUR')), ['X']);
    });

    test.it('does not filter by country when the country is unknown', function () {
        var helper = loadHelper([{ gatewayId: 'AFTERPAY', countries: 'NL' }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, '', 100, 'EUR')), ['AFTERPAY']);
    });
});

test.describe('getApplicableMSPMethods - other restrictions still apply', function () {
    test.it('enforces the currency restriction', function () {
        var helper = loadHelper([{ gatewayId: 'IDEAL', currencies: 'EUR' }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 10, 'EUR')), ['IDEAL']);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 10, 'USD')), []);
    });

    test.it('enforces the max amount (iDEAL above its cap disappears)', function () {
        var helper = loadHelper([{ gatewayId: 'IDEAL', maxAmount: 50000 }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 49999, 'EUR')), ['IDEAL']);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 51000, 'EUR')), []);
    });

    test.it('enforces the min amount', function () {
        var helper = loadHelper([{ gatewayId: 'IN3', minAmount: 50 }]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 49, 'EUR')), []);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 50, 'EUR')), ['IN3']);
    });

    test.it('hides methods disabled in the BM settings panel', function () {
        var helper = loadHelper([
            { gatewayId: 'IDEAL' },
            { gatewayId: 'PAYPAL', enabled: false }
        ]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 10, 'EUR')), ['IDEAL']);
    });

    test.it('respects Ordering > Payment Methods: inactive drops, missing keeps', function () {
        var helper = loadHelper(
            [{ gatewayId: 'IDEAL' }, { gatewayId: 'VISA' }, { gatewayId: 'KBC' }],
            {
                MSP_IDEAL: { active: true, applicable: true },
                MSP_VISA: { active: false }
                // MSP_KBC deliberately not imported -> kept (partial rollout)
            }
        );
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 10, 'EUR')).sort(), ['IDEAL', 'KBC']);
    });

    test.it('sorts by sortOrder', function () {
        var helper = loadHelper([
            { gatewayId: 'B', sortOrder: 2 },
            { gatewayId: 'A', sortOrder: 1 }
        ]);
        assert.deepStrictEqual(ids(helper.getApplicableMSPMethods({}, 'NL', 10, 'EUR')), ['A', 'B']);
    });
});
