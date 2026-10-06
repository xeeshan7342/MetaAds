'use strict';
// The small readers: locations, placements, ages, budgets, objectives, buttons.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E } = require('./helpers');

const locs = v => E.parseLocations(v).list.map(E.locLabel);

test('locations: countries, states, cities with state codes, town lists and radius', () => {
  assert.deepEqual(locs('US, CA'), ['United States', 'Canada']);
  assert.deepEqual(locs('United Kingdom; Ireland'), ['United Kingdom', 'Ireland']);
  assert.deepEqual(locs('Texas and Florida'), ['Texas', 'Florida']);
  assert.deepEqual(locs('Austin, TX'), ['Austin, TX']);
  assert.deepEqual(locs('Naperville, IL plus Aurora, Lisle, Wheaton'), ['Naperville, IL', 'Aurora, IL', 'Lisle, IL', 'Wheaton, IL']);
  assert.deepEqual(locs('Toronto, ON'), ['Toronto, ON, Canada']);
  assert.deepEqual(locs('Dubai'), ['Dubai, United Arab Emirates']);
  assert.deepEqual(locs('Trinidad and Tobago'), ['Trinidad and Tobago'], 'a country with "and" in its name stays whole');
  assert.deepEqual(locs('15 to 25 mile radius of Naperville, IL'), ['Naperville, IL (+25 mi)']);
  assert.deepEqual(locs('Austin, TX + 10 mile radius'), ['Austin, TX (+10 mi)']);
  assert.deepEqual(locs('within 40 km of Lahore'), ['Lahore, Pakistan (+40 km)']);
  assert.deepEqual(locs('Plano, TX and surrounding suburbs'), ['Plano, TX']);
});

test('locations: radius outside Meta\'s range is clamped with a note; unknown towns are flagged', () => {
  const r = E.parseLocations('3 miles around Austin, TX');
  assert.equal(r.list[0].radius, 10);
  assert.ok(/outside Meta's 10 to 50 mi range/.test(r.notes[0]));
  const u = E.parseLocations('Smallville');
  assert.equal(u.list[0].unmatched, true);
});

test('placements: each platform takes the positions written next to it', () => {
  const pos = v => { const p = E.parsePlacements(v); return p && p.mode === 'manual' ? p.positions : p; };
  assert.deepEqual(pos('Instagram Feed, Stories and Reels; Facebook Feed'), { facebook: ['feed'], instagram: ['stream', 'story', 'reels'] });
  assert.deepEqual(pos('Facebook & Instagram Feed, Reels'), { facebook: ['feed', 'facebook_reels'], instagram: ['stream', 'reels'] });
  assert.deepEqual(pos('Feed and Stories on Facebook and Instagram'), { facebook: ['feed', 'story'], instagram: ['stream', 'story'] });
  assert.deepEqual(pos('Facebook Video Feeds and Marketplace'), { facebook: ['video_feeds', 'marketplace'] });
  assert.equal(E.parsePlacements('Instagram only').positions.instagram.length, 7);
  assert.deepEqual(pos('Advantage+ placements'), { mode: 'advantage' });
  assert.deepEqual(pos('Automatic'), { mode: 'advantage' });
  assert.equal(E.parsePlacements('see notes'), null);
});

test('ages and genders, without reading radius or percentages as ages', () => {
  assert.deepEqual(E.parseAge('Age 30 to 55'), { min: 30, max: 55 });
  assert.deepEqual(E.parseAge('25–65+'), { min: 25, max: 65 });
  assert.deepEqual(E.parseAge('35+'), { min: 35, max: 65 });
  assert.deepEqual(E.parseAge('over 50'), { min: 50, max: 65 });
  assert.equal(E.parseAge('15 to 25 mile radius'), null);
  assert.equal(E.parseAge('20% off'), null);
  assert.equal(E.parseGender('Women 30-55'), 'women');
  assert.equal(E.parseGender('Moms and dads'), 'all');
  assert.equal(E.parseGender('Men'), 'men');
});

test('budgets: daily, monthly, weekly, lifetime and other number formats', () => {
  assert.deepEqual(E.parseBudget('Daily budget', '$50'), { amount: 50, basis: 'daily', period: 'daily', daily: 50 });
  assert.deepEqual(E.parseBudget('Budget', '$1,520/month'), { amount: 1520, basis: 'monthly', period: 'daily', daily: 50 });
  assert.equal(E.parseBudget('Budget', '£700 per week').daily, 100);
  assert.deepEqual(E.parseBudget('Lifetime budget', '$3,000'), { amount: 3000, basis: 'lifetime', period: 'lifetime', daily: null });
  assert.equal(E.parseBudget('Budget', '1.500 € per month').amount, 1500);
  assert.equal(E.parseBudget('Budget', '₹2,00,000 monthly').amount, 200000);
  assert.equal(E.parseBudget('Budget', '$40').basis, 'unlabeled');
});

test('objectives, conversion locations, buttons and bid strategies', () => {
  assert.equal(E.parseObjective('Lead Gen'), 'LEADS');
  assert.equal(E.parseObjective('Conversions (leads)'), 'LEADS');
  assert.equal(E.parseObjective('Purchases / ROAS'), 'SALES');
  assert.equal(E.parseObjective('Traffic - landing page views'), 'TRAFFIC');
  assert.equal(E.parseObjective('Video views'), 'ENGAGEMENT');
  assert.equal(E.parseObjective('Brand awareness'), 'AWARENESS');
  assert.equal(E.parseConversionLocation('Leads (Instant Forms)'), 'form');
  assert.equal(E.parseConversionLocation('website leads'), 'website');
  assert.equal(E.parseCta('Book Now'), 'BOOK_TRAVEL');
  assert.equal(E.parseCta('Get a quote'), 'GET_QUOTE');
  assert.equal(E.parseCta('LEARN_MORE'), 'LEARN_MORE');
  assert.equal(E.parseCta('WhatsApp us'), 'WHATSAPP_MESSAGE');
  assert.deepEqual(E.parseBidStrategy('Cost cap at $25'), { strategy: 'COST_CAP', amount: 25 });
  assert.deepEqual(E.parseBidStrategy('Highest volume'), { strategy: 'LOWEST_COST_WITHOUT_CAP', amount: null });
  assert.equal(E.parseSpecial('Housing (real estate)'), 'HOUSING');
  assert.equal(E.parseSpecial('None'), 'NONE');
});
