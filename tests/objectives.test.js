'use strict';
// Every objective, with its conversion locations, engagement types and performance goals as Ads Manager offers them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, parseText, settings } = require('./helpers');

const TODAY = '2026-10-06';
const camp = (objective, extra) => Object.assign({ objective, conversionLocation: E.DEFAULT_LOCATION[objective] || null, engagementType: '', messageApps: [] }, extra || {});
const one = (objectiveLine, extra) => parseText(['# Plan', '## Campaign: Test', 'Objective: ' + objectiveLine, 'Daily budget: $20'].concat(extra || []).concat(['### Main', 'Location: US', 'Primary text: Hello there.', 'Headline: Hi']).join('\n'), 'plan.md');

test('each objective offers the conversion locations Ads Manager shows', () => {
  assert.deepEqual(E.LOCATIONS_BY_OBJECTIVE.AWARENESS, []);
  assert.deepEqual(E.LOCATIONS_BY_OBJECTIVE.ENGAGEMENT.slice().sort(), ['app', 'calls', 'ig_live', 'messages', 'on_ad', 'profile', 'website']);
  assert.deepEqual(E.LOCATIONS_BY_OBJECTIVE.LEADS, ['website', 'form', 'messages', 'calls', 'app']);
  assert.deepEqual(E.LOCATIONS_BY_OBJECTIVE.APP_PROMOTION, ['app']);
  assert.equal(E.locationLabel('ig_live'), 'Instagram live video');
  assert.equal(E.locationLabel('profile'), 'Instagram or Facebook');
});

test('performance goals follow the objective, location and engagement type', () => {
  assert.deepEqual(E.goalsFor(camp('AWARENESS')), ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS']);
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'on_ad', engagementType: 'video_views' })), ['THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS']);
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'on_ad', engagementType: 'event_responses' }))[0], 'EVENT_RESPONSES');
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'on_ad', engagementType: 'reminders' })), ['REMINDERS_SET']);
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'on_ad' }))[0], 'POST_ENGAGEMENT', 'interactions by default');
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'messages' })), ['CONVERSATIONS', 'LINK_CLICKS']);
  assert.deepEqual(E.goalsFor(camp('ENGAGEMENT', { conversionLocation: 'profile' })), ['PROFILE_VISIT', 'VISIT_INSTAGRAM_PROFILE']);
  assert.deepEqual(E.goalsFor(camp('TRAFFIC', { conversionLocation: 'profile' }))[0], 'VISIT_INSTAGRAM_PROFILE');
  assert.deepEqual(E.goalsFor(camp('LEADS', { conversionLocation: 'form' })), ['LEAD_GENERATION', 'QUALITY_LEAD']);
  assert.deepEqual(E.goalsFor(camp('APP_PROMOTION'))[0], 'APP_INSTALLS');
  assert.deepEqual(E.goalsFor(camp('SALES', { conversionLocation: 'calls' })), ['QUALITY_CALL']);
  assert.equal(E.GOALS.PROFILE_VISIT, 'Maximise number of Facebook Page visits');
  assert.equal(E.goalLabel('OFFSITE_CONVERSIONS', camp('ENGAGEMENT', { conversionLocation: 'app' })), 'Maximise number of app events');
  assert.equal(E.goalFor(camp('ENGAGEMENT', { conversionLocation: 'messages' }), { goal: 'REACH' }), 'CONVERSATIONS', 'a goal the location does not offer falls back');
});

test('objective lines in docs carry the location, engagement type and message apps', () => {
  const c = line => one(line).campaigns[0];
  let x = c('Engagement – Video views');
  assert.deepEqual([x.objective, x.conversionLocation, x.engagementType], ['ENGAGEMENT', 'on_ad', 'video_views']);
  x = c('Engagement (Messages on WhatsApp and Instagram)');
  assert.deepEqual([x.conversionLocation, x.messageApps], ['messages', ['instagram', 'whatsapp']]);
  x = c('Engagement – Event responses');
  assert.deepEqual([x.conversionLocation, x.engagementType], ['on_ad', 'event_responses']);
  x = c('Engagement – Facebook Page visits');
  assert.equal(x.conversionLocation, 'profile');
  x = c('Engagement');
  assert.deepEqual([x.conversionLocation, x.engagementType], ['on_ad', 'interactions']);
  x = c('Traffic to Instagram profile');
  assert.deepEqual([x.objective, x.conversionLocation], ['TRAFFIC', 'profile']);
  x = c('App installs');
  assert.deepEqual([x.objective, x.conversionLocation], ['APP_PROMOTION', 'app']);
  x = c('Awareness – Reach');
  assert.deepEqual([x.objective, x.conversionLocation], ['AWARENESS', null]);
  x = c('Leads (Instagram live video)');
  assert.equal(x.conversionLocation, 'website', 'a location the objective does not offer is not used');
  const m = one('Engagement', ['Conversion location: Message destinations', 'Message apps: Messenger, WhatsApp']);
  assert.deepEqual([m.campaigns[0].conversionLocation, m.campaigns[0].messageApps], ['messages', ['messenger', 'whatsapp']]);
  const g = one('Engagement', ['Performance goal: Maximise ThruPlay views']);
  assert.deepEqual([g.campaigns[0].conversionLocation, g.adSets[0].goal], ['on_ad', 'THRUPLAY']);
});

test('destination type and the default button follow the conversion location', () => {
  const d = (o, x, a) => E.destinationFor(camp(o, x), a || {});
  assert.equal(d('TRAFFIC', { conversionLocation: 'website' }), 'WEBSITE');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'on_ad', engagementType: 'video_views' }), 'ON_VIDEO');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'on_ad', engagementType: 'interactions' }), 'ON_POST');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'messages', messageApps: ['whatsapp'] }), 'WHATSAPP');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'messages', messageApps: ['messenger', 'instagram'] }), 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'messages', messageApps: ['messenger', 'instagram', 'whatsapp'] }), 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP');
  assert.equal(d('TRAFFIC', { conversionLocation: 'profile' }), 'INSTAGRAM_PROFILE');
  assert.equal(d('ENGAGEMENT', { conversionLocation: 'profile' }), 'FACEBOOK_PAGE');
  assert.equal(d('LEADS', { conversionLocation: 'calls' }), 'PHONE_CALL');
  assert.equal(d('AWARENESS'), '');
  assert.equal(E.defaultCta(camp('ENGAGEMENT', { conversionLocation: 'messages', messageApps: ['whatsapp'] }), {}), 'WHATSAPP_MESSAGE');
  assert.equal(E.defaultCta(camp('ENGAGEMENT', { conversionLocation: 'messages', messageApps: ['messenger'] }), {}), 'MESSAGE_PAGE');
  assert.equal(E.defaultCta(camp('LEADS', { conversionLocation: 'calls' }), {}), 'CALL_NOW');
  assert.equal(E.defaultCta(camp('APP_PROMOTION'), {}), 'INSTALL_MOBILE_APP');
  assert.equal(E.defaultCta(camp('TRAFFIC'), { cta: 'SHOP_NOW' }), 'SHOP_NOW');
});

test('checks per location: phone for calls, store link for apps, apps for messages, no URL or pixel where none is used', () => {
  const run = (line, S, extra) => E.validate(one(line, extra), settings(S), TODAY);
  const msgs = v => v.errors.map(e => e.msg).join('\n');
  assert.match(msgs(run('Leads – Calls', { phone: '' })), /call ads need a phone number/);
  assert.equal(run('Leads – Calls', { phone: '+1 (214) 555-0100' }).errors.length, 0);
  assert.match(msgs(run('App promotion', { appStoreUrl: '' })), /App Store or Google Play link/);
  assert.equal(run('App promotion', { appStoreUrl: 'https://apps.apple.com/app/id123456789', appId: '123456789' }).errors.length, 0);
  const m = one('Engagement – Messages');
  m.campaigns[0].messageApps = [];
  assert.match(msgs(E.validate(m, settings(), TODAY)), /at least one message app/);
  for (const line of ['Engagement – Messages', 'Engagement – Video views', 'Engagement – Facebook Page visits', 'Awareness', 'Engagement – Instagram live video']) {
    assert.deepEqual(run(line, { url: '', pixelId: '' }).errors, [], line + ' needs no website URL or pixel');
  }
  assert.match(msgs(run('Traffic', { url: '' })), /add a website URL/);
  const w = run('Engagement – Event responses').warnings.map(x => x.msg).join('\n');
  assert.match(w, /promote a Facebook event/);
  const v = run('Engagement – Video views').warnings.map(x => x.msg).join('\n');
  assert.match(v, /need a video ad/);
});

test('export rows for call, app, message and awareness campaigns', () => {
  const rowOf = (line, S) => {
    const t = E.exportTable(one(line), settings(S), null);
    return name => t.rows[0][t.headers.indexOf(name)];
  };
  let r = rowOf('Leads – Calls', { phone: '+12145550100' });
  assert.equal(r('Optimization Goal'), 'QUALITY_CALL');
  assert.equal(r('Destination Type'), 'PHONE_CALL');
  assert.equal(r('Call to Action'), 'CALL_NOW');
  assert.equal(r('Link'), 'tel:+12145550100');
  r = rowOf('App promotion', { appStoreUrl: 'https://apps.apple.com/app/id123456789', appId: '123456789' });
  assert.equal(r('Campaign Objective'), 'Outcome App Promotion');
  assert.equal(r('Optimization Goal'), 'APP_INSTALLS');
  assert.equal(r('Link'), 'https://apps.apple.com/app/id123456789');
  assert.equal(r('Application ID'), '123456789');
  assert.equal(r('Call to Action'), 'INSTALL_MOBILE_APP');
  r = rowOf('Engagement – Messages on WhatsApp');
  assert.equal(r('Optimization Goal'), 'CONVERSATIONS');
  assert.equal(r('Destination Type'), 'WHATSAPP');
  assert.equal(r('Call to Action'), 'WHATSAPP_MESSAGE');
  assert.equal(r('Link'), undefined, 'message ads carry no website link');
  r = rowOf('Awareness');
  assert.equal(r('Optimization Goal'), 'REACH');
  assert.equal(r('Destination Type'), undefined);
  assert.equal(r('Optimized Conversion Tracking Pixels'), undefined);
});

test('a non-default bid strategy goes on the after-import list instead of into the file', () => {
  const m = one('Sales', ['Bid strategy: Cost cap $25']);
  const v = E.validate(m, settings(), TODAY);
  assert.ok(v.warnings.some(w => /Set Cost per result goal at 25 after import/.test(w.msg)));
  const t = E.exportTable(m, settings(), null);
  assert.ok(!t.headers.includes('Campaign Bid Strategy') && !t.headers.includes('Bid Amount'));
  const list = E.checklist(m, settings());
  assert.deepEqual(list[0].items.find(i => i.kind === 'bid').values, ['Cost per result goal: 25 on the campaign']);
});
