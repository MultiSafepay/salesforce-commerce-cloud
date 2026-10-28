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
function Handle(giftCertID, currentBasket) {
    var GiftCertificateMgr = require('dw/order/GiftCertificateMgr'); 
    var Transaction = require('dw/system/Transaction');
    var PaymentInstrument = require('dw/order/PaymentInstrument');
    try {
        var giftCert = GiftCertificateMgr.getGiftCertificateByCode(giftCertID);
        var isValid = giftCert.getStatus();
        var isEnabled = giftCert.isEnabled();
        if (isEnabled && (isValid === 1 || isValid === 2)) {
            //GC is valid and has a balance
            var balance = giftCert.getBalance();
            //check if this GC is already in the instrument. If so, delete and readd 
            var paymentInstruments = currentBasket.getPaymentInstruments(
                PaymentInstrument.METHOD_GIFT_CERTIFICATE
            );
            collections.forEach(paymentInstruments, function (item) {
                if (item.giftCertificateCode == giftCertID) {
                    currentBasket.removePaymentInstrument(item);
                }
            });

            //check if order total is greater than the gc balance. if so, only apply the order total
            if (currentBasket.totalGrossPrice.value > balance.value) {
                Transaction.begin();
                    var paymentInstrument = currentBasket.createPaymentInstrument(
                        PaymentInstrument.METHOD_GIFT_CERTIFICATE, balance
                    );
                    paymentInstrument.setGiftCertificateCode(giftCertID);
                Transaction.commit();
            } else {
                Transaction.begin();
                    var paymentInstrument = currentBasket.createPaymentInstrument(
                        PaymentInstrument.METHOD_GIFT_CERTIFICATE, currentBasket.totalGrossPrice
                    );
                    paymentInstrument.setGiftCertificateCode(giftCertID);
                Transaction.commit();
            }
            return {
                error: false,
                giftCert: giftCert
            };
        } else if (isValid == 3) {
            //GC is already redeemed
            var errors = [];
            errors.push(Resource.msg('error.payment.processor.gc.redeemed', 'checkout', null));
            return { fieldErrors: [], serverErrors: errors, error: true };
        } else {
            var errors = [];
            errors.push(Resource.msg('error.payment.processor.gc.invalid', 'checkout', null));
            return { fieldErrors: [], serverErrors: errors, error: true };
        }
    } catch (e){
        var errors = [];
        errors.push(Resource.msg('error.payment.processor.not.supported', 'checkout', null));
        return { fieldErrors: [], serverErrors: errors, error: true };
    }
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
    var GiftCertificateMgr = require('dw/order/GiftCertificateMgr'); 
    var Transaction = require('dw/system/Transaction');
    var BasketMgr = require('dw/order/BasketMgr');
    var currentBasket = BasketMgr.getCurrentBasket();
    Transaction.begin();
        var redemption = GiftCertificateMgr.redeemGiftCertificate(paymentInstrument); 
    Transaction.commit();
    if (redemption.message == "OK") {
        //remove from this customers account once redeemed
        return {
            error: false
        }
    } else {
        Transaction.begin();
            currentBasket.removePaymentInstrument(paymentInstrument);
            currentBasket.removeAllPaymentInstruments();
        Transaction.commit();
        var errors = [];
        errors.push(Resource.msg(redemption.message, 'checkout', null));
        return { fieldErrors: [], serverErrors: errors, error: true };
    }
}

exports.Handle = Handle;
exports.Authorize = Authorize;
