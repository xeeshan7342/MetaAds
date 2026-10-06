// Builds dist/meta-builder-artifact.html: the page to publish as a Claude artifact on claude.ai, where AI reading
// runs on the viewer's own Claude plan. Run with `npm run build:artifact`.
// The platform adds the doctype, head and body, so this writes the page content only. Word and Excel readers load
// from jsDelivr with pinned versions and integrity hashes; the Anthropic SDK is left out (the API route is not
// reachable from inside claude.ai, and the plan route needs no SDK).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const app = path.join(root, 'app');
const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
const read = rel => fs.readFileSync(path.join(app, rel), 'utf8');
const safeJs = js => js.replace(/<\/script/gi, '<\\/script');

const cdn = (pkg, file) => {
  const version = require(path.join(root, 'node_modules', pkg, 'package.json')).version;
  const body = fs.readFileSync(path.join(root, 'node_modules', pkg, file));
  const sri = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
  return '<script src="https://cdn.jsdelivr.net/npm/' + pkg + '@' + version + '/' + file + '" integrity="' + sri + '" crossorigin="anonymous"></script>';
};

const title = (/<title>[^<]*<\/title>/.exec(html) || [''])[0];
const fonts = (html.match(/<link rel="(?:preconnect|stylesheet)" href="https:\/\/fonts\.[^"]+"[^>]*>/g) || []).join('\n');
const body = /<body>([\s\S]*?)<script src=/.exec(html)[1].trim();
const scripts = Array.from(html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)).map(m => '<script>\n' + safeJs(read(m[1])) + '\n</script>').join('\n');

const out = [
  title,
  fonts,
  '<style>\n' + read('css/app.css') + '\n</style>',
  body,
  cdn('mammoth', 'mammoth.browser.min.js'),
  cdn('jszip', 'dist/jszip.min.js'),
  '<script>window.MBB_SINGLE_FILE = true; window.MBB_ARTIFACT = true;</script>',
  scripts
].join('\n');
if (/<script src="(?:js|vendor)\//.test(out) || /href="css\//.test(out)) throw new Error('Some local files were not inlined.');

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const file = path.join(root, 'dist', 'meta-builder-artifact.html');
fs.writeFileSync(file, out);
console.log('wrote', path.relative(root, file), (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
