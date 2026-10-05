'use strict';

var collections = require('*/cartridge/scripts/util/collections');

var PaymentInstrument = require('dw/order/PaymentInstrument');
var Resource = require('dw/web/Resource');
var Transaction = require('dw/system/Transaction');

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
        var paymentInstrument = currentBasket.createPaymentInstrument(PaymentInstrument.METHOD_BML, new dw.value.Money(0, currentBasket.currencyCode));

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
function Authorize(orderNumber, paymentInstrument, paymentProcessor) {
    var serverErrors = [];
    var fieldErrors = {};
    var error = false;

    try {
        Transaction.wrap(function () {
            paymentInstrument.paymentTransaction.setTransactionID(orderNumber);
            paymentInstrument.paymentTransaction.setPaymentProcessor(paymentProcessor);
        });
    } catch (e) {
        error = true;
        serverErrors.push(
            Resource.msg('error.technical', 'checkout', null)
        );
    }

    return { fieldErrors: fieldErrors, serverErrors: serverErrors, error: error };
}

exports.Handle = Handle;
exports.Authorize = Authorize;
