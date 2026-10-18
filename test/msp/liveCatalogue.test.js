'use strict';

/**
 * The mapper run against a REAL response captured from the MultiSafepay test API
 * (`GET /payment-methods?group_cards=0&include_coupons=1`, the exact URL the sync
 * now builds) for a MultiSafepay test account.
 *
 * The fixture is what makes these assertions meaningful: they pin the connector
 * against the merchant's actual catalogue, not against a shape we invented.
 */

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var sfcc = require('./helpers/sfccModules');

var CATALOGUE = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures-payment-methods.json'), 'utf8')
);

/**
 * @returns {Array} the fixture mapped through the production mapper
 */
function mapCatalogue() {
    sfcc.reset();
    sfcc.registerAll({
        '*/cartridge/config/apiConfig': {},
        'dw/util/HashMap': function () {},
        'dw/system/Logger': sfcc.loggerStub()
    });
    var helper = sfcc.loadCartridgeModule(
        'cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js'
    );
    return CATALOGUE.data.map(helper.mapApiPaymentMethod).filter(Boolean);
}

/**
 * @param {Array} mapped - mapped catalogue
 * @param {string} id - gateway id
 * @returns {Object} the mapped entry
 */
function byId(mapped, id) {
    var found = mapped.filter(function (m) { return m.gatewayId === id; })[0];
    assert.ok(found, id + ' missing from the mapped catalogue');
    return found;
}

test.describe('live catalogue - the methods the per-country probe dropped', function () {
    // Every method that did not appear in the checkout. The old per-country
    // probe (country=NL&currency=EUR) returns 16 of 30 methods and drops
    // exactly these fourteen.
    var REPORTED_MISSING = [
        'MASTERCARD', 'MISTERCASH', 'MYBANK', 'AMAZONBTN', 'KBC', 'BELFIUS',
        'DIRDEB', 'TRUSTLY', 'CBC', 'EPS', 'DOTPAY', 'MBWAY', 'MULTIBANCO', 'BIZUM'
    ];

    test.it('all fourteen are present in the unfiltered catalogue', function () {
        var mapped = mapCatalogue();
        REPORTED_MISSING.forEach(function (id) { byId(mapped, id); });
    });

    test.it('all fourteen carry NO country restriction', function () {
        var mapped = mapCatalogue();
        REPORTED_MISSING.forEach(function (id) {
            assert.strictEqual(
                byId(mapped, id).countries, '',
                id + ' must be unrestricted — MSP reports allowed_countries: [] for it'
            );
        });
    });

    test.it('Mastercard is offered to a Dutch shopper', function () {
        // The precise regression: it had been stored as DE,IT,BE,FR,ES,AT — no NL.
        var mastercard = byId(mapCatalogue(), 'MASTERCARD');
        assert.strictEqual(mastercard.countries, '');
        assert.strictEqual(mastercard.supportsCapture, true);
        assert.strictEqual(mastercard.requiresComponent, true);
    });
});

test.describe('live catalogue - restrictions that are real', function () {
    test.it('Riverty is the only country-restricted method, and only in NL', function () {
        var restricted = mapCatalogue().filter(function (m) { return m.countries !== ''; });
        assert.deepStrictEqual(
            restricted.map(function (m) { return m.gatewayId + ':' + m.countries; }),
            ['AFTERPAY:NL']
        );
    });

    test.it('in3 B2B is hidden by its EUR 150 minimum, not by a country rule', function () {
        // A EUR 64 basket is below that minimum, so the
        // method is correctly withheld — this is not a defect.
        var in3b2b = byId(mapCatalogue(), 'IN3B2B');
        assert.strictEqual(in3b2b.countries, '');
        assert.strictEqual(in3b2b.minAmount, 150);
    });

    test.it('iDEAL keeps its EUR 50,000 cap', function () {
        // A EUR 51,000 basket must therefore not be offered iDEAL.
        var ideal = byId(mapCatalogue(), 'IDEAL');
        assert.strictEqual(ideal.maxAmount, 50000);
    });
});

test.describe('live catalogue - manual capture', function () {
    test.it('exactly the card schemes report manual capture', function () {
        var capturable = mapCatalogue()
            .filter(function (m) { return m.supportsCapture; })
            .map(function (m) { return m.gatewayId; })
            .sort();
        assert.deepStrictEqual(capturable, ['MAESTRO', 'MASTERCARD', 'MISTERCASH', 'VISA']);
    });

    test.it('no method is marked capturable on `supported` alone', function () {
        // On this account every capturable method has both flags set, so the
        // is_enabled gate changes nothing today. It still has to hold: the merchant
        // can switch manual capture off per method in the MSP Admin Panel, and the
        // badge must disappear when they do.
        var mismatched = CATALOGUE.data.filter(function (m) {
            return m.manual_capture && m.manual_capture.supported === true
                && m.manual_capture.is_enabled !== true;
        });
        var mapped = mapCatalogue();
        mismatched.forEach(function (m) {
            assert.strictEqual(
                byId(mapped, m.id).supportsCapture, false,
                m.id + ' has capture disabled on the account and must not show the badge'
            );
        });
    });
});

test.describe('live catalogue - nothing is dropped', function () {
    test.it('every entry maps to a Custom Object shape', function () {
        assert.strictEqual(mapCatalogue().length, CATALOGUE.data.length);
    });

    test.it('every method gets a display name and an icon', function () {
        mapCatalogue().forEach(function (m) {
            assert.ok(m.name && m.name.length, m.gatewayId + ' has no name');
            assert.ok(m.iconUrl && m.iconUrl.indexOf('http') === 0, m.gatewayId + ' has no icon');
        });
    });
});
