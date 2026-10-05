'use strict';

var collections = require('*/cartridge/scripts/util/collections');

var PaymentInstrument = require('dw/order/PaymentInstrument');
var Resource = require('dw/web/Resource');
var Transaction = require('dw/system/Transaction');
var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');
var transactionDataModel = require('*/cartridge/models/transactionData');
var Locale = require('dw/util/Locale');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();

/**
 * Verifies that entered credit card information is a valid card. If the information is valid a
 * credit card payment instrument is created
 * @param {dw.order.Basket} basket Current users's basket
 * @param {Object} paymentInformation - the payment information
 * @param {string} paymentMethodID - paymentmethodID
 * @param {Object} req the request object
 * @return {Object} returns an error object
 */
function Handle(basket, paymentInformation, paymentMethodID, req) {
    var currentBasket = basket;
    var serverErrors = [];

    Transaction.wrap(function () {
        var paymentInstruments = currentBasket.getPaymentInstruments();

        collections.forEach(paymentInstruments, function (item) {
            if(item.paymentMethod!='GIFT_CERTIFICATE'){
                currentBasket.removePaymentInstrument(item);
            }
        });

        var paymentAmount = currentBasket.totalGrossPrice;
        var paymentInstrument = currentBasket.createPaymentInstrument('MultiSafepayPayment', paymentAmount);
        paymentInstrument.custom.Multisafepay_Gateway = paymentInformation.gateway;
    });

    return { fieldErrors: false, serverErrors: serverErrors, error: false };
}

/**
 * Authorizes a payment using a credit card. Customizations may use other processors and custom
 *      logic to authorize credit card payment.
 * @param {number} orderNumber - The current order's number
 * @param {dw.order.PaymentInstrument} paymentInstrument -  The payment instrument to authorize
 * @param {dw.order.PaymentProcessor} paymentProcessor -  The payment processor of the current
 *      payment method
 * @return {Object} returns an error object
 */
function Authorize(order, paymentInstrument, paymentProcessor, gateway, mspPaymentData) {
    var serverErrors = [];
    var fieldErrors = {};
    var error = false;

    var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
    var currentLocale = Locale.getLocale(order.getCustomerLocaleID());
    var transactionData = new transactionDataModel(order, currentLocale.getID(), gateway, paymentInstrument.paymentTransaction.getAmount().getValue());

    // Attach payment_data from Payment Component if provided (direct mode)
    var isDirect = false;
    if (mspPaymentData) {
        try {
            transactionData.transactionData.payment_data = JSON.parse(mspPaymentData);
            transactionData.transactionData.type = 'direct';
            isDirect = true;
            Logger.info('Direct mode: payment_data attached, gateway={0}', gateway);
        } catch (e) {
            Logger.warn('Failed to parse payment_data: {0}', e.message);
        }
    }

    var result;
    try {
        result = multisafepayHelper.createOrder(clientKey, transactionData);
    } catch (e) {
        Logger.error('createOrder threw exception: {0}', e.message);
        result = { success: false, statusMessage: e.message };
    }

    // Fallback: if direct mode fails for any reason, retry as redirect
    if (!result.success && isDirect) {
        Logger.warn('Direct mode failed for gateway {0} (error: {1}), falling back to redirect', gateway, result.statusMessage || 'unknown');
        delete transactionData.transactionData.payment_data;
        transactionData.transactionData.type = 'redirect';
        try {
            result = multisafepayHelper.createOrder(clientKey, transactionData);
        } catch (e2) {
            Logger.error('Redirect fallback also threw: {0}', e2.message);
            result = { success: false, statusMessage: e2.message };
        }
    }

    var payment_url;

    if(result.success){
        payment_url = result.data.data.payment_url;
        try {
            Transaction.wrap(function () {
                paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);
                if(paymentInstrument.paymentTransaction.custom){
                    paymentInstrument.paymentTransaction.custom.Multisafepay_log = JSON.stringify(result.data, null, 2);
                    paymentInstrument.paymentTransaction.custom.Multisafepay_Gateway = gateway;
                }
            });
        } catch (e) {
            // Non-critical: API call succeeded and payment_url is valid.
            // The webhook may have locked the order concurrently - don't fail the checkout.
            Logger.warn('Could not write transaction log (likely webhook race condition): {0}', e.message);
        }
    }else{
        Logger.error('Multisafepay create order error: ' + result.statusMessage);
        error = true;
        serverErrors.push(
            Resource.msg('error.technical', 'checkout', null)
        );
    }

    return { fieldErrors: fieldErrors, serverErrors: serverErrors, error: error, redirectUrl: payment_url };
}

exports.Handle = Handle;
exports.Authorize = Authorize;
