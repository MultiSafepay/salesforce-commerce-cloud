'use strict';
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');
var transactionDataModel = require('*/cartridge/models/transactionData');
var Locale = require('dw/util/Locale');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();
var Status = require('dw/system/Status');

function authorize(order, paymentDetails) {
    var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
    var currentLocale = Locale.getLocale(order.getCustomerLocaleID());
    var transactionData = new transactionDataModel(order, currentLocale.getID(), '', order.getTotalGrossPrice().getValue());
    transactionData.transactionData.type = 'paymentlink';
    var result = multisafepayHelper.createOrder(clientKey, transactionData);
    if (!result.success) {
        var Logger = require('dw/system/Logger');
        Logger.error('Multisafepay Authorize failed: ' + JSON.stringify(result.data));
        return new Status(Status.ERROR);
    }
    return new Status(Status.OK);
}

module.exports = {
  authorize: authorize
};