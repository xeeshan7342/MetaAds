'use strict';
// Docs written the ways strategists and chat tools write them, all with made-up content.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, fixture, parseHTML, parseText, summary, setNamed } = require('./helpers');

test('a Google + Meta agency doc: only the Meta section is read, campaign table and headings line up', () => {
  const m = parseHTML(fixture('google-meta-doc.html'), 'Cedar_Ridge.docx');
  const s = summary(m);
  assert.deepEqual(s.map(c => [c.name, c.objective, c.location, c.budget && c.budget.amount]), [
    ['Implant Lead Gen', 'LEADS', 'form', 29.61], ['Retargeting', 'TRAFFIC', 'website', 4.93]]);
  assert.deepEqual(s[0].adSets.map(a => a.name), ['Implant Seekers', 'Lookalike 1%']);
  const seekers = setNamed(m, 'Implant Seekers');
  assert.deepEqual(seekers.age, [45, 65]);
  assert.deepEqual(seekers.interests, ['dental implants', 'dentures', 'cosmetic dentistry']);
  assert.equal(seekers.placements, 'Facebook Feed, Stories, Reels; Instagram Feed, Stories, Reels');
  assert.equal(seekers.ads.length, 2);
  assert.equal(seekers.ads[0].cta, 'BOOK_TRAVEL');
  const lal = setNamed(m, 'Lookalike 1%');
  assert.deepEqual(lal.audiences, ['1% lookalike of past implant patients']);
  assert.equal(lal.interests.length, 0, 'targeting from one ad set never leaks into the next');
  assert.equal(lal.ads[0].headline, "Plano's Implant Team");
  const visitors = setNamed(m, 'Website Visitors (30 day)');
  assert.deepEqual(visitors.audiences, ['Website Visitors (30 day)'], 'the ad set name says which audience to add');
  assert.equal(visitors.ads[0].url, 'https://www.example.com/implants');
  assert.equal(visitors.ads[0].format, 'video');
  // shared targeting at the end becomes the account default
  assert.deepEqual(m.detected.locations.map(E.locLabel), ['Plano, TX (+15 mi)']);
  assert.equal(m.detected.ageMin, 35);
});

test('the Google section never leaks into Meta ads', () => {
  const m = parseHTML(fixture('google-meta-doc.html'), 'Cedar_Ridge.docx');
  const copy = m.ads.flatMap(a => [a.primary, a.headline, a.description]).join('\n');
  assert.ok(!/Plano Implant Dentist|Restore your smile/.test(copy));
  assert.ok(m.notes.some(n => /Skipped the "1\. Google Search Campaign Complete Structure" section/.test(n.msg)));
  assert.equal(m.notes.filter(n => /Skipped the/.test(n.msg)).length, 1, 'one note per skipped section, not per line');
  assert.ok(m.skipped.some(s => s.kind === 'note'), 'the Notes section is reported once');
});

test('a chat-style markdown plan: bold labels, emoji lines, ABO budgets, ad table', () => {
  const m = parseText(fixture('chat-plan.md'), 'bloom.md');
  const s = summary(m);
  assert.equal(s.length, 2);
  assert.equal(s[0].level, 'adset');
  const local = setNamed(m, 'Local Yoga Interest');
  assert.deepEqual(local.age, [24, 45]);
  assert.equal(local.gender, 'women');
  assert.deepEqual(local.locations, ['Austin, TX (+10 mi)']);
  assert.deepEqual(local.interests, ['Yoga', 'Pilates', 'Lululemon', 'Meditation']);
  assert.deepEqual(local.exclusions, ['Current members (customer list)']);
  assert.equal(local.placements, 'Instagram Feed, Stories');
  assert.equal(local.budget.amount, 25);
  const reel = local.ads[0];
  assert.equal(reel.name, 'Studio Tour Reel');
  assert.equal(reel.primary.split('\n').length, 4, 'a multi-line primary text stays one text');
  assert.ok(reel.primary.includes('🧘‍♀️'), 'emoji joiners survive');
  assert.equal(reel.format, 'video');
  assert.equal(reel.cta, 'SHOP_NOW');
  assert.equal(local.ads[1].format, 'carousel');
  const lal = setNamed(m, 'Lookalike – Past Intro Buyers 1%');
  assert.deepEqual(lal.ads.map(a => [a.primary.slice(0, 20), a.headline]), [['Austin\'s friendliest', '$49 for 30 Days Unlimited'], ['Stressed? Stretch it', 'Your First Class Is Waiting']]);
  const rt = s[1];
  assert.equal(rt.objective, 'LEADS');
  assert.equal(rt.location, 'form');
  assert.deepEqual(rt.budget, { amount: 9.87, period: 'daily', basis: 'monthly', source: 300 });
  assert.deepEqual(rt.adSets[0].ads.map(a => a.name), ['Reminder', 'Social proof']);
  assert.deepEqual(m.detected, { url: 'https://bloomyoga.example.com', pageId: '104455667788990', pixelId: '778899001122334', urlTags: 'utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}' });
  assert.equal(m.campaigns[1].leadFormId, '556677889900112');
});

test('a doc made only of tables: settings table, ad set table with an audience column, ad table', () => {
  const m = parseText(fixture('tables-plan.md'), 'realty.md');
  const c = m.campaigns[0];
  assert.equal(c.name, 'Coastal Realty - Meta');
  assert.equal(c.special, 'HOUSING');
  assert.equal(c.bidStrategy, 'COST_CAP');
  assert.equal(c.bidAmount, 35);
  assert.equal(c.startDate, '2026-11-01');
  assert.equal(c.endDate, '2026-11-30');
  const buyers = setNamed(m, 'Buyers');
  assert.deepEqual(buyers.interests, ['buying a home', 'first-time buyers']);
  assert.equal(buyers.ads[0].url, 'https://example.com/buy');
  const sellers = setNamed(m, 'Sellers');
  assert.deepEqual(sellers.locations, ['Tampa, FL', 'St. Petersburg, FL']);
  assert.equal(sellers.ads[0].cta, 'GET_QUOTE');
});

test('one spreadsheet row per ad, with campaign and ad set columns', () => {
  const rows = [
    ['Campaign', 'Ad Set', 'Age', 'Location', 'Interests', 'Primary Text', 'Headline', 'CTA'],
    ['Prospecting', 'Runners', '25-44', 'Denver, CO', 'Running; Marathons', 'Lace up for spring.', 'Spring Running Gear', 'Shop now'],
    ['Prospecting', 'Runners', '', '', '', 'New trail shoes are in.', 'Trail Shoes Are Here', 'Shop now'],
    ['Prospecting', 'Hikers', '30-55', 'Boulder, CO', 'Hiking', 'Gear up for the trail.', 'Hiking Boots', 'Learn more']
  ];
  const m = E.parseBlocksToModel(E.rowsToBlocks(rows, 'Meta build'), 'gear.xlsx');
  const s = summary(m);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].adSets.map(a => [a.name, a.ads.length]), [['Runners', 2], ['Hikers', 1]]);
  assert.deepEqual(setNamed(m, 'Runners').interests, ['Running', 'Marathons']);
  assert.deepEqual(setNamed(m, 'Hikers').locations, ['Boulder, CO']);
});

test('plain headings as ad sets, a plain name line before targeting, and Option lines', () => {
  const m = parseText([
    '# Spring Sale',
    'Objective: Traffic',
    'Budget: $30/day',
    '## Moms in Leeds',
    'Location: Leeds, England',
    'Age: 28-45',
    'Primary text:',
    'Option 1: Spring styles for little ones, 20% off this week.',
    'Option 2: Their favourite tees, now 20% off.',
    'Headline: Kids Spring Sale',
    'Bargain Hunters',
    'Interests: Discount stores, coupons',
    'Primary text: Everything kids need, 20% off.'
  ].join('\n'), 'spring.md');
  const s = summary(m);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].adSets.map(a => a.name), ['Moms in Leeds', 'Bargain Hunters']);
  const moms = setNamed(m, 'Moms in Leeds');
  assert.deepEqual(moms.locations, ['Leeds, England, United Kingdom']);
  assert.deepEqual(moms.ads.map(a => a.primary), ['Spring styles for little ones, 20% off this week.', 'Their favourite tees, now 20% off.']);
  assert.ok(moms.ads.every(a => a.headline === 'Kids Spring Sale'), 'one headline pairs with every primary text');
  assert.deepEqual(setNamed(m, 'Bargain Hunters').interests, ['Discount stores', 'coupons']);
});

test('a doc with no Meta section says so instead of inventing campaigns', () => {
  const m = parseText(['# Google Ads Plan', '## Search Campaign: Plumbing', 'Keywords: plumber near me', 'Headline 1: Fast Plumbers'].join('\n'), 'google.md');
  assert.equal(m.campaigns.length, 0);
  assert.ok(m.skipped.some(s => s.kind === 'platform'));
});

test('taught labels change how a doc is read', () => {
  const doc = ['## Campaign: Leads', 'Objective: Leads', '### Homeowners', 'Age: 35-65', 'Who we talk to:', '- Gardening', '- DIY', 'Hook lines:', '- Your garden, finished this weekend.'].join('\n');
  const before = parseText(doc, 'a.md');
  assert.equal(setNamed(before, 'Homeowners').interests.length, 0);
  const memory = { [E.labelKey('Who we talk to')]: 'interests', [E.labelKey('Hook lines')]: 'primary' };
  const after = parseText(doc, 'a.md', { memory });
  assert.deepEqual(setNamed(after, 'Homeowners').interests, ['Gardening', 'DIY']);
  assert.equal(setNamed(after, 'Homeowners').ads[0].primary, 'Your garden, finished this weekend.');
});
