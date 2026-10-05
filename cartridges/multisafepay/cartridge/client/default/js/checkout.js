'use strict';

var processInclude = require('../../../../../app_storefront_base/cartridge/client/default/js/util');

$(document).ready(function () {
    // NOTE: do NOT processInclude msp_checkout here. processInclude invokes
    // every exported function with no arguments, which would call
    // initPaymentComponent() without a gateway ("Gateway must be specified")
    // and capturePaymentData() prematurely. msp_checkout self-initialises via
    // its own $(document).ready and is consumed as a module by checkout.js.
    processInclude(require('./checkout/giftCard'));
    processInclude(require('./checkout/checkout'));
});
