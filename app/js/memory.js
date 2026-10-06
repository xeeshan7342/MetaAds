/* Memory: what the tool has been taught about your docs, saved client defaults, and your Ads Manager template.
   Lives in this browser (localStorage). Export it as a file to share with your team or move to another computer. */
(function (root) {
  'use strict';
  const E = root.MBEngine || (typeof require === 'function' ? require('./engine.js') : null);
  const STORE_KEY = 'mbb.memory.v1';
  const ROLES = ['primary', 'headline', 'description', 'interests', 'audiences', 'exclusions', 'audience', 'locations', 'placements', 'other', 'campaign', 'adset', 'ad', 'ignore'];
  const ROLE_LABEL = {
    primary: 'Primary text section', headline: 'Headlines section', description: 'Descriptions section', interests: 'Interests section',
    audiences: 'Custom or lookalike audiences', exclusions: 'Exclusions section', audience: 'Audience description', locations: 'Locations section',
    placements: 'Placements', other: 'Section to skip', campaign: 'Campaign name', adset: 'Ad set name', ad: 'Ad name', ignore: 'Line to ignore'
  };
  const PROFILE_FIELDS = ['pageId', 'pixelId', 'leadFormId', 'url', 'urlTags', 'cta', 'locations', 'ageMin', 'ageMax', 'gender', 'status'];

  const empty = () => ({ version: 1, labels: {}, profiles: {}, template: null });

  // A storage object can be passed in (tests use a plain object); the default is localStorage, which can throw.
  function create(storage) {
    const backend = storage || (() => { try { return root.localStorage; } catch (e) { return null; } })();
    let cache = null;

    const load = () => {
      if (cache) return cache;
      let data = null;
      try { const raw = backend && backend.getItem(STORE_KEY); data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
      cache = sanitize(data) || empty();
      return cache;
    };
    const save = () => {
      try { if (backend) backend.setItem(STORE_KEY, JSON.stringify(cache)); return true; } catch (e) { return false; }
    };

    return {
      ROLES, ROLE_LABEL,
      // {labelKey: role}, the shape the engine reads
      roles() {
        const out = {};
        const labels = load().labels;
        Object.keys(labels).forEach(k => { out[k] = labels[k].role; });
        return out;
      },
      labels() {
        const labels = load().labels;
        return Object.keys(labels).map(k => Object.assign({ key: k }, labels[k])).sort((a, b) => b.at - a.at);
      },
      teach(text, role) {
        if (!ROLES.includes(role)) return null;
        const k = E.labelKey(text);
        if (!k) return null;
        load().labels[k] = { role, example: E.norm(text).slice(0, 120), at: Date.now() };
        save();
        return k;
      },
      forget(k) {
        delete load().labels[k];
        save();
      },
      profiles() {
        const p = load().profiles;
        return Object.keys(p).sort((a, b) => a.localeCompare(b)).map(name => Object.assign({ name }, p[name]));
      },
      saveProfile(name, S) {
        const nm = E.norm(name).slice(0, 80);
        if (!nm) return null;
        const clean = sanitizeSettings(S);
        load().profiles[nm] = { settings: clean, host: hostOf(clean.url), at: Date.now() };
        save();
        return nm;
      },
      deleteProfile(name) {
        delete load().profiles[name];
        save();
      },
      // the saved profile whose site matches this URL
      profileForUrl(url) {
        const h = hostOf(url);
        if (!h) return null;
        return this.profiles().find(p => p.host === h) || null;
      },
      template() { return load().template; },
      setTemplate(headers, name) {
        load().template = headers && headers.length ? { headers: headers.map(h => E.norm(h).slice(0, 120)).slice(0, 400), name: E.norm(name).slice(0, 120), at: Date.now() } : null;
        save();
      },
      exportJSON() {
        return JSON.stringify(Object.assign({ app: 'meta-bulk-builder', exportedAt: new Date().toISOString() }, load()), null, 2);
      },
      // merges by default; returns counts
      importJSON(text, replace) {
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
        const clean = sanitize(data);
        if (!clean) throw new Error('That file is not a Meta Bulk Builder memory export.');
        const cur = replace ? empty() : load();
        Object.assign(cur.labels, clean.labels);
        Object.assign(cur.profiles, clean.profiles);
        if (clean.template) cur.template = clean.template;
        cache = cur;
        save();
        return { labels: Object.keys(clean.labels).length, profiles: Object.keys(clean.profiles).length, template: !!clean.template };
      },
      clear() { cache = empty(); save(); }
    };
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
  }

  const ID = v => (/^\d{5,20}$/.test(String(v || '').replace(/^(?:o|tp):/, '')) ? String(v).replace(/^(?:o|tp):/, '') : '');
  const LOC_TYPES = ['country', 'region', 'city'];
  function sanitizeSettings(src) {
    const s = {};
    if (!src || typeof src !== 'object') return s;
    ['pageId', 'pixelId', 'leadFormId'].forEach(f => { const v = ID(src[f]); if (v) s[f] = v; });
    if (typeof src.url === 'string') s.url = src.url.slice(0, 2000);
    if (typeof src.urlTags === 'string') s.urlTags = src.urlTags.slice(0, 1000);
    if (E.CTAS.some(c => c[0] === src.cta)) s.cta = src.cta;
    if (Array.isArray(src.locations)) {
      s.locations = src.locations.filter(l => l && LOC_TYPES.includes(l.type) && typeof l.name === 'string').slice(0, 200).map(l => {
        const o = { type: l.type, name: l.name.slice(0, 120) };
        ['code', 'region', 'country', 'unit'].forEach(k => { if (typeof l[k] === 'string') o[k] = l[k].slice(0, 60); });
        if (l.radius != null && isFinite(+l.radius)) o.radius = +l.radius;
        return o;
      });
    }
    ['ageMin', 'ageMax'].forEach(f => { const n = parseInt(src[f], 10); if (n >= 13 && n <= 65) s[f] = n; });
    if (['all', 'men', 'women'].includes(src.gender)) s.gender = src.gender;
    if (['PAUSED', 'ACTIVE'].includes(src.status)) s.status = src.status;
    return s;
  }

  // Only keep known fields with the right types; anything else in the file is dropped.
  function sanitize(data) {
    if (!data || typeof data !== 'object' || data.version !== 1) return null;
    const out = empty();
    const labels = data.labels && typeof data.labels === 'object' ? data.labels : {};
    Object.keys(labels).forEach(k => {
      const v = labels[k];
      const kk = E.labelKey(k);
      if (!kk || !v || !ROLES.includes(v.role)) return;
      out.labels[kk] = { role: v.role, example: String(v.example || k).slice(0, 120), at: +v.at || 0 };
    });
    const profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};
    Object.keys(profiles).forEach(name => {
      const p = profiles[name];
      if (!p || typeof p.settings !== 'object') return;
      const s = sanitizeSettings(p.settings);
      const nm = E.norm(name).slice(0, 80);
      if (nm) out.profiles[nm] = { settings: s, host: typeof p.host === 'string' ? p.host.slice(0, 255) : hostOf(s.url), at: +p.at || 0 };
    });
    const t = data.template;
    if (t && Array.isArray(t.headers) && t.headers.length) {
      out.template = { headers: t.headers.filter(h => typeof h === 'string').map(h => E.norm(h).slice(0, 120)).slice(0, 400), name: typeof t.name === 'string' ? t.name.slice(0, 120) : '', at: +t.at || 0 };
    }
    return out;
  }

  const api = { create, ROLES, ROLE_LABEL, PROFILE_FIELDS, sanitizeSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MBMemory = api;
})(typeof window !== 'undefined' ? window : globalThis);
