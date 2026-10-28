"use strict";

var server = require('server');
var csrfProtection = require('*/cartridge/scripts/middleware/csrf');
var dwsystem = require('dw/system');
var currentSite = dwsystem.Site.getCurrent();
var multisafepayHelper = require('*/cartridge/scripts/helpers/multisafepayHelper');

server.get('Start', csrfProtection.generateToken, function (_req, res, next) {
  res.render('multisafepayDashboard/dashboard', {
      transactions: getAllTransactions()
  });
  return next();
});

function getAllTransactions() {
  var clientKey = multisafepayHelper.getActiveApiKey(currentSite);
  return multisafepayHelper.getAllTransactions(clientKey);
}

module.exports = server.exports();