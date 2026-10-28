'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var MODULE = 'cartridges/multisafepay/cartridge/models/transactionData.js';

/**
 * Builds an order stub with one product line item and one shipping line item.
 * @param {Object} [opts] - {shippingCost}
 * @returns {Object} order stub
 */
function orderStub(opts) {
    var options = opts || {};
    var shippingCost = options.shippingCost === undefined ? 5.99 : options.shippingCost;
    var address = {
        firstName: 'Test',
        lastName: 'QA',
        address1: 'Vijzelstraat 20',
        address2: '',
        postalCode: '1017HK',
        city: 'Amsterdam',
        stateCode: 'OTHER',
        countryCode: { value: 'NL' },
        phone: '9234567890'
    };
    return {
        orderNo: '00007601',
        remoteHost: '185.49.169.194',
        customerEmail: 'qa@example.com',
        getCustomerNo: function () { return '00000001'; },
        getBillingAddress: function () { return address; },
        getCurrencyCode: function () { return 'EUR'; },
        defaultShipment: {
            shippingAddress: address,
            getShippingLineItems: function () {
                return shippingCost > 0 ? [{
                    getAdjustedNetPrice: function () { return { getValue: function () { return shippingCost; } }; },
                    getTaxRate: function () { return 0.21; }
                }] : [];
            }
        },
        getAllProductLineItems: function () {
            return [{
                productName: 'Woven Trimmed Cardigan.',
                productID: '701644391737M',
                getAdjustedNetPrice: function () { return { getValue: function () { return 64; } }; },
                getQuantityValue: function () { return 1; },
                getTaxRate: function () { return 0.21; }
            }];
        },
        getAdjustedShippingTotalPrice: function () {
            return { getValue: function () { return shippingCost; } };
        }
    };
}

/**
 * Loads transactionData with the given site preference and CO catalogue.
 * @param {Object} prefs - site preference values by id
 * @param {Object} coStore - {gatewayId: {supportsCapture, hasAttribute}}
 * @returns {Function} the transactionData constructor
 */
function loadModel(prefs, coStore) {
    sfcc.reset();
    sfcc.registerAll({
        'dw/web/URLUtils': {
            https: function () {
                return { abs: function () { return { toString: function () { return 'https://example.test/x'; } }; } };
            }
        },
        'dw/system/Site': {
            getCurrent: function () {
                return {
                    getCustomPreferenceValue: function (id) { return prefs[id]; },
                    getHttpsHostName: function () { return 'example.test'; }
                };
            }
        },
        'dw/object/CustomObjectMgr': {
            getCustomObject: function (type, key) {
                var entry = coStore && coStore[key];
                if (!entry) { return null; }
                var custom = {};
                // An attribute the metadata does not define throws on access.
                Object.defineProperty(custom, 'supportsCapture', {
                    get: function () {
                        if (entry.hasAttribute === false) { throw new Error('Unknown dynamic property'); }
                        return entry.supportsCapture;
                    }
                });
                return {
                    custom: custom,
                    // Reproduces the platform: describe() reports defined attributes
                    // as undefined. The code under test must not depend on it.
                    describe: function () {
                        return { getCustomAttributeDefinition: function () { return null; } };
                    }
                };
            }
        }
    });
    return sfcc.loadCartridgeModule(MODULE);
}

/**
 * @param {Object} payload - the built transactionData
 * @returns {Object|undefined} the shipping cart item
 */
function shippingItem(payload) {
    return payload.shopping_cart.items.filter(function (i) { return i.name === 'Shipping'; })[0];
}

test.describe('transactionData - shipping line item', function () {
    test.it('identifies the shipping cost line with the reserved id msp-shipping', function () {
        var TransactionData = loadModel({}, {});
        var payload = new TransactionData(orderStub(), 'en_NL', 'IDEAL', 84.69).transactionData;
        assert.strictEqual(shippingItem(payload).merchant_item_id, 'msp-shipping');
    });

    test.it('leaves product line items keyed by their own product id', function () {
        var TransactionData = loadModel({}, {});
        var payload = new TransactionData(orderStub(), 'en_NL', 'IDEAL', 84.69).transactionData;
        var product = payload.shopping_cart.items[0];
        assert.strictEqual(product.merchant_item_id, '701644391737M');
    });

    test.it('omits the shipping line when there is no shipping cost', function () {
        var TransactionData = loadModel({}, {});
        var payload = new TransactionData(orderStub({ shippingCost: 0 }), 'en_NL', 'IDEAL', 64).transactionData;
        assert.strictEqual(shippingItem(payload), undefined);
        assert.strictEqual(payload.shopping_cart.items.length, 1);
    });
});

test.describe('transactionData - manual capture', function () {
    var capturable = { VISA: { supportsCapture: true } };
    var notCapturable = { IDEAL: { supportsCapture: false } };

    test.it('requests manual capture for a method that supports it', function () {
        var TransactionData = loadModel({ Multisafepay_ManualCapture: true }, capturable);
        var payload = new TransactionData(orderStub(), 'en_NL', 'VISA', 84.69).transactionData;
        assert.strictEqual(payload.capture, 'manual');
    });

    test.it('does NOT request manual capture for a method that does not support it', function () {
        // "capture": "manual" used to be sent for IDEAL.
        var TransactionData = loadModel({ Multisafepay_ManualCapture: true }, notCapturable);
        var payload = new TransactionData(orderStub(), 'en_NL', 'IDEAL', 84.69).transactionData;
        assert.strictEqual(payload.capture, undefined);
    });

    test.it('does not request manual capture when the merchant switched it off', function () {
        var TransactionData = loadModel({ Multisafepay_ManualCapture: false }, capturable);
        var payload = new TransactionData(orderStub(), 'en_NL', 'VISA', 84.69).transactionData;
        assert.strictEqual(payload.capture, undefined);
    });

    test.it('does not request manual capture for a gateway with no synced Custom Object', function () {
        var TransactionData = loadModel({ Multisafepay_ManualCapture: true }, {});
        var payload = new TransactionData(orderStub(), 'en_NL', 'MYBANK', 84.69).transactionData;
        assert.strictEqual(payload.capture, undefined);
    });

    test.it('degrades safely when the supportsCapture attribute is not in the metadata', function () {
        var TransactionData = loadModel(
            { Multisafepay_ManualCapture: true },
            { VISA: { supportsCapture: true, hasAttribute: false } }
        );
        var payload = new TransactionData(orderStub(), 'en_NL', 'VISA', 84.69).transactionData;
        assert.strictEqual(payload.capture, undefined);
    });
});

test.describe('transactionData - unchanged behaviour (regression guard)', function () {
    test.it('keeps the core order fields intact', function () {
        var TransactionData = loadModel({}, {});
        var payload = new TransactionData(orderStub(), 'en_NL', 'IDEAL', 84.69).transactionData;
        assert.strictEqual(payload.gateway, 'IDEAL');
        assert.strictEqual(payload.order_id, '00007601');
        assert.strictEqual(payload.currency, 'EUR');
        assert.strictEqual(payload.amount, 8469, 'amount must be sent in cents as an integer');
        assert.strictEqual(payload.seconds_active, 3600);
        assert.strictEqual(payload.type, 'redirect');
    });

    test.it('splits street and house number without duplicating the number', function () {
        var TransactionData = loadModel({}, {});
        var payload = new TransactionData(orderStub(), 'en_NL', 'IDEAL', 84.69).transactionData;
        assert.strictEqual(payload.customer.address1, 'Vijzelstraat');
        assert.strictEqual(payload.customer.house_number, '20');
    });
});
