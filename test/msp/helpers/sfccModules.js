'use strict';

/**
 * Minimal SFCC module loader for Node-based unit tests.
 *
 * Cartridge code requires two kinds of modules Node cannot resolve:
 *   - `dw/...`            the SFCC API
 *   - cartridge-path lookups written as star-slash-cartridge/...
 *
 * Most of those requires are LAZY (inside functions), so proxyquire — which only
 * intercepts requires made while the module itself is being loaded — cannot see
 * them. Instead we patch Module._load once for the whole test process and serve
 * whatever the current test registered.
 */

var Module = require('module');
var path = require('path');

var registry = Object.create(null);
// Node exposes module resolution only through this internal hook.
/* eslint-disable no-underscore-dangle */
var originalLoad = Module._load;
var patched = false;

/** @returns {void} */
function patch() {
    if (patched) { return; }
    patched = true;
    Module._load = function (request, parent, isMain) {
        if (Object.prototype.hasOwnProperty.call(registry, request)) {
            return registry[request];
        }
        if (request.indexOf('dw/') === 0 || request.indexOf('*/') === 0) {
            throw new Error(
                'Test did not register a stub for "' + request + '". ' +
                'Add it via sfccModules.register().'
            );
        }
        return originalLoad(request, parent, isMain);
    };
}

/**
 * Registers (or replaces) a stub module.
 * @param {string} request - the exact require() string used by the cartridge
 * @param {*} exports - the value require() must return
 * @returns {void}
 */
function register(request, exports) {
    patch();
    registry[request] = exports;
}

/**
 * Registers many stubs at once.
 * @param {Object} map - {requestString: exports}
 * @returns {void}
 */
function registerAll(map) {
    Object.keys(map).forEach(function (key) { register(key, map[key]); });
}

/**
 * Clears every stub. Call in beforeEach so tests cannot leak into each other.
 * @returns {void}
 */
function reset() {
    Object.keys(registry).forEach(function (key) { delete registry[key]; });
}

/**
 * Loads a cartridge module fresh, bypassing Node's module cache so each test
 * observes the stubs registered for it.
 * @param {string} relativePath - path from the repository root
 * @returns {*} the module's exports
 */
function loadCartridgeModule(relativePath) {
    patch();
    var absolute = path.resolve(__dirname, '../../..', relativePath);
    delete require.cache[require.resolve(absolute)];
    return require(absolute);
}

/**
 * A no-op Logger accepted by `require('dw/system/Logger')`.
 * @returns {Object} logger stub
 */
function loggerStub() {
    var noop = function () {};
    var logger = { info: noop, warn: noop, error: noop, debug: noop };
    logger.getLogger = function () { return logger; };
    return logger;
}

/* eslint-enable no-underscore-dangle */

module.exports = {
    register: register,
    registerAll: registerAll,
    reset: reset,
    loadCartridgeModule: loadCartridgeModule,
    loggerStub: loggerStub
};
