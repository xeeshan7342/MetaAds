'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const E = require('../app/js/engine.js');

const { window } = new JSDOM('');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const parseHTML = (html, name, opts) => E.parseHTML(html, name || 'doc.docx', window.DOMParser, opts);
const parseText = (txt, name, opts) => E.parseText(txt, name || 'doc.md', opts);

const settings = over => Object.assign({
  pageId: '104455667788990', pixelId: '778899001122334', leadFormId: '556677889900112', url: 'https://www.example.com/', urlTags: '',
  cta: 'LEARN_MORE', locations: [{ type: 'country', code: 'US', name: 'United States' }], ageMin: 18, ageMax: 65, gender: 'all', status: 'PAUSED', scope: 'ads'
}, over || {});

// Compact view of a model for assertions
const summary = m => m.campaigns.map(c => ({
  name: c.name, objective: c.objective, location: c.conversionLocation, budget: c.budget, level: c.budgetLevel,
  adSets: m.adSets.filter(a => a.campaignId === c.id).map(a => ({
    name: a.name, age: [a.ageMin, a.ageMax], gender: a.gender, locations: a.locations.map(E.locLabel),
    interests: a.interests, audiences: a.audiences, exclusions: a.exclusions, placements: E.placementsText(a.placements), budget: a.budget,
    ads: m.ads.filter(x => x.adSetId === a.id).map(x => ({ name: x.name, primary: x.primary, headline: x.headline, description: x.description, cta: x.cta, url: x.url, format: x.format }))
  }))
}));
const setNamed = (m, name) => summary(m).flatMap(c => c.adSets).find(a => a.name === name);

module.exports = { E, window, fixture, parseHTML, parseText, settings, summary, setNamed };
