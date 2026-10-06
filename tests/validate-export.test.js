'use strict';
// Checks before export and the Ads Manager file itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { E, window, fixture, parseText, settings } = require('./helpers');
const R = require('../app/js/readers.js');

const TODAY = '2026-10-06';
const chat = () => parseText(fixture('chat-plan.md'), 'bloom.md');
const msgs = list => list.map(x => x.msg);

test('a complete plan with IDs exports with no errors', () => {
  const v = E.validate(chat(), settings(), TODAY);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some(w => w.kind === 'manual'), 'interests and audiences go on the after-import list');
  assert.ok(v.warnings.some(w => w.kind === 'media'));
});

test('missing Page, pixel and lead form IDs block the export, and only where they matter', () => {
  const m = chat();
  const v = E.validate(m, settings({ pageId: '', pixelId: '', leadFormId: '' }), TODAY);
  assert.ok(msgs(v.errors).some(x => /Facebook Page ID/.test(x)));
  assert.equal(v.errors.filter(e => /pixel/.test(e.msg)).length, 2, 'the two Sales ad sets need the pixel');
  assert.equal(v.errors.filter(e => /lead form ID/.test(e.msg)).length, 0, 'the doc gave the retargeting campaign its own form');
  const s = E.validate(m, settings({ pageId: '', pixelId: '', scope: 'structure' }), TODAY);
  assert.ok(!msgs(s.errors).some(x => /Page ID/.test(x)), 'campaigns and ad sets only: no Page needed');
});

test('ad and campaign checks: primary text, URL, objective, budget, lifetime end date, names', () => {
  const m = chat();
  m.ads[0].primary = '';
  m.ads[1].url = 'not a url';
  m.campaigns[1].objective = null;
  m.campaigns[1].budget = { amount: 500, period: 'lifetime', basis: 'lifetime' };
  m.adSets[1].name = m.adSets[0].name;
  const v = E.validate(m, settings(), TODAY);
  const e = msgs(v.errors).join('\n');
  assert.match(e, /add primary text/);
  assert.match(e, /"not a url" is not a valid URL/);
  assert.match(e, /pick an objective/);
  assert.match(e, /lifetime budget needs an end date/);
  assert.match(e, /two ad sets are named/);
});

test('special ad categories: no age or gender targeting, wide radius', () => {
  const m = parseText(fixture('tables-plan.md'), 'realty.md');
  let v = E.validate(m, settings(), TODAY);
  assert.equal(v.errors.filter(x => /ages 18 to 65/.test(x.msg)).length, 2);
  m.adSets.forEach(a => { a.ageMin = 18; a.ageMax = 65; });
  m.adSets[0].locations[0].radius = 10;
  v = E.validate(m, settings(), TODAY);
  assert.deepEqual(msgs(v.errors), ['Coastal Realty - Meta > Buyers: special ad categories need a radius of at least 15 miles (25 km).']);
});

test('copy length warnings follow Meta\'s guidance', () => {
  const m = chat();
  const v = E.validate(m, settings(), TODAY);
  assert.ok(msgs(v.warnings).some(x => /primary text is 1\d\d characters/.test(x)));
});

test('export rows: one row per ad, parent columns repeated, Meta values', () => {
  const t = E.exportTable(chat(), settings(), null);
  const col = name => t.headers.indexOf(name);
  assert.equal(t.rows.length, 6);
  const r0 = t.rows[0];
  assert.equal(r0[col('Campaign Name')], 'New Student Intro Offer');
  assert.equal(r0[col('Campaign Objective')], 'Outcome Sales');
  assert.equal(r0[col('Campaign Status')], 'PAUSED');
  assert.equal(r0[col('Ad Set Daily Budget')], '25.00');
  assert.equal(r0[col('Campaign Daily Budget')], '');
  assert.equal(r0[col('Optimization Goal')], 'OFFSITE_CONVERSIONS');
  assert.equal(r0[col('Optimized Conversion Tracking Pixels')], 'tp:778899001122334');
  assert.equal(r0[col('Optimized Event')], 'PURCHASE');
  assert.equal(r0[col('Countries')], 'US');
  assert.equal(r0[col('Cities')], 'Austin, TX');
  assert.equal(r0[col('Gender')], 'Women');
  assert.equal(r0[col('Publisher Platforms')], 'instagram');
  assert.equal(r0[col('Instagram Positions')], 'stream, story');
  assert.equal(r0[col('Link Object ID')], 'o:104455667788990');
  assert.equal(r0[col('Creative Type')], 'Video Page Post Ad');
  assert.equal(r0[col('Call to Action')], 'SHOP_NOW');
  const lead = t.rows[4];
  assert.equal(lead[col('Optimization Goal')], 'LEAD_GENERATION');
  assert.equal(lead[col('Lead Form ID')], '556677889900112');
  assert.equal(lead[col('Link')], '', 'instant form ads carry no website link');
  assert.equal(lead[col('Campaign Daily Budget')], '9.87');
});

test('campaigns and ad sets only: one row per ad set, no ad columns', () => {
  const t = E.exportTable(chat(), settings({ scope: 'structure' }), null);
  assert.equal(t.rows.length, 3);
  assert.ok(!t.headers.includes('Ad Name'));
});

test('a loaded Ads Manager template decides the columns and their order', () => {
  const headers = ['Campaign ID', 'Campaign Name', 'Campaign Objective', 'Ad Set Name', 'Ad Set Daily Budget', 'Countries', 'Ad Name', 'Body', 'Title', 'Some Future Column'];
  const tpl = E.mapTemplate(headers);
  assert.equal(tpl.matched, 8);
  const t = E.exportTable(chat(), settings(), tpl);
  assert.deepEqual(t.headers, headers);
  assert.equal(t.rows[0][0], '', 'columns the tool does not fill stay blank');
  assert.equal(t.rows[0][7].slice(0, 11), 'New to yoga');
  assert.ok(t.missing.includes('Optimization Goal'), 'data with no column in the template is reported');
});

test('CSV and tab-separated output quote commas, quotes and line breaks', () => {
  const t = { headers: ['A', 'B'], rows: [['x, y', 'say "hi"\nnext line']] };
  assert.equal(E.toCSV(t), 'A,B\r\n"x, y","say ""hi""\nnext line"\r\n');
  assert.equal(E.toTSV(t), 'A\tB\nx, y\t"say ""hi""\nnext line"\n');
});

test('the .xlsx reads back with the same cells, numbers as numbers', async () => {
  const t = E.exportTable(chat(), settings(), null);
  const u8 = await R.writeXlsx(t, JSZip, 'Ads');
  const sheets = await R.xlsxToSheets(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), JSZip, window.DOMParser);
  assert.equal(sheets[0].name, 'Ads');
  assert.deepEqual(sheets[0].rows[0], t.headers);
  const trimEnd = r => { const c = r.slice(); while (c.length && c[c.length - 1] === '') c.pop(); return c; };
  assert.deepEqual(trimEnd(sheets[0].rows[1]), trimEnd(t.rows[0]));
  const zip = await JSZip.loadAsync(u8);
  assert.ok(Object.keys(zip.files).every(n => !n.endsWith('/')), 'no folder entries');
  assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'), /<c r="[A-Z]+2"><v>25\.00<\/v><\/c>/);
});

test('reading the header row of a template file', async () => {
  const csv = 'Campaign Name,Campaign Status,Ad Set Name,Ad Name,Body,Title\n';
  const file = { name: 'template.csv', arrayBuffer: async () => new TextEncoder().encode(csv).buffer };
  assert.deepEqual(await R.readTemplateHeaders(file, {}), ['Campaign Name', 'Campaign Status', 'Ad Set Name', 'Ad Name', 'Body', 'Title']);
});

test('the after-import list carries what the file cannot', () => {
  const list = E.checklist(chat(), settings());
  const local = list.find(g => g.adSet === 'Local Yoga Interest');
  assert.deepEqual(local.items.map(i => i.kind), ['interests', 'exclusions', 'radius', 'media']);
  assert.match(E.checklistText(list, chat()), /Detailed targeting:\n {4}- Yoga/);
});
