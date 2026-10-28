'use strict';

var test = require('node:test');
var assert = require('node:assert');
var sfcc = require('./helpers/sfccModules');

var CONTROLLER = 'cartridges/bm_multisafepay/cartridge/controllers/MultisafepaySettings.js';

/**
 * An XMLStreamWriter stub that accumulates the produced markup so the test can
 * assert on the payment-methods.xml handed to the import job.
 * @param {Object} sink - {xml: ''} accumulator
 * @returns {Object} writer stub
 */
function xmlWriterStub(sink) {
    /* eslint-disable no-param-reassign */
    var open = [];
    var pending = null; // {name, attrs, empty} - a start tag not yet flushed

    /**
     * Writes out a buffered start tag once its attributes are known.
     * @returns {void}
     */
    function flush() {
        if (!pending) { return; }
        sink.xml += '<' + pending.name + pending.attrs + (pending.empty ? '/>' : '>');
        if (!pending.empty) { open.push(pending.name); }
        pending = null;
    }

    return {
        writeStartDocument: function () {},
        writeDefaultNamespace: function () {},
        writeStartElement: function (name) { flush(); pending = { name: name, attrs: '', empty: false }; },
        writeEmptyElement: function (name) { flush(); pending = { name: name, attrs: '', empty: true }; },
        writeAttribute: function (name, value) {
            if (pending) { pending.attrs += ' ' + name + '="' + value + '"'; }
        },
        writeCharacters: function (text) { flush(); sink.xml += text; },
        writeEndElement: function () { flush(); sink.xml += '</' + open.pop() + '>'; },
        writeEndDocument: function () { flush(); },
        close: function () { flush(); }
    };
    /* eslint-enable no-param-reassign */
}

/**
 * Loads the BM controller with every platform dependency stubbed and returns the
 * captured SyncPaymentMethods route handler.
 * @param {Object} opts - {apiMethods, existingCos}
 * @returns {Object} {run, sink, cos}
 */
function loadSyncRoute(opts) {
    var options = opts || {};
    var routes = {};
    var sink = { xml: '' };
    var cos = options.existingCos || {};

    /**
     * Creates a Custom Object stub with the full attribute set defined.
     * @param {string} key - the gateway id
     * @returns {Object} CO stub
     */
    function makeCo(key) {
        var custom = { gatewayId: key };
        return {
            custom: custom,
            // Reproduces the platform: describe() reports defined attributes as
            // undefined. The code under test must not depend on it.
            describe: function () {
                return { getCustomAttributeDefinition: function () { return null; } };
            }
        };
    }

    sfcc.reset();

    // The real mapper is the subject of these tests, so load the helper for real.
    // Its own load-time dependencies must be registered before requiring it.
    sfcc.registerAll({
        '*/cartridge/config/apiConfig': {},
        'dw/util/HashMap': function () {},
        'dw/system/Logger': sfcc.loggerStub()
    });
    var realHelper = sfcc.loadCartridgeModule(
        'cartridges/multisafepay/cartridge/scripts/helpers/multisafepayHelper.js'
    );
    var probes = [];

    sfcc.registerAll({
        server: {
            get: function (name, _mw, handler) { routes[name] = handler || _mw; },
            post: function (name, _mw, handler) { routes[name] = handler || _mw; },
            middleware: { https: function () {} },
            exports: function () { return {}; }
        },
        'dw/system/Transaction': { wrap: function (fn) { return fn(); } },
        'dw/object/CustomObjectMgr': {
            getCustomObject: function (type, key) { return cos[key] || null; },
            createCustomObject: function (type, key) { cos[key] = makeCo(key); return cos[key]; },
            getAllCustomObjects: function () {
                var keys = Object.keys(cos);
                var i = 0;
                return {
                    hasNext: function () { return i < keys.length; },
                    next: function () { return cos[keys[i++]]; },
                    close: function () {}
                };
            }
        },
        '*/cartridge/scripts/middleware/csrf': { generateToken: function () {} },
        'dw/system': { Site: { getCurrent: function () {
            return {
                getID: function () { return 'RefArch'; },
                getCustomPreferenceValue: function () { return null; }
            };
        } } },
        'dw/system/Logger': sfcc.loggerStub(),
        '*/cartridge/scripts/helpers/multisafepayHelper': {
            mapApiPaymentMethod: realHelper.mapApiPaymentMethod,
            getActiveApiKey: function () { return 'key'; },
            getApplicablePaymentMethods: function (dto) {
                probes.push(dto);
                return options.apiResponse || { data: options.apiMethods || [] };
            }
        },
        'dw/io/File': (function () {
            /**
             * @param {string} path - the file path
             */
            function File(path) { this.path = path; }
            File.IMPEX = '/impex';
            File.prototype.exists = function () { return true; };
            File.prototype.mkdirs = function () { return true; };
            File.prototype.remove = function () { return true; };
            File.prototype.zip = function () { return true; };
            return File;
        }()),
        'dw/io/FileWriter': function () { this.close = function () {}; },
        'dw/io/XMLStreamWriter': function () { return xmlWriterStub(sink); },
        'dw/net/HTTPClient': function () {
            this.open = function () {};
            this.setRequestHeader = function () {};
            this.send = function () { this.statusCode = 500; this.text = ''; };
        },
        'dw/system/System': { getInstanceHostname: function () { return 'test.demandware.net'; } },
        'dw/crypto/Encoding': { toBase64: function () { return 'x'; } },
        'dw/util/Bytes': function () {}
    });

    sfcc.loadCartridgeModule(CONTROLLER);

    /**
     * Invokes the captured SyncPaymentMethods handler.
     * @returns {Object} the JSON payload the route responded with
     */
    function run() {
        var payload = null;
        var res = { json: function (data) { payload = data; } };
        var handler = routes.SyncPaymentMethods;
        handler({ body: '{}' }, res, function () {});
        return payload;
    }

    return { run: run, sink: sink, cos: cos, probes: probes };
}

test.describe('SyncPaymentMethods - Custom Objects', function () {
    test.it('stores no country restriction for a method with allowed_countries: []', function () {
        var ctx = loadSyncRoute({
            apiMethods: [{ id: 'MASTERCARD', name: 'MasterCard', allowed_countries: [] }]
        });
        var result = ctx.run();
        assert.strictEqual(result.success, true);
        assert.strictEqual(ctx.cos.MASTERCARD.custom.countries, '');
    });

    test.it('stores the exact country list reported by the API', function () {
        var ctx = loadSyncRoute({
            apiMethods: [{ id: 'AFTERPAY', name: 'Riverty', allowed_countries: ['NL'] }]
        });
        ctx.run();
        assert.strictEqual(ctx.cos.AFTERPAY.custom.countries, 'NL');
    });

    test.it('fetches the catalogue once, without probing country by country', function () {
        var ctx = loadSyncRoute({ apiMethods: [{ id: 'IDEAL' }] });
        ctx.run();
        assert.strictEqual(ctx.probes.length, 1, 'expected exactly one catalogue call');
        assert.strictEqual(ctx.probes[0].country, undefined, 'the sync must not pre-filter by country');
        assert.strictEqual(ctx.probes[0].currency, undefined, 'the sync must not pre-filter by currency');
    });

    test.it('aborts without wiping the catalogue when MSP returns an error', function () {
        var ctx = loadSyncRoute({
            existingCos: {},
            apiResponse: { error: true, statusCode: 401, error_info: 'Invalid API key' }
        });
        var result = ctx.run();
        assert.strictEqual(result.success, false);
        assert.ok(result.errorMessage.indexOf('401') > -1, result.errorMessage);
    });

    test.it('aborts when MSP returns an empty catalogue', function () {
        var ctx = loadSyncRoute({ apiMethods: [] });
        var result = ctx.run();
        assert.strictEqual(result.success, false);
    });
});

test.describe('SyncPaymentMethods - generated payment-methods.xml', function () {
    test.it('emits an EMPTY countries element so a stale restriction is cleared', function () {
        // Regression guard: MSP_MASTERCARD had been imported with 6 countries and
        // no NL. Omitting <countries> would leave that assignment in place and the
        // method would stay hidden for Dutch shoppers.
        var ctx = loadSyncRoute({
            apiMethods: [{ id: 'MASTERCARD', name: 'MasterCard', allowed_countries: [] }]
        });
        ctx.run();
        assert.ok(
            /<countries>\s*<\/countries>/.test(ctx.sink.xml),
            'expected an empty <countries> element, got: ' + ctx.sink.xml
        );
    });

    test.it('emits one country element per allowed country when restricted', function () {
        var ctx = loadSyncRoute({
            apiMethods: [{ id: 'AFTERPAY', name: 'Riverty', allowed_countries: ['NL', 'BE'] }]
        });
        ctx.run();
        assert.ok(ctx.sink.xml.indexOf('<country country-code="NL"/>') > -1, ctx.sink.xml);
        assert.ok(ctx.sink.xml.indexOf('<country country-code="BE"/>') > -1, ctx.sink.xml);
    });

    test.it('prefixes the SFCC method id with MSP_', function () {
        var ctx = loadSyncRoute({ apiMethods: [{ id: 'IDEAL', name: 'iDEAL' }] });
        ctx.run();
        assert.ok(ctx.sink.xml.indexOf('method-id="MSP_IDEAL"') > -1, ctx.sink.xml);
    });
});
