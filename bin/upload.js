'use strict';

/**
 * Uploads cartridges to a Salesforce B2C Commerce instance over WebDAV.
 *
 *   node bin/upload.js                 uploads multisafepay and bm_multisafepay
 *   node bin/upload.js multisafepay    uploads only the named cartridge(s)
 *
 * Reads `hostname`, `username`, `password` (a WebDAV access key) and `code-version`
 * from dw.json in the project root, or from the file named by the DW_JSON variable. The protocol is the one `dwupload` (used by
 * `sgmf-scripts --uploadCartridge`) follows: zip the cartridge, DELETE the cartridge
 * folder, PUT the zip, POST method=UNZIP, DELETE the zip. Like that command, an upload
 * replaces the whole cartridge on the instance.
 *
 * It needs nothing beyond Node itself (>= 22, for zlib.crc32 and fetch): `dwupload`
 * depended on `request`, which is deprecated and has unpatched advisories.
 */

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.resolve(__dirname, '..');
var DEFAULT_CARTRIDGES = ['multisafepay', 'bm_multisafepay'];

/**
 * @returns {{hostname: string, username: string, password: string, codeVersion: string}} dw.json settings
 */
function readConfig() {
    // DW_JSON lets the credentials live outside the working tree.
    var file = process.env.DW_JSON ? path.resolve(process.env.DW_JSON) : path.join(ROOT, 'dw.json');
    if (!fs.existsSync(file)) {
        throw new Error(file + ' not found (create dw.json in the project root, or set DW_JSON)');
    }
    var raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    var cfg = {
        hostname: raw.hostname,
        username: raw.username,
        password: raw.password,
        codeVersion: raw['code-version'] || raw.codeVersion || raw.version
    };
    ['hostname', 'username', 'password', 'codeVersion'].forEach(function (key) {
        if (!cfg[key]) { throw new Error('dw.json is missing ' + (key === 'codeVersion' ? 'code-version' : key)); }
    });
    return cfg;
}

/**
 * @param {string} dir - absolute directory
 * @returns {string[]} absolute file paths, recursively
 */
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce(function (out, entry) {
        var full = path.join(dir, entry.name);
        return out.concat(entry.isDirectory() ? walk(full) : [full]);
    }, []);
}

/**
 * Builds a zip archive in memory (deflate), with every entry under `<cartridge>/`.
 * @param {string} cartridge - cartridge folder name under cartridges/
 * @returns {Buffer} the archive
 */
function zipCartridge(cartridge) {
    var base = path.join(ROOT, 'cartridges');
    var locals = [];
    var centrals = [];
    var offset = 0;
    walk(path.join(base, cartridge)).forEach(function (file) {
        var name = Buffer.from(path.relative(base, file).split(path.sep).join('/'), 'utf8');
        var data = fs.readFileSync(file);
        var packed = zlib.deflateRawSync(data);
        var crc = zlib.crc32(data);

        var local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);            // version needed
        local.writeUInt16LE(0x0800, 6);        // UTF-8 names
        local.writeUInt16LE(8, 8);             // deflate
        local.writeUInt32LE(0, 10);            // time/date: not needed by UNZIP
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);

        var central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);          // version made by
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(0, 12);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);     // local header offset (other fields stay 0)

        locals.push(local, name, packed);
        centrals.push(central, name);
        offset += local.length + name.length + packed.length;
    });
    var centralDir = Buffer.concat(centrals);
    var end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(centrals.length / 2, 8);
    end.writeUInt16LE(centrals.length / 2, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat(locals.concat([centralDir, end]));
}

/**
 * Uploads one cartridge. Requests are sequential on purpose: a rejected access key
 * fails on the first request instead of producing a burst of failed logins.
 * @param {Object} cfg - see readConfig()
 * @param {string} cartridge - cartridge name
 * @returns {Promise} resolves when the cartridge is unzipped on the instance
 */
function upload(cfg, cartridge) {
    if (!fs.existsSync(path.join(ROOT, 'cartridges', cartridge))) {
        return Promise.reject(new Error('No cartridge "' + cartridge + '" under cartridges/'));
    }
    var base = 'https://' + cfg.hostname + '/on/demandware.servlet/webdav/Sites/Cartridges/'
        + encodeURIComponent(cfg.codeVersion) + '/';
    var auth = 'Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64');
    var zipName = cartridge + '.zip';

    /**
     * @param {string} method - HTTP method
     * @param {string} target - path below the code version
     * @param {Object} [opts] - body and extra headers
     * @param {number[]} [okStatuses] - statuses accepted besides 2xx
     * @returns {Promise<Response>} the response
     */
    function call(method, target, opts, okStatuses) {
        opts = opts || {};
        return fetch(base + target, {
            method: method,
            headers: Object.assign({ Authorization: auth }, opts.headers),
            body: opts.body
        }).then(function (res) {
            if (res.ok || (okStatuses || []).indexOf(res.status) !== -1) { return res; }
            var hint = res.status === 401 ? ' (check the WebDAV access key in dw.json; it may have expired)' : '';
            throw new Error(method + ' ' + target + ' answered ' + res.status + hint);
        });
    }

    var archive = zipCartridge(cartridge);
    return call('DELETE', encodeURIComponent(cartridge), null, [404])
        .then(function () {
            return call('PUT', encodeURIComponent(zipName), {
                body: archive,
                headers: { 'Content-Type': 'application/zip' }
            });
        })
        .then(function () {
            return call('POST', encodeURIComponent(zipName), {
                body: 'method=UNZIP',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
        })
        .then(function () { return call('DELETE', encodeURIComponent(zipName), null, [404]); })
        .then(function () {
            console.log('uploaded ' + cartridge + ' to ' + cfg.hostname + ' (' + cfg.codeVersion + ')');
        });
}

var cartridges = process.argv.slice(2);
if (!cartridges.length) { cartridges = DEFAULT_CARTRIDGES; }

var config;
try {
    config = readConfig();
} catch (e) {
    console.error(e.message);
    process.exit(1);
}

cartridges.reduce(function (p, name) {
    return p.then(function () { return upload(config, name); });
}, Promise.resolve()).catch(function (err) {
    console.error(err.message);
    process.exit(1);
});
