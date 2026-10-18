'use strict';

/**
 * REQ-2.1.6 — Shipment status synchronization for (BNPL) MultiSafepay orders.
 *
 * Business Manager shipment changes do not raise a storefront hook, so this job
 * scans orders that have been marked as SHIPPED and notifies MultiSafepay, which
 * for BNPL methods (Riverty/Klarna/Billink/in3) triggers the financial-status
 * change (invoice/capture). Already-notified orders are skipped via the
 * Order.Multisafepay_ShipmentNotified flag so the notification is sent once.
 *
 * Register as a custom job step (see steptypes.json) and schedule it, e.g. hourly.
 */

var Order = require('dw/order/Order');
var OrderMgr = require('dw/order/OrderMgr');
var Transaction = require('dw/system/Transaction');
var Site = require('dw/system/Site');
var Status = require('dw/system/Status');
var Calendar = require('dw/util/Calendar');
var StringUtils = require('dw/util/StringUtils');
var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');

/**
 * Returns true when the object's type defines the given custom attribute
 * (avoids "Unknown dynamic property" when metadata is not imported). Never throws.
 * @param {dw.object.ExtensibleObject} extObj - object to inspect
 * @param {string} attrId - custom attribute id
 * @returns {boolean} whether the attribute is defined
 */
function orderDefines(extObj, attrId) {
    try {
        var def = extObj.describe();
        return !!(def && def.getCustomAttributeDefinition(attrId));
    } catch (e) {
        return false;
    }
}

/**
 * Formats a date as the "YYYY-MM-DD HH:mm:ss" string MSP expects for ship_date.
 * @param {Date} date - the date to format
 * @returns {string} formatted date
 */
function formatShipDate(date) {
    return StringUtils.formatCalendar(new Calendar(date), 'yyyy-MM-dd HH:mm:ss');
}

/**
 * Collects the shipment information MSP needs alongside status "shipped".
 *
 * MSP requires tracktrace_code, carrier and ship_date (HTTP 410 otherwise), so
 * whatever cannot be read here is defaulted by updateOrderShipped rather than
 * dropped. This function's job is to supply the real values when they exist.
 *
 * @param {dw.order.Order} order - the shipped order
 * @returns {Object} {tracktrace_code, carrier, ship_date}, real values only
 */
function buildShipmentData(order) {
    var data = { ship_date: formatShipDate(new Date()) };
    try {
        var shipments = order.getShipments();
        var carrier = '';
        for (var i = 0; i < shipments.length; i++) {
            var shipment = shipments[i];
            var methodName = (shipment.shippingMethod && shipment.shippingMethod.displayName)
                ? String(shipment.shippingMethod.displayName)
                : '';
            if (!carrier) { carrier = methodName; }

            // The tracking number decides which shipment is reported, but the
            // carrier does not depend on it. An order marked shipped from
            // Business Manager normally has no tracking number, and reading the
            // carrier only inside this branch is why the PATCH body carried
            // neither field and MSP rejected all seven orders on 2026-09-02.
            if (shipment.trackingNumber) {
                data.tracktrace_code = String(shipment.trackingNumber);
                if (methodName) { carrier = methodName; }
                break;
            }
        }
        if (carrier) { data.carrier = carrier; }
    } catch (e) {
        Logger.warn('[NotifyShipments] Could not read tracking data for {0}: {1}', order.orderNo, e.message);
    }
    return data;
}

/**
 * Flags an order as already notified so the next run skips it.
 * @param {dw.order.Order} order - the notified order
 * @returns {void}
 */
function markNotified(order) {
    Transaction.wrap(function () {
        // eslint-disable-next-line no-param-reassign
        order.custom.Multisafepay_ShipmentNotified = true;
    });
}

/**
 * Job entry point.
 * @returns {dw.system.Status} OK when every shipped order was notified (or there
 *          was nothing to do); ERROR when at least one notification failed, so the
 *          failure is visible in Job History instead of being silently swallowed.
 */
function run() {
    var clientKey = multisafepayHelper.getActiveApiKey(Site.getCurrent());
    if (!clientKey) {
        Logger.error('[NotifyShipments] No API key configured; aborting.');
        return new Status(Status.ERROR, 'NO_API_KEY', 'No MultiSafepay API key configured.');
    }

    // Orders that are shipped (fully or partially) and paid via MSP.
    var query = 'shippingStatus = {0} AND status = {1}';
    var orders = OrderMgr.searchOrders(
        query,
        'creationDate desc',
        Order.SHIPPING_STATUS_SHIPPED,
        Order.ORDER_STATUS_OPEN
    );

    var processed = 0;
    var mspOrders = 0;
    var notified = 0;
    var failed = 0;
    var lastError = '';
    try {
        while (orders.hasNext()) {
            var order = orders.next();
            processed++;

            var instruments = order.getPaymentInstruments('MultiSafepayPayment');
            if (!instruments || instruments.length === 0) {
                continue; // not an MSP order
            }
            mspOrders++;

            // Skip if already notified (guarded — attribute may not be imported yet).
            var attributeAvailable = orderDefines(order, 'Multisafepay_ShipmentNotified');
            if (!attributeAvailable || order.custom.Multisafepay_ShipmentNotified === true) {
                if (!attributeAvailable) {
                    // Without the flag the job cannot remember what it already sent
                    // and would re-notify MSP on every run. Refuse and report it.
                    Logger.warn('[NotifyShipments] Order.Multisafepay_ShipmentNotified is not defined — import system-objecttype-extensions.xml. Order {0} skipped.', order.orderNo);
                    failed++;
                    lastError = 'Order.Multisafepay_ShipmentNotified attribute is missing (metadata not imported).';
                }
                continue;
            }

            var result = multisafepayHelper.updateOrderShipped(clientKey, order.orderNo, buildShipmentData(order));

            if (result.success) {
                notified++;
                markNotified(order);
                Logger.info('[NotifyShipments] Order {0} shipment notified to MSP', order.orderNo);
            } else {
                failed++;
                // The status message is the one diagnostic that reaches Job
                // History whether or not the multisafepay log category is
                // enabled, so it carries the order number as well as the error.
                lastError = 'order ' + order.orderNo + ' - ' + String(result.data);
                Logger.error('[NotifyShipments] Order {0} shipment notification failed: {1}', order.orderNo, result.data);
            }
        }
    } finally {
        orders.close();
    }

    Logger.info('[NotifyShipments] Done. Scanned {0} shipped orders, {1} paid with MSP, {2} notified, {3} failed.', processed, mspOrders, notified, failed);

    if (failed > 0) {
        return new Status(Status.ERROR, 'NOTIFY_FAILED',
            failed + ' of ' + mspOrders + ' MultiSafepay order(s) could not be notified. Last error: ' + lastError);
    }
    return new Status(Status.OK, 'OK', 'Notified ' + notified + ' of ' + mspOrders + ' MultiSafepay order(s).');
}

module.exports = {
    run: run
};
