'use strict';

/**
 * Guards for behaviour that lives in templates and form definitions, which the
 * unit tests above cannot exercise. They are deliberately narrow: each one pins
 * a specific QA finding so a future edit cannot quietly reintroduce it.
 */

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.resolve(__dirname, '../..');

/**
 * @param {string} relativePath - path from the repository root
 * @returns {string} file contents
 */
function read(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

var PAYMENT_OPTIONS = 'cartridges/multisafepay/cartridge/templates/default/checkout/billing/paymentOptions/Multisafepay.isml';
var ADDRESS_FORM = 'cartridges/multisafepay/cartridge/forms/default/address.xml';
var FORMS_PROPERTIES = 'cartridges/multisafepay/cartridge/templates/resources/forms.properties';

test.describe('checkout payment options template (REQ-1.1.4 / REQ-1.4.4)', function () {
    test.it('derives the country from the BILLING address, not the shipping address', function () {
        var isml = read(PAYMENT_OPTIONS);
        var billingIndex = isml.indexOf('currentBasket.billingAddress.countryCode');
        var shippingIndex = isml.indexOf('shippingAddress.countryCode');
        assert.ok(billingIndex > -1, 'the billing address country must be read');
        assert.ok(
            shippingIndex === -1 || billingIndex < shippingIndex,
            'the billing address must be consulted before the shipping address'
        );
    });

    test.it('never discloses why online payment is unavailable', function () {
        var isml = read(PAYMENT_OPTIONS);
        var rendered = isml.slice(isml.indexOf('<div class="tab-pane'));
        [/API key/i, /invalid key/i, /not configured/i, /401/, /403/].forEach(function (pattern) {
            assert.ok(
                !pattern.test(rendered),
                'customer-facing markup must not mention ' + pattern + ': it leaks the integration state'
            );
        });
    });

    test.it('renders the customer-facing errors from the resource bundle', function () {
        var isml = read(PAYMENT_OPTIONS);
        assert.ok(isml.indexOf("Resource.msg('msp.error.unavailable', 'multisafepay'") > -1);
        assert.ok(isml.indexOf("Resource.msg('msp.error.nomethods', 'multisafepay'") > -1);
    });

    test.it('ships the resource bundle the template resolves', function () {
        var properties = read('cartridges/multisafepay/cartridge/templates/resources/multisafepay.properties');
        assert.ok(/^msp\.error\.unavailable=.+/m.test(properties));
        assert.ok(/^msp\.error\.nomethods=.+/m.test(properties));
        // Only the values matter; the file's comments explain the rule itself.
        var values = properties.split(/\r?\n/)
            .filter(function (line) { return line.indexOf('#') !== 0 && line.indexOf('=') > -1; })
            .join(' ');
        assert.ok(!/API key/i.test(values), 'the shopper-facing text must stay generic');
        assert.ok(!/multisafepay/i.test(values), 'the shopper-facing text must not name the provider');
    });
});

test.describe('address form country list (REQ-1.1.4)', function () {
    var REQUIRED = ['NL', 'DE', 'IT', 'BE', 'FR', 'ES', 'AT', 'PT', 'PL', 'DK', 'SE', 'NO', 'GB', 'IE', 'FI'];

    test.it('offers the markets MultiSafepay payment methods are restricted to', function () {
        var xml = read(ADDRESS_FORM);
        REQUIRED.forEach(function (code) {
            assert.ok(
                xml.indexOf('value="' + code + '"') > -1,
                code + ' must be selectable, otherwise its payment methods are unreachable'
            );
        });
    });

    test.it('defines a label for every country option', function () {
        var xml = read(ADDRESS_FORM);
        var base = read('cartridges/app_storefront_base/cartridge/templates/resources/forms.properties');
        var overrides = read(FORMS_PROPERTIES);
        var labels = xml.match(/label="(select\.option\.country\.[^"]+)"/g) || [];
        assert.ok(labels.length > 10, 'expected the extended country list');
        labels.forEach(function (match) {
            var key = match.replace('label="', '').replace('"', '');
            var defined = base.indexOf('\n' + key + '=') > -1
                || base.indexOf(key + '=') === 0
                || overrides.indexOf('\n' + key + '=') > -1;
            assert.ok(defined, 'missing resource key: ' + key);
        });
    });
});

test.describe('BM order payment detail (REQ-2.2.2)', function () {
    var TEMPLATE = 'cartridges/bm_multisafepay/cartridge/templates/default/order/PaymentInstrumentInfo_MultiSafepayPayment.isml';

    test.it('does not hide Capture merely because the financial status is unknown', function () {
        var isml = read(TEMPLATE);
        assert.ok(
            isml.indexOf("mspFinancialStatus === 'initialized'") === -1,
            'the allow-list on the financial status hid the button for orders with no stored status'
        );
        assert.ok(isml.indexOf('mspAlreadySettled') > -1, 'expected the deny-list on settled states');
    });

    test.it('decides manual capture from the order, not only from configuration', function () {
        // In the Business Manager order view the site preference and the
        // site-scoped Custom Object read as empty rather than failing, which
        // silently hid the button on order 00007905 — a Visa authorized with
        // capture=manual and capture_remain=8469 on the MultiSafepay side.
        var isml = read(TEMPLATE);
        assert.ok(isml.indexOf('mspCaptureProvenByOrder') > -1,
            'expected the capture-expiry proof carried by the order itself');
        var decision = isml.slice(isml.indexOf('var mspShowCapture ='));
        decision = decision.slice(0, decision.indexOf('\n'));
        assert.ok(
            decision.indexOf('mspManualCapture') === -1 && decision.indexOf('mspSupportsCapture') === -1,
            'configuration must not be able to veto the button on its own: ' + decision
        );
    });

    test.it('records the capture decision where log settings cannot swallow it', function () {
        // The multisafepay custom log category is off on the QA sandbox, so every
        // Logger call there is discarded. The diagnosis has to survive that.
        var isml = read(TEMPLATE);
        assert.ok(isml.indexOf('<!-- ${mspCaptureDiagnostics} -->') > -1,
            'expected the decision rendered as an HTML comment');
        ['prefManualCapture', 'coSupportsCapture', 'showCapture', 'captureExpiry']
            .forEach(function (field) {
                assert.ok(isml.indexOf(field) > -1, 'diagnostics must carry ' + field);
            });
    });

    test.it('reads transaction attributes directly, not behind a describe() guard', function () {
        // describe().getCustomAttributeDefinition() reported Multisafepay_
        // FinancialStatus and _CaptureExpiry as undefined on orders that carry
        // them, which emptied both values and hid the button.
        var isml = read(TEMPLATE);
        assert.ok(isml.indexOf('getCustomAttributeDefinition') === -1,
            'the describe() guard must not come back');
        assert.ok(isml.indexOf('function mspRead(') > -1,
            'expected the tolerant direct read');
    });

    test.it('never compares a raw custom attribute with strict equality', function () {
        // SFCC returns custom string attributes as Java String objects. `attr ===
        // 'completed'` is therefore false no matter what the text says, which is
        // what made awaitingCapture false on order 00008001 — and what rendered
        // the status in grey instead of green throughout the fourth QA round.
        var isml = read(TEMPLATE);
        var raw = isml.match(/mspStatus\s*===/g) || [];
        assert.strictEqual(raw.length, 0,
            'compare mspStatusText, the normalised copy, not the raw attribute');
        assert.ok(isml.indexOf('var mspStatusText = String(') > -1,
            'expected the raw value to be normalised once');
    });

    test.it('shows the capture expiry to the merchant', function () {
        var isml = read(TEMPLATE);
        assert.ok(isml.indexOf('Capture Expiry') > -1);
        assert.ok(isml.indexOf('mspCaptureExpiry') > -1);
    });

    test.it('declares the capture expiry attribute in the metadata', function () {
        var meta = read('metadata/site-import/meta/system-objecttype-extensions.xml');
        assert.ok(meta.indexOf('attribute-id="Multisafepay_CaptureExpiry"') > -1);
    });
});

test.describe('obsolete configuration is gone (REQ-1.1.4)', function () {
    test.it('no longer exposes the Target Countries preference', function () {
        var meta = read('metadata/site-import/meta/system-objecttype-extensions.xml');
        assert.ok(
            meta.indexOf('Multisafepay_TargetCountries') === -1,
            'the per-country probe is gone; leaving the preference behind only confuses the merchant'
        );
    });

    test.it('the sync no longer carries a hardcoded country list', function () {
        var controller = read('cartridges/bm_multisafepay/cartridge/controllers/MultisafepaySettings.js');
        assert.ok(controller.indexOf('targetCountries') === -1);
        assert.ok(controller.indexOf('gatewayCountries') === -1);
    });
});
