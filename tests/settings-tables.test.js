'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, fixture, parseHTML, parseText, settings } = require('./helpers');

// A doc written as settings tables: campaign, ad set and ad levels, a Level | Name table, Keep/Remove placement tables and existing posts
test('settings-table doc: names from the structure table, settings from each level', () => {
  const m = parseHTML(fixture('settings-tables-doc.html'), 'Post_Engagement_Structure.docx');
  assert.equal(m.campaigns.length, 1);
  const c = m.campaigns[0];
  assert.equal(c.name, 'IG_Engagement_PostEng_CA_[Month]');
  assert.equal(c.objective, 'ENGAGEMENT');
  assert.equal(c.conversionLocation, 'on_ad');
  assert.equal(c.special, 'NONE', 'the note in brackets mentions housing, but the answer is None');
  assert.equal(c.budgetLevel, 'adset');
  assert.equal(c.bidStrategy, 'LOWEST_COST_WITHOUT_CAP');
  assert.equal(m.adSets.length, 1);
  const a = m.adSets[0];
  assert.equal(a.name, 'CA_21-60_FeedsOnly_PostEng');
  assert.deepEqual(a.budget && [a.budget.amount, a.budget.period], [15, 'daily']);
  assert.deepEqual([a.ageMin, a.ageMax, a.gender], [21, 60, 'all']);
  assert.deepEqual(a.locations.map(E.locLabel), ['Canada']);
  assert.equal(a.goal, 'POST_ENGAGEMENT');
  assert.deepEqual(a.placements, { mode: 'manual', platforms: ['facebook', 'instagram'], positions: { facebook: ['feed'], instagram: ['stream', 'profile_feed'] } });
  assert.deepEqual(a.exclusions, ['People who already follow the Page (optional)']);
  assert.deepEqual(a.settings.map(x => x.label), ['A/B test', 'Advantage+ audience', 'Identity', 'Advantage+ creative enhancements', 'Multi-advertiser ads', 'Tracking']);
  const ads = m.ads.filter(x => x.adSetId === a.id);
  assert.deepEqual(ads.map(x => [x.name, x.format, x.existingPost]), [
    ['Ad01_ExistingPost_Carousel_[Topic]', 'carousel', true],
    ['Ad02_ExistingPost_Reel_[Topic]', 'video', true]
  ]);
  assert.deepEqual(ads[0].notes, ['Best recent carousel post', 'The recent carousel with the most saves']);
  // nothing lands in the main import report: only notes, advice and skipped sections
  assert.deepEqual(m.skipped.filter(s => s.kind !== 'note').map(s => s.text), []);
  assert.ok(m.notes.some(n => /\[Client Page name\]/.test(n.msg) && /\[date\]/.test(n.msg)), 'placeholders are listed once');
});

test('settings-table doc: existing-post ads need no copy or Page ID and stay out of the ad rows', () => {
  const m = parseHTML(fixture('settings-tables-doc.html'));
  const S = settings({ pageId: '', locations: [] });
  const v = E.validate(m, S, '2026-10-06');
  assert.deepEqual(v.errors.map(e => e.msg), []);
  assert.ok(v.warnings.some(w => /placeholder \(\[Month\]\)/.test(w.msg)));
  assert.equal(v.warnings.filter(w => /existing Page post/.test(w.msg)).length, 2);
  const t = E.exportTable(m, S);
  assert.equal(t.rows.length, 1, 'one ad set row, no ad rows');
  const row = Object.fromEntries(t.headers.map((h, i) => [h, t.rows[0][i]]));
  assert.equal(row['Special Ad Categories'], 'None');
  assert.equal(row['Ad Set Daily Budget'], '15.00');
  assert.equal(row['Publisher Platforms'], 'facebook, instagram');
  assert.equal(row['Facebook Positions'], 'feed');
  assert.equal(row['Instagram Positions'], 'stream, profile_feed');
  assert.ok(!t.headers.includes('Ad Name'));
  const list = E.checklist(m, S)[0];
  const posts = list.items.find(i => i.kind === 'posts');
  assert.equal(posts.values.length, 2);
  assert.match(posts.values[0], /^Ad01_ExistingPost_Carousel_\[Topic\] \(carousel\): Best recent carousel post/);
  assert.ok(list.items.find(i => i.kind === 'settings').values.includes('Multi-advertiser ads: OFF'));
});

test('special ad category: a note in brackets is advice, not the answer', () => {
  assert.equal(E.parseSpecial('None (select one only if the Page covers credit, employment, housing, social issues, elections or politics)'), 'NONE');
  assert.equal(E.parseSpecial('N/A'), 'NONE');
  assert.equal(E.parseSpecial('Housing'), 'HOUSING');
  assert.equal(E.parseSpecial('Credit (financial products)'), 'FINANCIAL_PRODUCTS_SERVICES');
});

test('placements: unchecked and removed platforms or positions are left out', () => {
  const pl = v => E.placementsText(E.parsePlacements(v));
  assert.equal(pl('Facebook only. Instagram, Messenger, Audience Network and Threads all unchecked'), 'Facebook Feed, Profile feed, Marketplace, Video feeds, Right column, Stories, Reels, In-stream video, Search results');
  assert.equal(pl('Facebook Feed and Reels, no Stories'), 'Facebook Feed, Reels');
  assert.equal(pl('All placements except Audience Network').includes('Audience Network'), false);
  assert.equal(E.parsePlacements('Advantage+ placements must be OFF'), null);
  assert.equal(pl('Facebook profile feed'), 'Facebook Profile feed', 'profile feed is not also Feed');
  assert.equal(pl('Instagram Feed, Stories and Reels; Facebook Feed'), 'Facebook Feed; Instagram Feed, Stories, Reels');
});

test('Keep / Remove placement table, a summary line and a later "Ad 2" heading', () => {
  const m = parseText([
    'Engagement objective | $12/day | United States | Facebook placements only',
    '## Structure',
    '| Level | Name | Purpose |',
    '|---|---|---|',
    '| Campaign | Spring Post Boost | Engagement |',
    '| Ad set | US Broad | All of the budget |',
    '| Ad 1 | Ad01_Image | Best image post |',
    '| Ad 2 | Ad02_Video | Best video post |',
    '## Placements',
    '| Placement | Setting |',
    '|---|---|',
    '| Facebook Feed | Keep |',
    '| Facebook Reels | Keep |',
    '| Facebook Stories | Remove |',
    '| Facebook right column | Remove |',
    '## Ad 2',
    'Primary text: Watch how we bake it.',
    'Headline: Fresh Every Morning'
  ].join('\n'));
  assert.equal(m.campaigns.length, 1);
  const c = m.campaigns[0];
  assert.deepEqual([c.name, c.objective, c.budgetLevel, c.budget.amount], ['Spring Post Boost', 'ENGAGEMENT', 'campaign', 12], 'the summary line gives the objective and budget');
  const a = m.adSets[0];
  assert.equal(a.name, 'US Broad');
  assert.deepEqual(a.placements.positions, { facebook: ['feed', 'facebook_reels'] });
  assert.deepEqual(m.ads.map(x => [x.name, x.primary]), [['Ad01_Image', ''], ['Ad02_Video', 'Watch how we bake it.']], 'the "Ad 2" heading fills the second named ad');
});

test('a new campaign heading lifts the structure-table anchor', () => {
  const m = parseText([
    '| Level | Name |',
    '|---|---|',
    '| Campaign | First Campaign |',
    '| Ad set | First Set |',
    '# Campaign 2: Second Campaign',
    'Objective: Traffic',
    'Daily budget: $20',
    'Location: Canada',
    'Primary text: Second campaign copy.',
    'Headline: Second'
  ].join('\n'));
  const second = m.campaigns.find(c => c.name === 'Second Campaign');
  const sets = m.adSets.filter(a => a.campaignId === second.id);
  assert.equal(sets.length, 1);
  assert.notEqual(sets[0].name, 'First Set');
  assert.deepEqual(sets[0].locations.map(E.locLabel), ['Canada']);
  assert.equal(m.ads.filter(x => x.adSetId === sets[0].id)[0].primary, 'Second campaign copy.');
});

test('values left blank or as placeholders do not show up as unread lines', () => {
  const m = parseText([
    '# Campaign: Test',
    'Objective: Engagement',
    'Daily budget: $20',
    'Cost per result goal: Leave blank',
    'Facebook Page: [Client Page name]',
    'Start date: [date]',
    'Advantage+ campaign budget: ON',
    '## Main',
    'Location: US',
    'Primary text: Hello there.',
    'Headline: Hi'
  ].join('\n'));
  assert.deepEqual(m.skipped.map(s => s.text), []);
  assert.equal(m.campaigns[0].budgetLevel, 'campaign');
  assert.equal(m.campaigns[0].bidStrategy, 'LOWEST_COST_WITHOUT_CAP');
  assert.ok(m.notes.some(n => /\[Client Page name\]/.test(n.msg)));
});

test('an ad named "ExistingPost" is an existing-post ad, however the doc lists it', () => {
  const m = parseText([
    '# Campaign: Post Boost',
    'Objective: Engagement',
    'Daily budget: $10',
    'Format: Image',
    '## US Broad',
    'Location: US',
    '| Ad name | Primary text | Headline |',
    '|---|---|---|',
    '| Video01_ExistingPost | | |',
    '| Video02_ExistingPost | | |',
    '| Image01_NewAd | Fresh bread every morning. | Baked Daily |'
  ].join('\n'));
  assert.deepEqual(m.ads.map(x => [x.name, x.existingPost, x.format]), [
    ['Video01_ExistingPost', true, 'video'],
    ['Video02_ExistingPost', true, 'video'],
    ['Image01_NewAd', false, 'image']
  ]);
});

test('existing-post ads with a post ID go in the file as Story ID, the way Ads Manager exports them', () => {
  assert.equal(E.postIdOf('122115687656432835'), '122115687656432835');
  assert.equal(E.postIdOf('s:122115687656432835'), '122115687656432835');
  assert.equal(E.postIdOf('1106712235857730_122115687656432835'), '122115687656432835');
  assert.equal(E.postIdOf('https://www.facebook.com/examplepage/posts/122115687656432835'), '122115687656432835');
  assert.equal(E.postIdOf('https://www.facebook.com/61562985063632/posts/pfbid0FnpZRK5jPycD9b'), '', 'pfbid links do not carry the number');
  const m = parseText([
    '# Campaign: Post Boost',
    'Objective: Engagement',
    'Daily budget: $20',
    '## US Broad',
    'Location: US',
    '| Ad name | Post type | Post ID |',
    '|---|---|---|',
    '| Weekend reset | Photo | 122115687656432835 |',
    '| Wellness reel | Video | s:122116648190432835 |',
    '| Question post | | |'
  ].join('\n'));
  const ads = m.ads;
  assert.deepEqual(ads.map(x => [x.name, x.existingPost, x.postId, x.format]), [
    ['Weekend reset', true, '122115687656432835', 'image'],
    ['Wellness reel', true, '122116648190432835', 'video'],
    ['Question post', false, '', '']
  ]);
  ads[2].existingPost = true; // ticked on the card, no post ID yet
  const S = settings();
  const v = E.validate(m, S, '2026-10-07');
  assert.deepEqual(v.errors.map(e => e.msg), []);
  assert.ok(v.warnings.some(w => /Question post: uses an existing Page post\. Add its post ID/.test(w.msg)));
  const t = E.exportTable(m, S);
  const rows = t.rows.map(r => Object.fromEntries(t.headers.map((h, i) => [h, r[i]])));
  assert.equal(rows.length, 2, 'the ad without a post ID stays out');
  assert.deepEqual(rows.map(r => [r['Ad Name'], r['Story ID'], r['Creative Type'], r['Link Object ID']]), [
    ['Weekend reset', 's:122115687656432835', 'Photo Page Post Ad', 'o:104455667788990'],
    ['Wellness reel', 's:122116648190432835', 'Video Page Post Ad', 'o:104455667788990']
  ]);
  assert.ok(!t.headers.includes('Body') && !t.headers.includes('Title') && !t.headers.includes('Link'), 'the post brings its own text and link');
  const posts = E.checklist(m, S)[0].items.find(i => i.kind === 'posts');
  assert.deepEqual(posts.values.map(x => x.split(':')[0]), ['Question post']);
  // a post ID needs the Page it was published on
  assert.ok(E.validate(m, settings({ pageId: '' }), '2026-10-07').errors.some(e => /Page ID/.test(e.msg)));
});
