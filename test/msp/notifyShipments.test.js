'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var MODULE = 'cartridges/multisafepay/cartridge/scripts/jobs/notifyShipments.js';

var STATUS_OK = 2;
var STATUS_ERROR = 3;

/**
 * Builds an order stub.
 * @param {Object} opts - {orderNo, isMsp, notified, hasAttribute, trackingNumber}
 * @returns {Object} order stub
 */
function orderStub(opts) {
    var custom = {};
    if (opts.notified !== undefined) { custom.Multisafepay_ShipmentNotified = opts.notified; }
    var hasAttribute = opts.hasAttribute !== false;
    return {
        orderNo: opts.orderNo,
        custom: custom,
        describe: function () {
            return {
                getCustomAttributeDefinition: function (id) {
                    if (id === 'Multisafepay_ShipmentNotified' && !hasAttribute) { return null; }
                    return { id: id };
                }
            };
        },
        getPaymentInstruments: function (method) {
            if (method === 'MultiSafepayPayment' && opts.isMsp !== false) { return [{}]; }
            return [];
        },
        getShipments: function () {
            return [{
                trackingNumber: opts.trackingNumber || null,
                shippingMethod: opts.carrier ? { displayName: opts.carrier } : null
            }];
        }
    };
}

/**
 * Loads the job with stubbed platform services.
 * @param {Object} opts - {orders, apiKey, updateResult}
 * @returns {Object} {job, notifyCalls, savedFlags}
 */
function loadJob(opts) {
    var options = opts || {};
    var orders = options.orders || [];
    var notifyCalls = [];

    sfcc.reset();
    sfcc.registerAll({
        'dw/order/Order': { SHIPPING_STATUS_SHIPPED: 2, ORDER_STATUS_OPEN: 3 },
        'dw/order/OrderMgr': {
            searchOrders: function () {
                var i = 0;
                return {
                    hasNext: function () { return i < orders.length; },
                    next: function () { return orders[i++]; },
                    close: function () {}
                };
            }
        },
        'dw/system/Transaction': { wrap: function (fn) { return fn(); } },
        'dw/system/Site': { getCurrent: function () { return {}; } },
        'dw/system/Status': function (code, id, message) {
            this.code = code; this.id = id; this.message = message;
        },
        'dw/system/Logger': sfcc.loggerStub(),
        'dw/util/Calendar': function (date) { this.date = date; },
        'dw/util/StringUtils': { formatCalendar: function () { return '2026-08-25 10:00:00'; } },
        '*/cartridge/scripts/helpers/multisafepayHelper': {
            getActiveApiKey: function () {
                return options.apiKey === undefined ? 'key' : options.apiKey;
            },
            updateOrderShipped: function (apiToken, orderNo, shipmentData) {
                notifyCalls.push({ orderNo: orderNo, shipmentData: shipmentData });
                return options.updateResult || { success: true, data: {} };
            }
        }
    });

    // dw/system/Status carries its constants on the constructor.
    // eslint-disable-next-line no-underscore-dangle
    var statusCtor = require('module')._load('dw/system/Status');
    statusCtor.OK = STATUS_OK;
    statusCtor.ERROR = STATUS_ERROR;

    return { job: sfcc.loadCartridgeModule(MODULE), notifyCalls: notifyCalls };
}

test.describe('notifyShipments - selection', function () {
    test.it('notifies a shipped MSP order that has not been notified yet', function () {
        var ctx = loadJob({ orders: [orderStub({ orderNo: '00007601', notified: false })] });
        var status = ctx.job.run();
        assert.strictEqual(ctx.notifyCalls.length, 1);
        assert.strictEqual(ctx.notifyCalls[0].orderNo, '00007601');
        assert.strictEqual(status.code, STATUS_OK);
    });

    test.it('skips an order already notified, so MSP is never told twice', function () {
        var ctx = loadJob({ orders: [orderStub({ orderNo: '00007601', notified: true })] });
        ctx.job.run();
        assert.strictEqual(ctx.notifyCalls.length, 0);
    });

    test.it('flags the order as notified after a successful call', function () {
        var order = orderStub({ orderNo: '00007601', notified: false });
        var ctx = loadJob({ orders: [order] });
        ctx.job.run();
        assert.strictEqual(order.custom.Multisafepay_ShipmentNotified, true);
    });

    test.it('ignores orders that were not paid with MultiSafepay', function () {
        var ctx = loadJob({ orders: [orderStub({ orderNo: '1', isMsp: false, notified: false })] });
        ctx.job.run();
        assert.strictEqual(ctx.notifyCalls.length, 0);
    });
});

test.describe('notifyShipments - shipment data', function () {
    test.it('forwards tracking number and carrier when the shipment has them', function () {
        var ctx = loadJob({
            orders: [orderStub({ orderNo: '1', notified: false, trackingNumber: 'TR01', carrier: 'PostNL' })]
        });
        ctx.job.run();
        assert.strictEqual(ctx.notifyCalls[0].shipmentData.tracktrace_code, 'TR01');
        assert.strictEqual(ctx.notifyCalls[0].shipmentData.carrier, 'PostNL');
    });

    test.it('reads the carrier even when the shipment has no tracking number', function () {
        // An order marked shipped from Business Manager normally carries no
        // tracking number. Reading the carrier only inside the tracking-number
        // branch left the PATCH body with neither field, and MSP answered
        // HTTP 410 "Required fields: tracktrace_code, carrier, ship_date".
        var ctx = loadJob({
            orders: [orderStub({ orderNo: '1', notified: false, carrier: 'PostNL' })]
        });
        ctx.job.run();
        assert.strictEqual(ctx.notifyCalls[0].shipmentData.carrier, 'PostNL');
    });

    test.it('still notifies when there is no tracking data at all', function () {
        // tracktrace_code stays absent here on purpose: updateOrderShipped owns
        // the required-field contract and substitutes the order number, so the
        // job does not invent a tracking code of its own.
        var ctx = loadJob({ orders: [orderStub({ orderNo: '1', notified: false })] });
        ctx.job.run();
        assert.strictEqual(ctx.notifyCalls.length, 1);
        assert.strictEqual(ctx.notifyCalls[0].shipmentData.tracktrace_code, undefined);
        assert.strictEqual(ctx.notifyCalls[0].shipmentData.ship_date, '2026-08-25 10:00:00');
    });
});

test.describe('notifyShipments - failures are visible in Job History', function () {
    test.it('fails the step when MSP rejects the notification', function () {
        var ctx = loadJob({
            orders: [orderStub({ orderNo: '00007601', notified: false })],
            updateResult: { success: false, data: 'HTTP 401: Invalid API key' }
        });
        var status = ctx.job.run();
        assert.strictEqual(status.code, STATUS_ERROR, 'a failed notification must not report OK');
        assert.ok(String(status.message).indexOf('Invalid API key') > -1, status.message);
        assert.ok(String(status.message).indexOf('00007601') > -1,
            'the failing order number must reach Job History: where the '
            + 'multisafepay log category is disabled this message is the only diagnostic');
    });

    test.it('fails fast when no API key is configured', function () {
        var ctx = loadJob({ apiKey: null, orders: [] });
        var status = ctx.job.run();
        assert.strictEqual(status.code, STATUS_ERROR);
        assert.strictEqual(status.id, 'NO_API_KEY');
    });

    test.it('reports, instead of silently looping, when the tracking attribute is missing', function () {
        // Without Multisafepay_ShipmentNotified the job cannot remember what it
        // already sent, so it must refuse rather than re-notify MSP on every run.
        var ctx = loadJob({
            orders: [orderStub({ orderNo: '1', hasAttribute: false })]
        });
        var status = ctx.job.run();
        assert.strictEqual(ctx.notifyCalls.length, 0);
        assert.strictEqual(status.code, STATUS_ERROR);
        assert.ok(String(status.message).indexOf('metadata') > -1, status.message);
    });

    test.it('reports OK with nothing to do when no order is shipped', function () {
        var ctx = loadJob({ orders: [] });
        assert.strictEqual(ctx.job.run().code, STATUS_OK);
    });
});
