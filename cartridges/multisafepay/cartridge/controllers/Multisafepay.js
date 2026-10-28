'use strict';

/**
 * @namespace Multisafepay
 */

var server = require('server');


var BasketMgr = require('dw/order/BasketMgr');
var OrderModel = require('*/cartridge/models/order');
var Locale = require('dw/util/Locale');
var URLUtils = require('dw/web/URLUtils');
var Transaction = require('dw/system/Transaction');
var StringUtils = require('dw/util/StringUtils');
var PaymentInstrument = require('dw/order/PaymentInstrument');
var Site = require('dw/system/Site');
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');
var webhookHelper = require('*/cartridge/scripts/helpers/webhookHelper');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();
var collections = require('*/cartridge/scripts/util/collections');
var renderTemplateHelper = require('*/cartridge/scripts/renderTemplateHelper');

/**
 * Multisafepay-Get : The Multisafepay-Get endpoint is invoked when clicking on "Checkout" button
 * @name Base/Multisafepay-Get
 * @function
 * @memberof Multisafepay
 * @param {middleware} - server.middleware.https
 * @param {category} - sensitive
 * @param {returns} - json
 * @param {serverfunction} - get
 */
server.get('GetPaymentMethods', server.middleware.https, function (req, res, next) {
    var mspLogger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');
    var currentBasket = BasketMgr.getCurrentBasket();
    if (!currentBasket) {
        res.json({
            redirectUrl: URLUtils.url('Cart-Show').toString(),
            error: true
        });

        return next();
    }

    var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
    if (!clientKey) {
        mspLogger.error('[GetPaymentMethods] No API key configured for current environment.');
        res.json({ success: false, errorMessage: 'Payment methods are temporarily unavailable. Please contact support.' });
        return next();
    }

    var currentLocale = Locale.getLocale(req.locale.id);
    var DTO = {
        apiToken : clientKey,
        country : currentLocale.getCountry(),
        currency: currentBasket.getCurrencyCode(),
        locale: req.locale.id
    };

    var payments;
    try {
        payments = multisafepayHelper.getApplicablePaymentMethods(DTO);
    } catch (e) {
        mspLogger.error('[GetPaymentMethods] Exception: {0}', e.message);
        res.json({ success: false, errorMessage: 'An error occurred loading payment methods. Please try again.' });
        return next();
    }

    if (payments && payments.error) {
        mspLogger.error('[GetPaymentMethods] API error {0}: {1}', payments.statusCode, payments.error_info);
        res.json({ success: false, errorMessage: 'Payment methods could not be loaded. Please try again or contact support.' });
        return next();
    }

    if (payments && payments.data){
        var template= renderTemplateHelper.getRenderedHtml({ payments: payments.data}, 'checkout/billing/paymentOptions/MSPpaymentMethods')
        res.json({
            success: true,
            template: template
        });
    }else{
        res.json({
            success: false,
            errorMessage: 'No payment methods available at this time.'
        });
    }

    return next();
});

/**
 * Multisafepay-GetComponentToken : Generates a short-lived API token for the MSP Payment Component SDK.
 * @name Base/Multisafepay-GetComponentToken
 * @function
 * @memberof Multisafepay
 * @param {middleware} - server.middleware.https
 * @param {category} - sensitive
 * @param {returns} - json
 * @param {serverfunction} - get
 */
server.get('GetComponentToken', server.middleware.https, function (req, res, next) {
    var currentBasket = BasketMgr.getCurrentBasket();
    if (!currentBasket) {
        res.json({ error: true });
        return next();
    }

    var apiKey = multisafepayHelper.getActiveApiKey(currentSite);
    if (!apiKey) {
        var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');
        Logger.error('[GetComponentToken] No API key configured for current environment.');
        res.json({ success: false, error: true, errorMessage: 'Payment component unavailable: API key not configured.' });
        return next();
    }

    var tokenResult = multisafepayHelper.generateApiToken(apiKey);

    if (tokenResult.success) {
        var currentLocale = Locale.getLocale(req.locale.id);
        var environment = currentSite.getCustomPreferenceValue('Multisafepay_Environment') || 'test';

        res.json({
            success: true,
            apiToken: tokenResult.apiToken,
            environment: environment === 'live' ? 'live' : 'test',
            orderData: {
                currency: currentBasket.getCurrencyCode(),
                amount: Math.round(currentBasket.totalGrossPrice.value * 100),
                customer: {
                    locale: req.locale.id.replace('_', '-'),
                    country: currentLocale.getCountry()
                }
            }
        });
    } else {
        res.json({ success: false, error: true, errorMessage: 'Could not generate payment component token. Please try again.' });
    }

    return next();
});

/**
 * Multisafepay-ValidateGift : The Multisafepay-ValidateGift endpoint is invoked when clicking on "Apply" button for Gift Certificates
 * @name Base/Multisafepay-Get
 * @function
 * @memberof Multisafepay
 * @param {middleware} - server.middleware.https
 * @param {category} - sensitive
 * @param {returns} - json
 * @param {serverfunction} - get
 */
server.get('ValidateGift', server.middleware.https, function (req, res, next) {
    var GiftCertificateMgr = require('dw/order/GiftCertificateMgr');
    var giftCert = req.querystring.giftCert ||req.form.giftCert;
    var currentBasket = BasketMgr.getCurrentBasket();
    var certificate = GiftCertificateMgr.getGiftCertificateByCode(giftCert);
    if (currentBasket && giftCert!=null && giftCert!='') {
        if(certificate && certificate.amount.currencyCode == currentBasket.currencyCode && ( certificate.getStatus()==1 || certificate.getStatus()==2 )){
            Transaction.wrap(function () {
                collections.forEach(currentBasket.paymentInstruments, function (item) {
                    if(item.paymentMethod=='GIFT_CERTIFICATE'){
                        currentBasket.removePaymentInstrument(item);
                    }
                });
                var paymentInstrument = currentBasket.createPaymentInstrument('GIFT_CERTIFICATE', new dw.value.Money(certificate.getBalance().value, currentBasket.currencyCode));
                paymentInstrument.setGiftCertificateCode(giftCert);
                var basketModel = new OrderModel(currentBasket, { countryCode: Locale.getLocale(req.locale.id).country, containerView: 'basket' });
                res.json({
                    success: true,
                    giftCardTemplate: renderTemplateHelper.getRenderedHtml({ order: basketModel}, 'checkout/billing/paymentOptions/giftCertificates')
                });
            });
        }else{
            res.json({
                success: false,
                errorMessage: 'There is no valid certificate with the following code: ' + giftCert
            });
        }
    }else{
        res.json({
            success: false,
            errorMessage: 'No basket or gift certificate code'
        });
    }
    return next();
});

/**
 * Multisafepay-RemoveGiftCard : The Multisafepay-RemoveGiftCard endpoint is invoked when clicking on "Remove" button for Gift Certificate
 * @name Base/Multisafepay-Get
 * @function
 * @memberof Multisafepay
 * @param {middleware} - server.middleware.https
 * @param {category} - sensitive
 * @param {returns} - json
 * @param {serverfunction} - get
 */
server.get('RemoveGiftCard', server.middleware.https, function (req, res, next) {
    var currentBasket = BasketMgr.getCurrentBasket();
    if (currentBasket) {
        try {
            Transaction.wrap(function () {
                collections.forEach(currentBasket.paymentInstruments, function (item) {
                    if(item.paymentMethod=='GIFT_CERTIFICATE'){
                        currentBasket.removePaymentInstrument(item);
                    }
                });
                res.json({
                    success: true
                });
            });
        } catch (e) {
            var Logger = require('dw/system/Logger');
            Logger.error('error: '+ e.message);
            res.json({
                success: false,
                errorMessage: e.message
            });
        }
    } else {
        res.json({
            success: false,
            errorMessage: 'An error has occurred. Please contact your administrator.'
        });
    }
    return next();
});

/**
 * Order-Confirm : This endpoint is invoked when the shopper's Order is Placed and Confirmed
 * @name Base/Order-Confirm
 * @function
 * @memberof Order
 * @param {middleware} - consentTracking.consent
 * @param {middleware} - server.middleware.https
 * @param {middleware} - csrfProtection.generateToken
 * @param {querystringparameter} - ID - Order ID
 * @param {querystringparameter} - token - token associated with the order
 * @param {category} - sensitive
 * @param {serverfunction} - get
 */
server.get(
    'Confirm',
    server.middleware.https,
    function (req, res, next) {
        var reportingUrlsHelper = require('*/cartridge/scripts/reportingUrls');
        var OrderMgr = require('dw/order/OrderMgr');
        var Locale = require('dw/util/Locale');
        var Resource = require('dw/web/Resource');

        if (!req.querystring.orderID) {
            res.render('/error', {
                message: Resource.msg('error.confirmation.error', 'confirmation', null)
            });

            return next();
        }

        var order = OrderMgr.getOrder(req.querystring.orderID);

        if (!order) {
            res.render('/error', {
                message: Resource.msg('error.confirmation.error', 'confirmation', null)
            });

            return next();
        }

        // BNPL: verify the payment before showing the
        // confirmation. As a fallback for when the async webhook has not arrived
        // yet, query MSP directly and drive the same notify() logic:
        //  - 'completed'/'shipped' → order placed and PAID;
        //  - 'uncleared'           → BNPL authorized → order placed as pending
        //                            (so a completed Riverty is never shown as Failed);
        //  - anything else         → not a successful payment → back to the cart.
        var Order = require('dw/order/Order');
        if (order.paymentStatus.value !== Order.PAYMENT_STATUS_PAID) {
            var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
            var mspOrder = multisafepayHelper.getOrderStatus(clientKey, order.orderNo);
            var mspStatus = (mspOrder.success && mspOrder.data) ? mspOrder.data.status : null;
            if (mspStatus === 'completed' || mspStatus === 'shipped' || mspStatus === 'uncleared') {
                webhookHelper.notify({
                    order_id: order.orderNo,
                    status: mspStatus,
                    financial_status: mspOrder.data.financial_status,
                    transaction_id: mspOrder.data.transaction_id || order.orderNo,
                    payment_details: mspOrder.data.payment_details,
                    payment_method: mspOrder.data.payment_method,
                    // Forward the capture deadline so it is stored even
                    // when the confirmation beats the async webhook.
                    capture_expiry: mspOrder.data.capture_expiry,
                    payment_methods: mspOrder.data.payment_methods
                });
            } else {
                res.redirect(URLUtils.url('Cart-Show'));
                return next();
            }
        }

        var lastOrderID = Object.prototype.hasOwnProperty.call(req.session.raw.custom, 'orderID') ? req.session.raw.custom.orderID : null;
        if (lastOrderID === req.querystring.ID) {
            res.redirect(URLUtils.url('Home-Show'));
            return next();
        }

        var config = {
            numberOfLineItems: '*'
        };

        var currentLocale = Locale.getLocale(req.locale.id);

        var orderModel = new OrderModel(
            order,
            { config: config, countryCode: currentLocale.country, containerView: 'order' }
        );
        var passwordForm;

        var reportingURLs = reportingUrlsHelper.getOrderReportingURLs(order);

        if (!req.currentCustomer.profile) {
            passwordForm = server.forms.getForm('newPasswords');
            passwordForm.clear();
            res.render('checkout/confirmation/confirmation', {
                order: orderModel,
                returningCustomer: false,
                passwordForm: passwordForm,
                reportingURLs: reportingURLs,
                orderUUID: order.getUUID()
            });
        } else {
            res.render('checkout/confirmation/confirmation', {
                order: orderModel,
                returningCustomer: true,
                reportingURLs: reportingURLs,
                orderUUID: order.getUUID()
            });
        }
        req.session.raw.custom.orderID = req.querystring.ID; // eslint-disable-line no-param-reassign
        return next();
    }
);

/**
 * Order-Cancellation : This endpoint is invoked when the shopper's Order needs to be cancelled
 * @name Base/Order-Cancellation
 * @function
 * @memberof Order
 * @param {middleware} - consentTracking.consent
 * @param {middleware} - server.middleware.https
 * @param {middleware} - csrfProtection.generateToken
 * @param {querystringparameter} - ID - Order ID
 * @param {querystringparameter} - token - token associated with the order
 * @param {category} - sensitive
 * @param {serverfunction} - get
 */
server.get(
    'Cancellation',
    server.middleware.https,
    function (req, res, next) {
        var OrderMgr = require('dw/order/OrderMgr');
        var Resource = require('dw/web/Resource');
        var PaymentMgr = require('dw/order/PaymentMgr');
        var emailHelpers = require('*/cartridge/scripts/helpers/emailHelpers');
        var orderID = req.querystring.orderID;
        var order;

        if(orderID){
            order = OrderMgr.getOrder(orderID);
        }else{
            res.render('/error', {
                message: Resource.msg('error.confirmation.error', 'confirmation', null)
            });
            return next();
        }
        if(order){
            try {
                Transaction.begin();
                    BasketMgr.createBasketFromOrder(order);
                Transaction.commit();
                res.redirect(URLUtils.url('Checkout-Begin'));
            } catch (e) {
                res.redirect(URLUtils.url('Home-Show'));
            }
        }else{
            res.redirect(URLUtils.url('Home-Show'));
        }
        return next();
    }
);

server.post('Webhook', server.middleware.https, function (req, res, next) {
    var order = JSON.parse(req.httpParameterMap.requestBodyAsString);
    var status = webhookHelper.check(req);
    if (!status) {
        res.render('/notifyError');
        return {};
    }
    var Logger = require('dw/system/Logger');
    var notificationResult = webhookHelper.notify(order);
    // The notification body carries customer data: debug level only. The order id and
    // status are already logged at info level by webhookHelper.
    Logger.debug('Notification Result: ' + JSON.stringify(order));
    if (notificationResult.success) {
        res.render('/notify');
    } else {
        res.render('/notifyError', {
            errorMessage: notificationResult.errorMessage
        });
    }
    return next();
});

module.exports = server.exports();
