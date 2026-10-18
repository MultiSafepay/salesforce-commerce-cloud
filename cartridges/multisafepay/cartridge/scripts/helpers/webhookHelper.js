"use strict";

var COHelpers = require('*/cartridge/scripts/checkout/checkoutHelpers');
var Encoding = require('dw/crypto/Encoding');
var Mac = require('dw/crypto/Mac');
var Order = require('dw/order/Order');
var OrderMgr = require('dw/order/OrderMgr');
var StringUtils = require('dw/util/StringUtils');
var Status = require('dw/system/Status');
var Transaction = require('dw/system/Transaction');
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();
var Logger = require('dw/system/Logger').getLogger('multisafepay', 'MSP');

/**
 * Returns true when the object's type defines the given custom attribute.
 * Prevents "Unknown dynamic property" when metadata has not been imported yet.
 * Never throws.
 * @param {dw.object.ExtensibleObject} extObj - object to inspect
 * @param {string} attrId - custom attribute id
 * @returns {boolean} whether the attribute is defined
 */
function txnDefines(extObj, attrId) {
  try {
    var def = extObj.describe();
    return !!(def && def.getCustomAttributeDefinition(attrId));
  } catch (e) {
    return false;
  }
}

function encryptThisString(payload) {
  try {
    //get api key from custom preference
    var macSHA512 = new Mac(Mac.HMAC_SHA_512);
    var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
    var merchantSignature = Encoding.toHex(macSHA512.digest(payload, clientKey));
    return merchantSignature;
  }catch (e) {
    var Logger = require('dw/system/Logger');
    Logger.error('Error encrypting string: ' + e.message);
    return null;
  }
}

function checkGivenCredentials(baHeader, timestamp, body) {
  if (baHeader) {
    var credentials = StringUtils.decodeBase64(baHeader);
    var values = credentials.split(':');
    if(timestamp == values[0]){
      var stringConcatenated = timestamp + ':' + body;
      var encryptedString = encryptThisString(stringConcatenated);
      if(encryptedString && encryptedString === values[1]){
        return true;
      }
    }
  }
  return false;
}

function check(request) {
  var baHeader = request.httpHeaders.auth;
  if (!(baHeader)) {
    return false;
  }
  return checkGivenCredentials(baHeader, request.querystring.timestamp, request.httpParameterMap.requestBodyAsString);
}

/**
 * Ensures the MultiSafepay payment transaction on an order has a payment
 * processor assigned. Prevents the "The payment processor is unknown" state.
 * Must be called inside a transaction.
 * @param {dw.order.Order} order - the order to fix up
 */
function ensurePaymentProcessor(order) {
  var PaymentMgr = require('dw/order/PaymentMgr');
  var instruments = order.getPaymentInstruments('MultiSafepayPayment');
  if (!instruments || instruments.length === 0) {
    return;
  }
  var method = PaymentMgr.getPaymentMethod('MultiSafepayPayment');
  var processor = method ? method.getPaymentProcessor() : null;
  if (!processor) {
    Logger.warn('[Webhook] MultiSafepayPayment method has no payment processor configured for order {0}', order.orderNo);
    return;
  }
  for (var i = 0; i < instruments.length; i++) {
    var txn = instruments[i].paymentTransaction;
    if (txn && !txn.getPaymentProcessor()) {
      txn.setPaymentProcessor(processor);
      Logger.info('[Webhook] Assigned missing payment processor {0} to order {1}', processor.ID, order.orderNo);
    }
  }
}

/**
 * Places the SFCC order and sets its payment status.
 * @param {Object} notificationData - webhook notification payload
 * @param {boolean} markPaid - when true set PAYMENT_STATUS_PAID (captured/settled);
 *        when false the order is placed but left NOTPAID (authorized/pending — used
 *        for BNPL "uncleared", where the amount is captured later at shipment).
 *        Without placing on 'uncleared' a completed Riverty/BNPL
 *        authorization would never become a successful SFCC order.
 */
function confirmOrder(notificationData, markPaid) {
  var settle = markPaid !== false; // default true (backward compatible with completed/shipped)
  if (notificationData.order_id) {
    var order = OrderMgr.getOrder(notificationData.order_id);
    if (!order) return;

    // Place order if still in CREATED or CANCELLED status
    if (order.status.value === Order.ORDER_STATUS_CREATED || order.status.value === Order.ORDER_STATUS_FAILED) {
      try {
          Transaction.begin();
            var placeOrderStatus = OrderMgr.placeOrder(order);
            if (placeOrderStatus === Status.ERROR) {
                throw new Error();
            }
          Transaction.commit();
          Logger.info('[Webhook] Order {0} placed (markPaid={1}, status={2})', notificationData.order_id, settle, notificationData.status);
      } catch (e) {
          Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
          Logger.error('[Webhook] Failed to place order {0}: {1}', notificationData.order_id, e.message);
          return;
      }
    }

    Transaction.wrap(function () {
        // settle → PAID (completed/shipped); otherwise leave as authorized/pending.
        order.setPaymentStatus(settle ? Order.PAYMENT_STATUS_PAID : Order.PAYMENT_STATUS_NOTPAID);
        if (settle) {
            order.setExportStatus(Order.EXPORT_STATUS_READY);
        }
        // Defensively ensure the MSP payment transaction has a
        // payment processor assigned. A missing processor is what surfaces as
        // "The payment processor is unknown" and can leave the order stuck as
        // Failed even though MSP reports the payment completed.
        ensurePaymentProcessor(order);
    });

    if (order.getCustomerEmail()) {
        COHelpers.sendConfirmationEmail(order, order.customerLocaleID);
    }
  }
}

function cancelOrder(notificationData) {
  if (notificationData.order_id) {
    var order = OrderMgr.getOrder(notificationData.order_id);
    if (!order) {
      Logger.warn('[Webhook] cancelOrder: order {0} not found', notificationData.order_id);
      return;
    }
    try {
      Transaction.wrap(function () { OrderMgr.failOrder(order, true); });
    } catch (e) {
      Logger.error('Error cancelling order: ' + e.message);
    }
  }
}

/**
 * Handles refund notifications from MSP.
 * Updates the SFCC payment status only when the refund is actually processed (not reserved).
 * @param {Object} notificationData - webhook notification payload
 */
function handleRefund(notificationData) {
  if (notificationData.order_id) {
    var order = OrderMgr.getOrder(notificationData.order_id);
    if (!order) return;

    Transaction.wrap(function () {
      if (notificationData.status === 'refunded') {
        // Full refund completed → payment fully returned.
        order.setPaymentStatus(Order.PAYMENT_STATUS_NOTPAID);
      } else if (notificationData.status === 'partial_refunded') {
        // A partial refund must NOT downgrade the payment status.
        // The order remains PAID; the refunded amount is represented separately
        // via the Multisafepay_AmountRefunded custom attribute (set in notify()).
        order.setPaymentStatus(Order.PAYMENT_STATUS_PAID);
      }
    });

    Logger.info('[Webhook] Refund processed for order {0} - status: {1}, amount_refunded: {2}',
      notificationData.order_id, notificationData.status, notificationData.amount_refunded || 0);
  }
}

function notify(notificationData) {
  if (notificationData.order_id) {
    var order = OrderMgr.getOrder(notificationData.order_id);
    if(order && order.getPaymentInstruments('MultiSafepayPayment').length > 0){
      var paymentInstrument = order.getPaymentInstruments('MultiSafepayPayment')[0];
      if(paymentInstrument && paymentInstrument.paymentTransaction){
        // The method actually used on the MSP hosted page can differ from
        // the one initially selected (e.g. iDEAL selected → paid with Alipay+).
        // MSP reports it in payment_details.type (fallback to payment_method).
        var actualGateway = (notificationData.payment_details && notificationData.payment_details.type)
          || notificationData.payment_method;
        var storedGateway = paymentInstrument.custom.Multisafepay_Gateway;
        var gatewayChanged = actualGateway && actualGateway !== storedGateway;
        Transaction.wrap(function () {
            paymentInstrument.paymentTransaction.custom.Multisafepay_OrderStatus = notificationData.status;
            // MSP reports the financial (transaction) status separately from
            // the order status. For a manual-capture card the order status is
            // 'completed' while the financial status stays 'initialized' until the
            // payment is captured. Store it so the BM order detail can tell an
            // awaiting-capture payment from an already-captured/instant one.
            // Only write when the metadata defines the attribute (checked via
            // describe, never throws) so a pending metadata import cannot break
            // webhook processing / order confirmation.
            if (notificationData.financial_status && txnDefines(paymentInstrument.paymentTransaction, 'Multisafepay_FinancialStatus')) {
              paymentInstrument.paymentTransaction.custom.Multisafepay_FinancialStatus = notificationData.financial_status;
            }
            // The capture deadline. MSP releases the authorization if the
            // payment is not captured before it, so the merchant must see it in the
            // order detail. The field has moved across API shapes, so read every
            // known location. Written only when the metadata defines the attribute.
            var captureExpiry = notificationData.capture_expiry
              || (notificationData.payment_details && notificationData.payment_details.capture_expiry)
              || notificationData.capture_expiry_at;
            if (captureExpiry && txnDefines(paymentInstrument.paymentTransaction, 'Multisafepay_CaptureExpiry')) {
              paymentInstrument.paymentTransaction.custom.Multisafepay_CaptureExpiry = String(captureExpiry);
            }
            // Store the MSP payment_methods breakdown (coupons/gift cards
            // applied on the MSP hosted page + the payment method), so the order
            // detail can show the split even when SFCC has no GIFT_CERTIFICATE
            // instrument (the coupon was applied on the MSP side).
            if (notificationData.payment_methods && notificationData.payment_methods.length
                && txnDefines(paymentInstrument.paymentTransaction, 'Multisafepay_PaymentBreakdown')) {
              paymentInstrument.paymentTransaction.custom.Multisafepay_PaymentBreakdown = JSON.stringify(notificationData.payment_methods);
            }
            if(!paymentInstrument.paymentTransaction.transactionID){
              paymentInstrument.paymentTransaction.setTransactionID(notificationData.transaction_id);
            }
            if(notificationData.amount_refunded > 0){
              paymentInstrument.paymentTransaction.custom.Multisafepay_AmountRefunded = notificationData.amount_refunded / 100;
            }
            // Overwrite the stored gateway everywhere it is read from —
            // the payment instrument (Payment Info / order summary) AND the payment
            // transaction (BM logs) — so no reference to the originally selected
            // method survives once the real method is known.
            if (gatewayChanged) {
              paymentInstrument.custom.Multisafepay_Gateway = actualGateway;
              paymentInstrument.paymentTransaction.custom.Multisafepay_Gateway = actualGateway;
            }
        });
        // Log gateway switch outside the transaction to avoid misleading logs on rollback
        if (gatewayChanged) {
          Logger.info('[Webhook] Payment method overridden for order {0}: {1} → {2} (actual method used)',
            notificationData.order_id, storedGateway || 'N/A', actualGateway);
        }
      }
    }
  }

  try {
    Logger.info('[Webhook] Order {0} - status: {1}', notificationData.order_id, notificationData.status);

    switch (notificationData.status) {
      case 'completed':
        confirmOrder(notificationData);
        break;
      case 'shipped':
        // Payment captured/shipped — ensure order is marked as paid
        confirmOrder(notificationData);
        break;
      case 'refunded':
        handleRefund(notificationData);
        break;
      case 'partial_refunded':
        handleRefund(notificationData);
        break;
      case 'reserved':
        // Refund or capture still pending — only update custom status (done above)
        Logger.info('[Webhook] Order {0} - reserved (pending action)', notificationData.order_id);
        break;
      case 'void':
        cancelOrder(notificationData);
        break;
      case 'expired':
        cancelOrder(notificationData);
        break;
      case 'declined':
        cancelOrder(notificationData);
        break;
      case 'cancelled':
        cancelOrder(notificationData);
        break;
      case 'uncleared':
        // 'uncleared' is the state of an authorized BNPL payment
        // (Riverty/Klarna/Billink/in3) awaiting capture at shipment, as well as a
        // card payment awaiting manual capture. In all these cases the order is
        // valid and must be PLACED (not left as Failed/lost). It is placed as
        // authorized/pending (NOTPAID); a later 'completed'/'shipped' notification
        // settles it to PAID.
        confirmOrder(notificationData, false);
        break;
      case 'initialized':
        // Payment initiated but not completed — no action
        Logger.info('[Webhook] Order {0} - initialized', notificationData.order_id);
        break;
      default:
        Logger.warn('[Webhook] Order {0} - unhandled status: {1}', notificationData.order_id, notificationData.status);
    }

    return {
      success: true
    };
  } catch (e) {
    Logger.error('[Webhook] Error processing order {0}: {1}', notificationData.order_id, e.message);
    return {
      success: false,
      errorMessage: e.message
    };
  }
}

module.exports = {
  check:check,
  notify: notify
};