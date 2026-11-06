'use strict';

/**
 * Builds the storefront assets of the `multisafepay` cartridge.
 *
 *   cartridge/client/<locale>/js/*.js           -> cartridge/static/<locale>/js/*.js
 *   cartridge/client/<locale>/scss/**\/[^_]*.scss -> cartridge/static/<locale>/css/**\/*.css
 *
 * This replaces the SFRA `sgmf-scripts` toolchain (webpack 4), which is no longer
 * maintained and pulled in more than a thousand transitive packages, several of them
 * with published vulnerabilities and no fix. The entry points and output paths are the
 * ones `sgmf-scripts` derived (createJsPath / createScssPath), so the compiled files land
 * where the ISML templates already load them.
 *
 * Usage: node bin/build.js [js|css]   (no argument builds both)
 */

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var CLIENT = path.join(ROOT, 'cartridges/multisafepay/cartridge/client');
var STATIC = path.join(ROOT, 'cartridges/multisafepay/cartridge/static');

/**
 * Lists the files under a directory, recursively.
 * @param {string} dir - absolute directory
 * @returns {string[]} absolute file paths
 */
function walk(dir) {
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir, { withFileTypes: true }).reduce(function (out, entry) {
        var full = path.join(dir, entry.name);
        return out.concat(entry.isDirectory() ? walk(full) : [full]);
    }, []);
}

/**
 * @returns {string[]} the locale folders under client/ (usually just `default`)
 */
function locales() {
    return fs.readdirSync(CLIENT, { withFileTypes: true })
        .filter(function (e) { return e.isDirectory(); })
        .map(function (e) { return e.name; });
}

/**
 * Bundles and minifies each top-level client/<locale>/js/*.js file.
 * @returns {Promise} resolves when every bundle is written
 */
function buildJs() {
    var esbuild = require('esbuild');
    var jobs = [];
    locales().forEach(function (locale) {
        var jsDir = path.join(CLIENT, locale, 'js');
        if (!fs.existsSync(jsDir)) { return; }
        fs.readdirSync(jsDir).filter(function (f) { return /\.js$/.test(f); }).forEach(function (file) {
            var out = path.join(STATIC, locale, 'js', file);
            jobs.push(esbuild.build({
                entryPoints: [path.join(jsDir, file)],
                outfile: out,
                bundle: true,
                minify: true,
                format: 'iife',
                // The client code already uses `let`; ES2015 is the syntax level the
                // webpack 4 bundle shipped, so no browser support changes.
                target: 'es2015',
                // webpack resolved packages through their "module" field even for
                // require(); esbuild, by default, prefers "main" there. For cleave.js that
                // is the UMD build, which has no `.default`, and components/cleave.js reads
                // `require('cleave.js').default`: the card field would break. Keep
                // webpack's order.
                mainFields: ['browser', 'module', 'main'],
                legalComments: 'none',
                logLevel: 'warning'
            }).then(function () {
                console.log('js   ' + path.relative(ROOT, out));
            }));
        });
    });
    return Promise.all(jobs);
}

/**
 * Compiles each non-partial SCSS file, then runs autoprefixer over it.
 * @returns {Promise} resolves when every stylesheet is written
 */
function buildCss() {
    var sass = require('sass');
    var postcss = require('postcss');
    var autoprefixer = require('autoprefixer');
    var jobs = [];
    locales().forEach(function (locale) {
        var scssDir = path.join(CLIENT, locale, 'scss');
        walk(scssDir).filter(function (f) {
            return /\.scss$/.test(f) && path.basename(f).indexOf('_') !== 0;
        }).forEach(function (file) {
            var rel = path.relative(scssDir, file).replace(/\.scss$/, '.css');
            var out = path.join(STATIC, locale, 'css', rel);
            var compiled = sass.compile(file, {
                loadPaths: [path.join(ROOT, 'node_modules')],
                style: 'expanded',
                // Bootstrap 4's SCSS predates the Sass module system; its deprecation
                // warnings are not ours to fix and would bury real ones.
                quietDeps: true,
                silenceDeprecations: ['import', 'global-builtin', 'color-functions']
            });
            jobs.push(postcss([autoprefixer()]).process(compiled.css, { from: file, to: out }).then(function (result) {
                fs.mkdirSync(path.dirname(out), { recursive: true });
                fs.writeFileSync(out, result.css + '\n');
                console.log('css  ' + path.relative(ROOT, out));
            }));
        });
    });
    return Promise.all(jobs);
}

var what = process.argv[2];
var steps = [];
if (!what || what === 'js') { steps.push(buildJs); }
if (!what || what === 'css') { steps.push(buildCss); }
if (!steps.length) {
    console.error('Usage: node bin/build.js [js|css]');
    process.exit(2);
}

steps.reduce(function (p, step) { return p.then(step); }, Promise.resolve()).catch(function (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
});
