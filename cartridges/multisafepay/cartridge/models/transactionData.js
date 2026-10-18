'use strict';

var URLUtils = require('dw/web/URLUtils');
var Site = require('dw/system/Site');

/**
 * Returns a tax table selector name based on the tax rate
 * @param {number} taxRate - the tax rate as a decimal (e.g. 0.21 for 21%)
 * @returns {string} tax table selector name
 */
function getTaxTableSelector(taxRate) {
    if (!taxRate || taxRate === 0) {
        return 'none';
    }
    var pct = Math.round(taxRate * 10000) / 100;
    return 'TAX' + pct;
}

/**
 * Splits an address into street and house number for the MSP API, ensuring the
 * house number is never duplicated in both `address1` and `house_number`.
 *
 * Strategy:
 *  1. If address2 is a bare number/number+suffix (e.g. "42", "42B", "42-A"), the
 *     house number is address2 and the street (address1) is left untouched.
 *  2. Otherwise, if address1 ends with a numeric token (e.g. "Via Roma 10",
 *     "Kalverstraat 92A"), that token is the house number and it is STRIPPED
 *     from the returned street so it is not sent twice.
 *  3. If no number can be found, the street is returned as-is and the house
 *     number is null.
 *
 * Examples:
 *   ("Via Roma 10", "")   → { street: "Via Roma", houseNumber: "10" }
 *   ("Via Roma", "10")    → { street: "Via Roma", houseNumber: "10" }
 *   ("Kalverstraat 92A")  → { street: "Kalverstraat", houseNumber: "92A" }
 *
 * @param {string} address1 - primary address line (street, possibly + number)
 * @param {string} address2 - secondary address line (often the house number)
 * @returns {Object} { street: string, houseNumber: string|null }
 */
function parseStreetAndHouseNumber(address1, address2) {
    var street = address1 || '';

    // 1) address2 explicitly provided as a standalone number / number+suffix.
    //    The number lives in address2, so address1 is the clean street.
    if (address2) {
        var bareNumberMatch = address2.match(/^\s*(\d+[\w\-]*)\s*$/);
        if (bareNumberMatch) {
            return { street: street.trim(), houseNumber: bareNumberMatch[1] };
        }
    }

    // 2) Number at the tail of address1: extract it AND remove it from the street
    //    to avoid duplication.
    if (address1) {
        var tailMatch = address1.match(/^(.*?)[\s,]+(\d+[\w\-]*)[\s,]*$/);
        if (tailMatch) {
            return { street: tailMatch[1].trim(), houseNumber: tailMatch[2] };
        }
    }

    // 3) No house number found.
    return { street: street.trim(), houseNumber: null };
}

/**
 * Builds tax table definitions from the order's line items
 * @param {dw.order.Order} order - the order object
 * @returns {Object} tax tables object with alternate array
 */
function buildTaxTables(order) {
    var taxRates = {};
    var productLineItems = order.getAllProductLineItems();

    for (var i = 0; i < productLineItems.length; i++) {
        var rate = productLineItems[i].getTaxRate();
        var selector = getTaxTableSelector(rate);
        if (!(selector in taxRates)) {
            taxRates[selector] = rate || 0;
        }
    }

    if (order.defaultShipment) {
        var shippingLineItems = order.defaultShipment.getShippingLineItems();
        if (shippingLineItems.length > 0) {
            var shippingRate = shippingLineItems[0].getTaxRate();
            var shippingSelector = getTaxTableSelector(shippingRate);
            if (!(shippingSelector in taxRates)) {
                taxRates[shippingSelector] = shippingRate || 0;
            }
        }
    }

    var alternate = [];
    var keys = Object.keys(taxRates);
    for (var j = 0; j < keys.length; j++) {
        alternate.push({
            name: keys[j],
            rules: [{ rate: taxRates[keys[j]] }]
        });
    }

    return { alternate: alternate };
}

/**
 * Builds a shopping_cart items array from the order's product line items
 * @param {dw.order.Order} order - the order object
 * @returns {Array} array of cart item objects
 */
function buildShoppingCartItems(order) {
    var items = [];
    var productLineItems = order.getAllProductLineItems();
    for (var i = 0; i < productLineItems.length; i++) {
        var pli = productLineItems[i];
        var item = {
            name: pli.productName,
            description: pli.productID,
            unit_price: Math.round(pli.getAdjustedNetPrice().getValue() / pli.getQuantityValue() * 100) / 100,
            quantity: pli.getQuantityValue(),
            merchant_item_id: pli.productID,
            tax_table_selector: getTaxTableSelector(pli.getTaxRate())
        };
        items.push(item);
    }

    // Shipping cost as line item
    var shippingTotal = order.getAdjustedShippingTotalPrice();
    if (shippingTotal && shippingTotal.getValue() > 0 && order.defaultShipment) {
        var shippingLineItems = order.defaultShipment.getShippingLineItems();
        if (shippingLineItems.length > 0) {
            var shippingLI = shippingLineItems[0];
            items.push({
                name: 'Shipping',
                description: 'Shipping costs',
                unit_price: Math.round(shippingLI.getAdjustedNetPrice().getValue() * 100) / 100,
                quantity: 1,
                // MSP requires the shipping-cost line to be identified by
                // the reserved merchant_item_id 'msp-shipping' so it is recognised as
                // shipping (and not as a product) in the BNPL/shipment flows.
                merchant_item_id: 'msp-shipping',
                tax_table_selector: getTaxTableSelector(shippingLI.getTaxRate())
            });
        }
    }

    return items;
}

/**
 * Whether a gateway supports MSP manual capture (authorize now, capture later).
 *
 * The capability is reported per method by the MSP API
 * (manual_capture.supported && manual_capture.is_enabled) and persisted on the
 * MSPPaymentMethod Custom Object at sync time. Reading it defensively keeps
 * order creation working when the metadata has not been imported yet or the
 * catalogue has not been synced — in that case capture is simply not requested,
 * which is the safe default (the payment is captured automatically).
 *
 * @param {string} gateway - MSP gateway id, e.g. 'VISA'
 * @returns {boolean} true when manual capture can be requested for this gateway
 */
function gatewaySupportsManualCapture(gateway) {
    if (!gateway) {
        return false;
    }
    try {
        var CustomObjectMgr = require('dw/object/CustomObjectMgr');
        var co = CustomObjectMgr.getCustomObject('MSPPaymentMethod', gateway);
        if (!co) {
            return false;
        }
        var def = co.describe();
        if (!def || !def.getCustomAttributeDefinition('supportsCapture')) {
            return false;
        }
        return co.custom.supportsCapture === true;
    } catch (e) {
        return false;
    }
}

/**
 * Represents current transactionData information in plain object
 * @param {dw.order.Order} order - the order object
 * @param {string} currentLocaleID - locale identifier
 * @param {string} gateway - payment gateway code
 * @param {number} orderTotal - order total as a numeric value
 */
function transactionData(order, currentLocaleID, gateway, orderTotal) {
    var billingAddress = order.getBillingAddress();
    var shippingAddress = order.defaultShipment ? order.defaultShipment.shippingAddress : null;
    // Fallback to billing address if no shipping address is available
    if (!shippingAddress) {
        shippingAddress = billingAddress;
    }

    // Use unique reference — orderNo for guests, customerNo for registered
    var customerReference = order.getCustomerNo() ? order.getCustomerNo() : order.orderNo;

    // BNPL: split street/house number for methods that require it (e.g. Riverty).
    // The house number is stripped from address1 so it is never sent twice.
    var billingParsed = parseStreetAndHouseNumber(billingAddress.address1, billingAddress.address2);
    var deliveryParsed = parseStreetAndHouseNumber(shippingAddress.address1, shippingAddress.address2);

    this.transactionData = {
        payment_options: {
            notification_method: 'POST',
            notification_url: URLUtils.https('Multisafepay-Webhook').abs().toString(),
            close_window: false,
            redirect_url: URLUtils.https('Multisafepay-Confirm', 'orderID', order.orderNo).abs().toString(),
            cancel_url: URLUtils.https('Multisafepay-Cancellation', 'orderID', order.orderNo).abs().toString()
        },
        customer: {
            locale: currentLocaleID,
            disable_send_email: false,
            first_name: billingAddress.firstName,
            last_name: billingAddress.lastName,
            address1: billingParsed.street || billingAddress.address1,
            house_number: billingParsed.houseNumber || undefined,
            zip_code: billingAddress.postalCode,
            city: billingAddress.city,
            state: billingAddress.stateCode,
            country: billingAddress.countryCode.value,
            phone: billingAddress.phone,
            ip_address: order.remoteHost,
            email: order.customerEmail,
            reference: customerReference
        },
        delivery: {
            first_name: shippingAddress.firstName,
            last_name: shippingAddress.lastName,
            address1: deliveryParsed.street || shippingAddress.address1,
            house_number: deliveryParsed.houseNumber || undefined,
            zip_code: shippingAddress.postalCode,
            city: shippingAddress.city,
            state: shippingAddress.stateCode,
            country: shippingAddress.countryCode.value,
            phone: shippingAddress.phone,
            email: order.customerEmail
        },
        shopping_cart: {
            items: buildShoppingCartItems(order)
        },
        plugin: {
            shop: 'SalesforceCommerceCloud',
            shop_version: 'SFRA 6.3.0',
            plugin_version: '1.0.0',
            partner: 'BIP',
            shop_root_url: 'https://' + Site.getCurrent().getHttpsHostName()
        },
        checkout_options: {
            validate_cart: false,
            tax_tables: buildTaxTables(order)
        },
        seconds_active: 3600, // 1 hour expiration; days_active is not used
        type: 'redirect',
        gateway: gateway,
        order_id: order.orderNo,
        currency: order.getCurrencyCode(),
        amount: Math.round(orderTotal * 100), // safe integer rounding
        description: 'Order ' + order.orderNo
    };

    // Manual capture must only be requested for methods that actually
    // support it. Sending "capture": "manual" for a method without authorize-then-
    // capture support (iDEAL, bank transfer, most BNPL...) is rejected or silently
    // ignored by MSP and leaves the merchant with an order that can never be
    // captured from either side. The site preference is the merchant's INTENT; the
    // method's own capability — read from the MSP API at sync time and stored on
    // the MSPPaymentMethod Custom Object — decides whether it can be honoured.
    var manualCapture = Site.getCurrent().getCustomPreferenceValue('Multisafepay_ManualCapture');
    if (manualCapture === true && gatewaySupportsManualCapture(gateway)) {
        this.transactionData.capture = 'manual';
    }
}

module.exports = transactionData;
