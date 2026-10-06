/* Meta Bulk Builder page: wires the engine, readers, memory and AI reader to the interface. */
(function () {
  'use strict';
  const E = window.MBEngine;
  const R = window.MBReaders;
  const AI = window.MBAI;
  const mem = window.MBMemory.create();
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w, p) => n + ' ' + (n === 1 ? w : (p || w + 's'));
  const clone = o => JSON.parse(JSON.stringify(o));
  const pad = n => String(n).padStart(2, '0');
  const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const money = n => (Math.round(n * 100) / 100).toLocaleString('en-US');
  const numOrNull = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
  const opt = (v, label, sel) => '<option value="' + esc(v) + '"' + (String(sel == null ? '' : sel) === String(v) ? ' selected' : '') + '>' + esc(label) + '</option>';
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }
  };
  // Opened as a Claude artifact on claude.ai: AI reading runs on the viewer's plan and files save through Claude
  const inClaude = !!(window.claude && typeof window.claude.use === 'function');

  const DEFAULTS = { pageId: '', pixelId: '', leadFormId: '', url: '', urlTags: '', cta: 'LEARN_MORE', locations: [], ageMin: 18, ageMax: 65, gender: 'all', status: 'PAUSED', scope: 'ads' };
  const S = clone(DEFAULTS);
  const setS = obj => { Object.keys(S).forEach(k => delete S[k]); Object.assign(S, clone(DEFAULTS), clone(obj)); };
  const EMPTY_MODEL = () => ({ name: '', title: '', campaigns: [], adSets: [], ads: [], notes: [], skipped: [], detected: {} });
  const state = {
    source: null, model: EMPTY_MODEL(), ruleModel: null, readMode: 'rules', aiInfo: '',
    isSample: false, open: new Set(), v: { errors: [], warnings: [] }, dirty: false,
    profileName: '', profilePicked: false, profileApplied: '', aiAbort: null, template: null
  };

  /* downloads: Claude's download capability when this runs as a Claude artifact, a normal browser download otherwise */
  let dlApi = null;
  const dlReady = (async () => {
    try { dlApi = inClaude ? await window.claude.use('downloads') : null; } catch (e) { dlApi = null; }
    return dlApi;
  })();
  async function saveFile(filename, data, mime) {
    const api = dlApi || await dlReady;
    if (api) { await api.save({ filename, data }); return; }
    const url = URL.createObjectURL(new Blob([data], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function copyText(text) {
    let p;
    try { p = navigator.clipboard.writeText(text); } catch (e) { p = Promise.reject(e); }
    return p;
  }

  const findC = id => state.model.campaigns.find(c => c.id === id) || null;
  const findSet = id => id ? state.model.adSets.find(a => a.id === id) || null : null;
  const findAd = id => state.model.ads.find(a => a.id === id) || null;
  const setsOf = c => state.model.adSets.filter(a => a.campaignId === c.id);
  const adsOf = a => state.model.ads.filter(x => x.adSetId === a.id);

  /* ---------------- settings ---------------- */
  function buildSettingsUI() {
    const sel = $('#locAdd');
    E.COUNTRIES.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach(c => { const o = document.createElement('option'); o.value = c.code; o.textContent = c.name; sel.appendChild(o); });
    $('#ctaSel').innerHTML = E.CTAS.map(c => opt(c[0], c[1], S.cta)).join('');
    const bindText = (id, key, clean) => $('#' + id).addEventListener('input', e => { S[key] = clean ? clean(e.target.value) : e.target.value.trim(); updateAllFeeds(); refresh(); });
    bindText('pageId', 'pageId', v => v.trim().replace(/^o:/, ''));
    bindText('pixelId', 'pixelId', v => v.trim().replace(/^tp:/, ''));
    bindText('leadFormId', 'leadFormId');
    bindText('siteUrl', 'url');
    bindText('urlTags', 'urlTags', v => v.trim().replace(/^\?/, ''));
    $('#ctaSel').addEventListener('change', e => { S.cta = e.target.value; rerenderOpenSets(); refresh(); });
    sel.addEventListener('change', e => {
      const code = e.target.value; if (!code) return;
      if (!S.locations.some(l => l.type === 'country' && l.code === code)) S.locations.push({ type: 'country', code, name: E.countryName(code) });
      e.target.value = ''; renderLocations(); refresh();
    });
    const addCustom = () => {
      const inp = $('#locCustom'); const v = E.norm(inp.value); if (!v) return;
      const r = E.parseLocations(v);
      r.list.forEach(loc => { if (!S.locations.some(l => E.locLabel(l) === E.locLabel(loc))) S.locations.push(loc); });
      if (r.notes.length) toast(r.notes[0], true);
      else if (!r.list.length) toast('Could not read that place. Try "City, ST" or a country.', true);
      inp.value = ''; renderLocations(); refresh();
    };
    $('#locCustomAdd').addEventListener('click', addCustom);
    $('#locCustom').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } });
    $('#locChips').addEventListener('click', e => {
      const b = e.target.closest('button[data-loc]'); if (!b) return;
      S.locations.splice(+b.dataset.loc, 1); renderLocations(); refresh();
    });
    $('#ageMin').addEventListener('input', e => { S.ageMin = numOrNull(e.target.value) == null ? 18 : +e.target.value; refresh(); });
    $('#ageMax').addEventListener('input', e => { S.ageMax = numOrNull(e.target.value) == null ? 65 : +e.target.value; refresh(); });
    $$('input[name="gender"]').forEach(r => r.addEventListener('change', e => { S.gender = e.target.value; rerenderOpenSets(); refresh(); }));
    $$('input[name="status"]').forEach(r => r.addEventListener('change', e => { S.status = e.target.value; refresh(); }));
    $$('input[name="scope"]').forEach(r => r.addEventListener('change', e => { S.scope = e.target.value; refresh(); }));

    $('#profileSel').addEventListener('change', e => {
      const name = e.target.value;
      state.profileName = name;
      state.profilePicked = !!name;
      const p = mem.profiles().find(x => x.name === name);
      if (p) { setS(Object.assign({}, S, p.settings)); syncSettingsUI(); updateAllFeeds(); refresh(); toast('Applied the ' + name + ' profile.'); }
      $('#profileDel').hidden = !name;
    });
    $('#profileSave').addEventListener('click', () => {
      let host = '';
      try { host = new URL(S.url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
      $('#profileName').value = state.profileName || host || (state.model.title || '').slice(0, 40);
      $('#profileNameRow').hidden = false;
      $('#profileName').focus(); $('#profileName').select();
    });
    const saveProfile = () => {
      const saved = mem.saveProfile($('#profileName').value, S);
      if (!saved) { toast('Give the profile a name.', true); return; }
      $('#profileNameRow').hidden = true;
      state.profileName = saved; state.profilePicked = true; renderProfiles(); toast('Saved the ' + saved + ' profile.');
    };
    $('#profileNameOk').addEventListener('click', saveProfile);
    $('#profileName').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveProfile(); } if (e.key === 'Escape') $('#profileNameRow').hidden = true; });
    $('#profileNameCancel').addEventListener('click', () => { $('#profileNameRow').hidden = true; });
    $('#profileDel').addEventListener('click', () => {
      const name = state.profileName; if (!name) return;
      const p = mem.profiles().find(x => x.name === name);
      mem.deleteProfile(name); state.profileName = ''; state.profilePicked = false; renderProfiles();
      toast('Deleted the ' + name + ' profile.', false, p ? () => { mem.saveProfile(name, p.settings); state.profileName = name; renderProfiles(); } : null);
    });
  }
  function renderProfiles() {
    const sel = $('#profileSel');
    sel.innerHTML = '<option value="">No profile</option>' + mem.profiles().map(p => opt(p.name, p.name, '')).join('');
    sel.value = state.profileName && mem.profiles().some(p => p.name === state.profileName) ? state.profileName : '';
    $('#profileDel').hidden = !sel.value;
  }
  function renderLocations() {
    const chips = S.locations.map((l, i) => '<span class="chip' + (l.type === 'city' && !l.country ? ' bad' : '') + '">' + esc(E.locLabel(l)) + (l.type === 'country' ? ' <span class="mono">' + esc(l.code) + '</span>' : '') + '<button type="button" data-loc="' + i + '" aria-label="Remove ' + esc(l.name) + '">&times;</button></span>');
    $('#locChips').innerHTML = chips.length ? chips.join('') : '<span class="hint">No default location. Ad sets without their own need one.</span>';
    $$('[data-locph]').forEach(el => { el.placeholder = locDefaultText(); });
  }
  const locDefaultText = () => S.locations.length ? 'Account default: ' + S.locations.map(E.locLabel).join('; ') : 'e.g. Austin, TX + 15 mi; United States';
  function syncSettingsUI() {
    $('#pageId').value = S.pageId; $('#pixelId').value = S.pixelId; $('#leadFormId').value = S.leadFormId;
    $('#siteUrl').value = S.url; $('#urlTags').value = S.urlTags; $('#ctaSel').value = S.cta;
    $('#ageMin').value = S.ageMin; $('#ageMax').value = S.ageMax;
    const g = $('input[name="gender"][value="' + S.gender + '"]'); if (g) g.checked = true;
    const st = $('input[name="status"][value="' + S.status + '"]'); if (st) st.checked = true;
    const sc = $('input[name="scope"][value="' + S.scope + '"]'); if (sc) sc.checked = true;
    renderLocations(); renderProfiles();
  }

  // What the doc says goes on top of the current settings. Returns the list of things taken from the doc.
  function applyDetected(model) {
    const d = model.detected || {};
    const picked = [];
    if (d.url) { S.url = d.url; picked.push('website'); }
    if (d.pageId) { S.pageId = d.pageId; picked.push('Page ID'); }
    if (d.pixelId) { S.pixelId = d.pixelId; picked.push('pixel ID'); }
    if (d.leadFormId) { S.leadFormId = d.leadFormId; picked.push('lead form ID'); }
    if (d.urlTags) { S.urlTags = d.urlTags; picked.push('URL parameters'); }
    if (d.cta) { S.cta = d.cta; picked.push('call to action'); }
    if (d.locations && d.locations.length) { S.locations = clone(d.locations); picked.push('locations'); }
    if (d.ageMin) { S.ageMin = d.ageMin; S.ageMax = d.ageMax || 65; picked.push('age'); }
    if (d.gender) { S.gender = d.gender; picked.push('gender'); }
    return picked;
  }
  // A new doc starts from clean defaults, so one client's settings never leak into the next. A profile you picked
  // yourself stays on; otherwise the profile whose site matches the doc's website is used, for this doc only.
  function freshSettings(model) {
    const d = model.detected || {};
    let prof = state.profilePicked ? mem.profiles().find(p => p.name === state.profileName) : null;
    if (!prof) prof = d.url ? mem.profileForUrl(d.url) : null;
    state.profileName = prof ? prof.name : '';
    setS(prof ? prof.settings : {});
    state.profileApplied = prof ? prof.name : '';
    return applyDetected(model);
  }

  /* ---------------- loading ---------------- */
  const parseSource = src => E.parseBlocksToModel(src.blocks, src.name, { memory: mem.roles() });

  function loadModel(model, opts) {
    opts = opts || {};
    state.model = model;
    state.isSample = !!opts.sample;
    state.dirty = false;
    state.open = new Set(model.adSets[0] ? [model.adSets[0].id] : []);
    model._picked = opts.fresh ? freshSettings(model) : applyDetected(model);
    syncSettingsUI(); renderDoc(); renderTree(); renderReport(); refresh();
    if (opts.announce) {
      if (model.adSets.length) toast('Read ' + (model.name || 'the doc') + ': ' + plural(model.campaigns.length, 'campaign') + ', ' + plural(model.adSets.length, 'ad set') + ', ' + plural(model.ads.length, 'ad') + '.');
      else toast('No Meta campaigns found in ' + (model.name || 'the doc') + '. Check the import report, or try AI reading.', true);
    }
  }
  function loadSource(src, opts) {
    state.source = src;
    state.readMode = 'rules'; state.aiInfo = '';
    $('#aiBack').hidden = true; $('#aiProgress').textContent = '';
    idleAIState();
    state.ruleModel = parseSource(src);
    loadModel(state.ruleModel, Object.assign({ fresh: true, announce: true }, opts || {}));
  }
  function reread() {
    if (!state.source) return;
    state.ruleModel = parseSource(state.source);
    state.readMode = 'rules';
    $('#aiBack').hidden = true;
    loadModel(state.ruleModel, { announce: true, sample: state.isSample });
  }

  function renderDoc() {
    const m = state.model;
    const has = !!state.source;
    $('#docbar').hidden = !has;
    $('#aiQuick').hidden = !has;
    $('#docName').textContent = m.name || 'Untitled doc';
    const ext = /\.([a-z0-9]{2,5})$/i.exec(m.name || '');
    $('#docBadge').textContent = ext ? ext[1].toUpperCase() : 'TEXT';
    $('#sampleTag').hidden = !state.isSample;
    const tag = $('#modeTag');
    tag.textContent = state.readMode === 'ai' ? 'Read by AI' : 'Read by rules';
    tag.className = 'mode-tag' + (state.readMode === 'ai' ? ' ai' : '');
    const notes = [];
    if (state.isSample) notes.push({ level: 'info', msg: 'This is a made-up sample. Add any Page ID to see a clean export, then load your own doc.' });
    if (state.readMode === 'ai' && state.aiInfo) notes.push({ level: 'info', msg: state.aiInfo });
    if (state.profileApplied) notes.push({ level: 'info', msg: 'Client profile "' + state.profileApplied + '" applied.' });
    if (m._picked && m._picked.length) notes.push({ level: 'info', msg: 'Taken from the doc: ' + m._picked.join(', ') + '.' });
    m.notes.forEach(n => notes.push(n));
    $('#notes').innerHTML = notes.map(n => '<div class="note ' + (n.level === 'warn' ? 'warn' : n.level === 'err' ? 'err' : 'info') + '">' + esc(n.msg) + '</div>').join('');
    $('#formatHelp').open = has && !m.adSets.length;
  }

  /* ---------------- import report ---------------- */
  const MAIN_KINDS = new Set(['line', 'value', 'ai', 'table', 'lp']);
  function currentSet() {
    const openId = [...state.open].pop();
    return findSet(openId) || state.model.adSets[0] || null;
  }
  function reportOptions(entry) {
    const a = findSet(entry.adSetId) || currentSet();
    const target = a ? esc(a.name) : 'the first ad set';
    return '<option value="">Use as…</option>'
      + (state.model.adSets.length ? '<optgroup label="Add to ' + target + '">'
        + '<option value="add:primary">Add as primary text (new ad)</option>'
        + '<option value="add:headline">Add as headline</option>'
        + '<option value="add:description">Add as description</option>'
        + '<option value="add:interests">Add as interest</option>'
        + '<option value="add:audiences">Add as custom audience</option>'
        + '<option value="add:exclusions">Add as exclusion</option></optgroup>' : '')
      + (state.readMode === 'rules' ? '<optgroup label="Teach: lines like this are">'
        + '<option value="teach:primary">a primary text label</option>'
        + '<option value="teach:headline">a headlines label</option>'
        + '<option value="teach:description">a descriptions label</option>'
        + '<option value="teach:interests">an interests label</option>'
        + '<option value="teach:audiences">a custom audiences label</option>'
        + '<option value="teach:exclusions">an exclusions label</option>'
        + '<option value="teach:audience">an audience description label</option>'
        + '<option value="teach:locations">a locations label</option>'
        + '<option value="teach:adset">an ad set name</option>'
        + '<option value="teach:campaign">a campaign name</option>'
        + '<option value="teach:ad">an ad name</option>'
        + '<option value="teach:other">a section to skip</option>'
        + '<option value="teach:ignore">always ignore this line</option></optgroup>' : '');
  }
  function reportRow(entry, ix) {
    return '<li><div><div class="txt">' + esc(entry.text) + '</div><div class="why">' + esc(entry.reason) + '</div></div>'
      + '<select data-rep="' + ix + '" aria-label="What is this line?">' + reportOptions(entry) + '</select></li>';
  }
  function renderReport() {
    const list = state.model.skipped || [];
    const main = [], more = [];
    list.forEach((e, i) => (MAIN_KINDS.has(e.kind) ? main : more).push([e, i]));
    $('#reportPanel').hidden = !list.length;
    $('#reportTitle').textContent = 'Import report: ' + plural(list.length, 'line') + ' not used';
    $('#reportMain').innerHTML = main.length ? main.slice(0, 150).map(([e, i]) => reportRow(e, i)).join('') : '<li class="hint" style="display:block">Nothing inside the campaign sections was left out.</li>';
    $('#reportMoreBox').hidden = !more.length;
    $('#reportMoreSum').textContent = plural(more.length, 'other line') + ' (other platforms, keywords, notes and strategy sections)';
    $('#reportMore').innerHTML = more.slice(0, 200).map(([e, i]) => reportRow(e, i)).join('');
  }
  function newAd(a, from) {
    const base = from || adsOf(a)[0] || {};
    return { id: E.nid('a'), adSetId: a.id, name: 'Ad ' + (adsOf(a).length + 1), primary: '', headline: base.headline || '', description: base.description || '', cta: base.cta || '', url: base.url || '', displayLink: base.displayLink || '', urlTags: base.urlTags || '', format: base.format || '', media: '', imageHash: '', videoId: '' };
  }
  function insertAd(ad) {
    const ix = state.model.ads.map(x => x.adSetId).lastIndexOf(ad.adSetId);
    state.model.ads.splice(ix + 1, 0, ad);
  }
  function onReportChoice(sel) {
    const ix = +sel.dataset.rep;
    const entry = state.model.skipped[ix];
    const [act, what] = sel.value.split(':');
    if (!entry || !act) return;
    if (act === 'add') {
      const a = findSet(entry.adSetId) || currentSet();
      if (!a) { toast('Add an ad set first.', true); sel.value = ''; return; }
      const ads = adsOf(a);
      if (what === 'primary') {
        const empty = ads.find(x => !E.norm(x.primary));
        if (empty) empty.primary = entry.text;
        else { const ad = newAd(a); ad.primary = entry.text; insertAd(ad); }
      } else if (what === 'headline' || what === 'description') {
        const empty = ads.find(x => !E.norm(x[what]));
        if (empty) empty[what] = E.norm(entry.text);
        else { const ad = newAd(a, ads[0]); ad.primary = ads[0] ? ads[0].primary : ''; ad[what] = E.norm(entry.text); insertAd(ad); }
      } else {
        E.splitList(entry.text).forEach(x => { if (!a[what].includes(x)) a[what].push(x); });
      }
      state.model.skipped.splice(ix, 1);
      state.dirty = true;
      state.open.add(a.id);
      renderTree(); renderReport(); refresh();
      toast('Added to ' + a.name + '.');
      return;
    }
    if (act === 'teach') {
      mem.teach(entry.text, what);
      renderMemory();
      if (!state.dirty) { reread(); toast('Saved to memory and read the doc again.'); return; }
      sel.value = '';
      toast('Saved to memory. Read the doc again now? Your edits below would be lost.', false, () => { reread(); toast('Read the doc again.'); }, 'Read again');
    }
  }

  /* ---------------- tree ---------------- */
  const OBJ_NEEDS_LOC = new Set(['LEADS', 'SALES', 'ENGAGEMENT']);
  const LOCATIONS_FOR = {
    LEADS: [['website', 'Website'], ['form', 'Instant form'], ['messages', 'Messages'], ['calls', 'Calls']],
    SALES: [['website', 'Website'], ['messages', 'Messages']],
    ENGAGEMENT: [['', 'On your ad'], ['messages', 'Messages']]
  };
  const budgetHint = b => b && b.period === 'daily' && +b.amount > 0 ? 'About ' + money(b.amount * 30.4) + ' a month' : b && b.period === 'lifetime' ? 'For the whole run' : 'Per day';

  function campHTML(c) {
    const sets = setsOf(c);
    const goal = E.goalFor(c, null);
    const bud = c.budget || { amount: '', period: 'daily' };
    const locs = LOCATIONS_FOR[c.objective];
    return '<article class="camp" data-cid="' + esc(c.id) + '">' +
      '<div class="camp-head">' +
        '<div class="field grow"><label class="lbl" for="cn-' + c.id + '">Campaign</label><input id="cn-' + c.id + '" class="camp-name" data-cf="name" value="' + esc(c.name) + '" autocomplete="off"></div>' +
        '<div class="field"><label class="lbl" for="cobj-' + c.id + '">Objective</label><select id="cobj-' + c.id + '" data-cf="objective">' + opt('', 'Pick an objective', c.objective || '') + E.OBJECTIVES.map(o => opt(o[0], o[1], c.objective)).join('') + '</select></div>' +
        '<div class="field"><label class="lbl" for="cbl-' + c.id + '">Budget</label><select id="cbl-' + c.id + '" data-cf="budgetLevel">' + opt('campaign', 'Campaign budget', c.budgetLevel) + opt('adset', 'Ad set budgets', c.budgetLevel) + '</select></div>' +
        (c.budgetLevel === 'campaign'
          ? '<div class="field budget"><label class="lbl" for="cbud-' + c.id + '">Amount</label><div class="budget-row"><input id="cbud-' + c.id + '" type="number" min="0" step="0.01" inputmode="decimal" data-cf="budgetAmount" value="' + esc(bud.amount) + '" placeholder="e.g. 40">' +
            '<select data-cf="budgetPeriod" aria-label="Budget period">' + opt('daily', 'Daily', bud.period) + opt('lifetime', 'Lifetime', bud.period) + '</select></div><span class="budget-hint" data-bhint>' + esc(budgetHint(c.budget)) + '</span></div>'
          : '') +
        '<div class="camp-meta mono" data-cmeta></div>' +
        '<button type="button" class="btn btn-ghost btn-sm danger camp-x" data-act="del-camp">Remove</button>' +
      '</div>' +
      '<div class="camp-grid">' +
        (locs ? '<div class="field"><label class="lbl" for="cloc-' + c.id + '">Conversion location</label><select id="cloc-' + c.id + '" data-cf="conversionLocation">' + locs.map(([v, l]) => opt(v, l, c.conversionLocation || '')).join('') + '</select></div>' : '') +
        (goal === 'OFFSITE_CONVERSIONS' ? '<div class="field"><label class="lbl" for="cev-' + c.id + '">Conversion event</label><select id="cev-' + c.id + '" data-cf="event">' + opt('', 'Default (' + (E.EVENTS.find(e => e[0] === E.eventFor(c, null)) || [, ''])[1] + ')', c.event || '') + E.EVENTS.map(e => opt(e[0], e[1], c.event)).join('') + '</select></div>' : '') +
        (goal === 'LEAD_GENERATION' ? '<div class="field"><label class="lbl" for="clf-' + c.id + '">Lead form ID</label><input id="clf-' + c.id + '" data-cf="leadFormId" inputmode="numeric" value="' + esc(c.leadFormId || '') + '" placeholder="' + esc(S.leadFormId || 'Account default') + '" spellcheck="false"></div>' : '') +
        '<div class="field"><label class="lbl" for="csp-' + c.id + '">Special ad category</label><select id="csp-' + c.id + '" data-cf="special">' + E.SPECIAL.map(s => opt(s[0], s[1], c.special || 'NONE')).join('') + '</select></div>' +
        '<div class="field"><label class="lbl" for="cbs-' + c.id + '">Bid strategy</label><select id="cbs-' + c.id + '" data-cf="bidStrategy">' + E.BID_STRATEGIES.map(b => opt(b[0], b[1], c.bidStrategy)).join('') + '</select></div>' +
        (['COST_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(c.bidStrategy) ? '<div class="field"><label class="lbl" for="cba-' + c.id + '">' + (c.bidStrategy === 'COST_CAP' ? 'Cost per result goal' : 'Bid cap') + '</label><input id="cba-' + c.id + '" type="number" min="0" step="0.01" inputmode="decimal" data-cf="bidAmount" value="' + esc(c.bidAmount == null ? '' : c.bidAmount) + '"></div>' : '') +
        '<div class="field"><label class="lbl" for="cst-' + c.id + '">Start <span class="mono">optional</span></label><input id="cst-' + c.id + '" type="date" data-cf="startDate" value="' + esc(c.startDate) + '"></div>' +
        '<div class="field"><label class="lbl" for="cend-' + c.id + '">End <span class="mono">optional</span></label><input id="cend-' + c.id + '" type="date" data-cf="endDate" value="' + esc(c.endDate) + '"></div>' +
      '</div>' +
      (sets.length ? sets.map(a => setHTML(a, c)).join('') : '<div class="empty">No ad sets here yet.</div>') +
      '<div class="camp-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="add-set">+ Ad set</button></div>' +
    '</article>';
  }

  function setSummary(a) {
    const e = E.setEff(a, S);
    const loc = e.locations.length ? E.locLabel(e.locations[0]) + (e.locations.length > 1 ? ' +' + (e.locations.length - 1) : '') : 'no location';
    return plural(adsOf(a).length, 'ad') + ' · ' + loc + ' · ' + e.ageMin + '–' + e.ageMax + (e.ageMax === 65 ? '+' : '') + (e.gender !== 'all' ? ' · ' + (e.gender === 'women' ? 'Women' : 'Men') : '');
  }

  function placementsHTML(a) {
    const pl = a.placements || { mode: 'advantage' };
    const manual = pl.mode === 'manual';
    let out = '<div class="field"><label class="lbl" for="spl-' + a.id + '">Placements</label><select id="spl-' + a.id + '" data-f="placementsMode">' + opt('advantage', 'Advantage+ placements (recommended)', pl.mode) + opt('manual', 'Manual placements', pl.mode) + '</select>';
    if (manual) {
      out += '<div class="pl-grid">' + Object.keys(E.POSITIONS).map(p => '<fieldset><legend>' + esc(E.PLATFORM_LABEL[p]) + '</legend>' +
        E.POSITIONS[p].map(([v, l]) => '<label><input type="checkbox" data-pl="' + p + ':' + v + '"' + ((pl.positions[p] || []).includes(v) ? ' checked' : '') + '>' + esc(l) + '</label>').join('') + '</fieldset>').join('') + '</div>';
    }
    return out + '</div>';
  }

  function setHTML(a, c) {
    const isOpen = state.open.has(a.id);
    const head = '<summary><span class="caret" aria-hidden="true"></span><span class="ag-title" data-title>' + esc(a.name || 'Untitled ad set') + '</span>' +
      '<span class="ag-counts mono" data-counts></span><span class="pill-sm ok" data-state>Ready</span></summary>';
    if (!isOpen) return '<details class="ag" data-sid="' + esc(a.id) + '">' + head + '</details>';
    c = c || findC(a.campaignId);
    const goals = E.GOALS_BY_OBJECTIVE[c.objective] || [];
    const defGoal = E.goalFor(c, Object.assign({}, a, { goal: '' }));
    const bud = a.budget || { amount: '', period: 'daily' };
    const ads = adsOf(a);
    const manualCount = a.interests.length + a.audiences.length + a.exclusions.length;
    return '<details class="ag" data-sid="' + esc(a.id) + '" open>' + head + '<div class="ag-body">' +
      '<div class="set-grid">' +
        '<div class="field"><label class="lbl" for="sn-' + a.id + '">Ad set name</label><input id="sn-' + a.id + '" data-f="name" value="' + esc(a.name) + '" autocomplete="off"></div>' +
        (c.budgetLevel === 'adset' ? '<div class="field"><label class="lbl" for="sb-' + a.id + '">Ad set budget</label><div class="budget-row"><input id="sb-' + a.id + '" type="number" min="0" step="0.01" inputmode="decimal" data-f="budgetAmount" value="' + esc(bud.amount) + '" placeholder="e.g. 20">' +
          '<select data-f="budgetPeriod" aria-label="Budget period">' + opt('daily', 'Daily', bud.period) + opt('lifetime', 'Lifetime', bud.period) + '</select></div></div>' : '') +
        (goals.length ? '<div class="field"><label class="lbl" for="sgoal-' + a.id + '">Performance goal</label><select id="sgoal-' + a.id + '" data-f="goal">' + opt('', 'Default (' + (E.GOALS[defGoal] || defGoal) + ')', a.goal || '') + goals.map(g => opt(g, E.GOALS[g] || g, a.goal)).join('') + '</select></div>' : '') +
        '<div class="field"><label class="lbl" for="sst-' + a.id + '">Start <span class="mono">optional</span></label><input id="sst-' + a.id + '" type="date" data-f="startDate" value="' + esc(a.startDate) + '"></div>' +
        '<div class="field"><label class="lbl" for="send-' + a.id + '">End <span class="mono">optional</span></label><input id="send-' + a.id + '" type="date" data-f="endDate" value="' + esc(a.endDate) + '"></div>' +
      '</div>' +
      '<div class="target-grid">' +
        '<div class="field" style="gap:10px">' +
          '<div class="field"><label class="lbl" for="sloc-' + a.id + '">Locations</label><input id="sloc-' + a.id + '" data-f="locations" data-locph value="' + esc(a.locations.map(E.locLabel).join('; ')) + '" placeholder="' + esc(locDefaultText()) + '" autocomplete="off" spellcheck="false">' +
            '<div class="loc-chips" data-locchips>' + locChips(a) + '</div></div>' +
          '<div class="set-grid">' +
            '<div class="field"><label class="lbl" for="sagemin-' + a.id + '">Age from</label><input id="sagemin-' + a.id + '" type="number" min="13" max="65" inputmode="numeric" data-f="ageMin" value="' + esc(a.ageMin == null ? '' : a.ageMin) + '" placeholder="' + esc(S.ageMin) + '"></div>' +
            '<div class="field"><label class="lbl" for="sagemax-' + a.id + '">Age to <span class="mono">65 = 65+</span></label><input id="sagemax-' + a.id + '" type="number" min="13" max="65" inputmode="numeric" data-f="ageMax" value="' + esc(a.ageMax == null ? '' : a.ageMax) + '" placeholder="' + esc(S.ageMax) + '"></div>' +
            '<div class="field"><label class="lbl" for="sgen-' + a.id + '">Gender</label><select id="sgen-' + a.id + '" data-f="gender">' + opt('', 'Default (' + ({ all: 'All', women: 'Women', men: 'Men' }[S.gender] || 'All') + ')', a.gender || '') + opt('all', 'All', a.gender) + opt('women', 'Women', a.gender) + opt('men', 'Men', a.gender) + '</select></div>' +
          '</div>' +
          placementsHTML(a) +
        '</div>' +
        '<div class="field" style="gap:10px">' +
          '<div class="field"><label class="lbl" for="sint-' + a.id + '">Interests and behaviours ' + (manualCount ? '<span class="manual-tag">Added after import</span>' : '') + '</label><textarea id="sint-' + a.id + '" class="list-area" data-f="interests" spellcheck="false" placeholder="One per line">' + esc(a.interests.join('\n')) + '</textarea></div>' +
          '<div class="field"><label class="lbl" for="saud-' + a.id + '">Custom and lookalike audiences</label><textarea id="saud-' + a.id + '" class="list-area" data-f="audiences" spellcheck="false" placeholder="e.g. Website visitors (30 days)">' + esc(a.audiences.join('\n')) + '</textarea></div>' +
          '<div class="field"><label class="lbl" for="sexc-' + a.id + '">Exclude</label><textarea id="sexc-' + a.id + '" class="list-area" data-f="exclusions" spellcheck="false" placeholder="e.g. Purchasers (30 days)">' + esc(a.exclusions.join('\n')) + '</textarea></div>' +
          (a.notes && a.notes.length ? '<div class="doc-notes"><b>Audience in the doc</b>' + a.notes.map(n => '<span>' + esc(n) + '</span>').join('') + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="ads">' + ads.map(ad => adHTML(ad, a, c)).join('') + '</div>' +
      '<div class="row"><button type="button" class="btn btn-ghost btn-sm" data-act="add-ad">+ Ad</button></div>' +
      '<div class="ag-foot"><ul class="ag-issues" data-issues></ul><button type="button" class="btn btn-ghost btn-sm danger" data-act="del-set">Remove ad set</button></div>' +
    '</div></details>';
  }
  const locChips = a => a.locations.length
    ? a.locations.map(l => '<span class="chip' + (l.type === 'city' && !l.country ? ' bad' : '') + '">' + esc(E.locLabel(l)) + '</span>').join('')
    : '<span class="hint">' + (S.locations.length ? 'Uses the account locations.' : 'No location yet.') + '</span>';

  const counter = (id, len, max) => '<span class="cnt mono' + (len > max ? ' over' : '') + '" data-cnt="' + id + '">' + len + '/' + max + '</span>';
  function adHTML(ad, a, c) {
    const id = ad.id;
    const fmt = ad.format || '';
    const defCta = E.ctaLabel(S.cta);
    return '<div class="ad" data-aid="' + esc(id) + '">' +
      '<div class="ad-fields">' +
        '<div class="ad-top"><input id="an-' + id + '" data-af="name" value="' + esc(ad.name) + '" aria-label="Ad name" autocomplete="off">' +
          '<div class="row"><button type="button" class="btn btn-ghost btn-sm" data-act="dup-ad">Duplicate</button><button type="button" class="x" data-act="del-ad" aria-label="Remove ' + esc(ad.name) + '">&times;</button></div></div>' +
        '<div class="field"><div class="cnt-row"><label class="lbl" for="primary-' + id + '">Primary text</label>' + counter('primary-' + id, E.textLen(ad.primary), E.LIMITS.primary) + '</div>' +
          '<textarea id="primary-' + id + '" class="primary-area" data-af="primary" rows="4">' + esc(ad.primary) + '</textarea></div>' +
        '<div class="ad-grid">' +
          '<div class="field"><div class="cnt-row"><label class="lbl" for="headline-' + id + '">Headline</label>' + counter('headline-' + id, E.textLen(ad.headline), E.LIMITS.headline) + '</div><input id="headline-' + id + '" data-af="headline" value="' + esc(ad.headline) + '" autocomplete="off"></div>' +
          '<div class="field"><div class="cnt-row"><label class="lbl" for="description-' + id + '">Description</label>' + counter('description-' + id, E.textLen(ad.description), E.LIMITS.description) + '</div><input id="description-' + id + '" data-af="description" value="' + esc(ad.description) + '" autocomplete="off"></div>' +
        '</div>' +
        '<div class="ad-grid">' +
          '<div class="field"><label class="lbl" for="cta-' + id + '">Call to action</label><select id="cta-' + id + '" data-af="cta">' + opt('', 'Default (' + defCta + ')', ad.cta || '') + E.CTAS.map(x => opt(x[0], x[1], ad.cta)).join('') + '</select></div>' +
          '<div class="field"><label class="lbl" for="url-' + id + '">Website URL</label><input id="url-' + id + '" type="url" data-af="url" value="' + esc(ad.url) + '" placeholder="' + esc(S.url || 'Account default') + '" spellcheck="false"></div>' +
          '<div class="field"><label class="lbl" for="fmt-' + id + '">Format</label><select id="fmt-' + id + '" data-af="format">' + opt('', 'Not set', fmt) + opt('image', 'Single image', fmt) + opt('video', 'Video', fmt) + opt('carousel', 'Carousel', fmt) + '</select></div>' +
          (fmt === 'video'
            ? '<div class="field"><label class="lbl" for="vid-' + id + '">Video ID <span class="mono">optional</span></label><input id="vid-' + id + '" data-af="videoId" inputmode="numeric" value="' + esc(ad.videoId) + '" placeholder="From Media library" spellcheck="false"></div>'
            : '<div class="field"><label class="lbl" for="img-' + id + '">Image hash <span class="mono">optional</span></label><input id="img-' + id + '" data-af="imageHash" value="' + esc(ad.imageHash) + '" placeholder="From Media library" spellcheck="false"></div>') +
        '</div>' +
        (ad.media ? '<div class="media-note">Creative in the doc: ' + esc(ad.media) + '</div>' : '') +
      '</div>' +
      '<div><div class="feed-label">Feed preview</div><div class="feed" data-feed>' + feedInner(ad) + '</div></div>' +
    '</div>';
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'example.com'; } }
  const pageName = () => state.profileName || (state.model.title || '').replace(/\s*[–—|:-]\s*.*$/, '').trim() || 'Your Page';
  function feedInner(ad) {
    const text = String(ad.primary || '');
    const cut = Array.from(text);
    const shown = cut.length > E.LIMITS.primary ? cut.slice(0, E.LIMITS.primary).join('').replace(/\s+\S*$/, '') : text;
    const name = pageName();
    const fmt = ad.format === 'video' ? 'video' : ad.format === 'carousel' ? 'carousel' : 'image';
    return '<div class="feed-head"><div class="feed-av">' + esc(name.charAt(0).toUpperCase() || 'P') + '</div><div><div class="feed-name">' + esc(name) + '</div><div class="feed-sp">Sponsored</div></div></div>' +
      '<div class="feed-text">' + (text ? esc(shown) + (shown !== text ? '<span class="more">… See more</span>' : '') : '<span class="feed-sp">Add primary text to preview</span>') + '</div>' +
      '<div class="feed-media ' + fmt + '">' + esc(fmt === 'carousel' ? 'Carousel' : fmt === 'video' ? 'Video' : 'Image') + '</div>' +
      '<div class="feed-bar"><div style="min-width:0"><div class="feed-dom">' + esc(hostOf(ad.url || S.url)) + '</div><div class="feed-hl">' + esc(ad.headline || '') + '</div><div class="feed-ds">' + esc(ad.description || '') + '</div></div>' +
      (ad.cta === 'NO_BUTTON' || (!ad.cta && S.cta === 'NO_BUTTON') ? '' : '<span class="feed-cta">' + esc(E.ctaLabel(ad.cta || S.cta)) + '</span>') + '</div>';
  }
  function updateFeed(ad) { const el = $('[data-aid="' + ad.id + '"] [data-feed]'); if (el) el.innerHTML = feedInner(ad); }
  function updateAllFeeds() { state.model.ads.forEach(updateFeed); }

  function renderTree() {
    const m = state.model;
    if (!state.source && !m.campaigns.length) {
      $('#campaigns').innerHTML = '<div class="panel welcome"><h2>Start with a campaign doc</h2>' +
        '<p>Load a Word doc, an Excel workbook, a CSV or a text file with the Meta campaign structure, or paste the text. The tool finds the campaigns, ad sets, targeting and ad copy, checks them, and builds one file for Ads Manager\'s bulk import.</p>' +
        '<p>Nothing is uploaded. Lines it can\'t place show up in an import report, where you can teach it how your docs are written.</p>' +
        '<div class="row"><label for="fileIn" class="btn btn-primary" tabindex="0">Load campaign doc</label><button type="button" class="btn" data-act="sample">Try the sample</button></div></div>';
    } else {
      $('#campaigns').innerHTML = m.campaigns.length ? m.campaigns.map(campHTML).join('') : '<div class="panel empty">No Meta campaigns found. Check the import report above, try AI reading, or add a campaign by hand.</div>';
    }
    $('#toggleAll').textContent = state.open.size >= m.adSets.length && m.adSets.length ? 'Collapse all' : 'Expand all';
  }
  function rerenderSet(a) {
    const el = $('details.ag[data-sid="' + a.id + '"]');
    if (el) el.outerHTML = setHTML(a);
  }
  function rerenderCamp(c) {
    const el = $('article.camp[data-cid="' + c.id + '"]');
    if (el) el.outerHTML = campHTML(c);
  }
  function rerenderOpenSets() { state.model.adSets.forEach(a => { if (state.open.has(a.id)) rerenderSet(a); }); }
  function updateCounter(id, len, max) {
    const c = $('[data-cnt="' + id + '"]'); if (!c) return;
    c.textContent = len + '/' + max; c.classList.toggle('over', len > max);
  }

  function bindTree() {
    const root = $('#campaigns');
    const linesOf = v => String(v).split(/\r?\n/).map(E.norm).filter(Boolean);
    root.addEventListener('input', e => {
      const t = e.target;
      const cEl = t.closest('[data-cid]');
      if (t.dataset.cf && cEl && !t.closest('[data-sid]')) {
        const c = findC(cEl.dataset.cid); const f = t.dataset.cf;
        if (f === 'name') c.name = t.value;
        else if (f === 'budgetAmount') { const n = numOrNull(t.value); c.budget = n == null ? null : { amount: n, period: (c.budget && c.budget.period) || 'daily', basis: (c.budget && c.budget.period) || 'daily' }; const h = $('[data-bhint]', cEl); if (h) h.textContent = budgetHint(c.budget); }
        else if (f === 'bidAmount') c.bidAmount = numOrNull(t.value);
        else if (f === 'leadFormId') c.leadFormId = t.value.trim();
        else if (f === 'startDate' || f === 'endDate') c[f] = t.value;
        else return;
        state.dirty = true; refresh(); return;
      }
      const sEl = t.closest('[data-sid]');
      const aEl = t.closest('[data-aid]');
      if (t.dataset.af && aEl) {
        const ad = findAd(aEl.dataset.aid); const f = t.dataset.af;
        if (['name', 'primary', 'headline', 'description', 'url', 'imageHash', 'videoId'].includes(f)) {
          ad[f] = f === 'primary' ? t.value : t.value.trim();
          if (f === 'primary' || f === 'headline' || f === 'description') updateCounter(f + '-' + ad.id, E.textLen(t.value), E.LIMITS[f]);
          updateFeed(ad); state.dirty = true; refresh();
        }
        return;
      }
      if (!sEl || !t.dataset.f) return;
      const a = findSet(sEl.dataset.sid); const f = t.dataset.f;
      if (f === 'name') { a.name = t.value; $('[data-title]', sEl).textContent = t.value || 'Untitled ad set'; }
      else if (f === 'budgetAmount') { const n = numOrNull(t.value); a.budget = n == null ? null : { amount: n, period: (a.budget && a.budget.period) || 'daily', basis: 'daily' }; }
      else if (f === 'ageMin' || f === 'ageMax') a[f] = numOrNull(t.value);
      else if (f === 'startDate' || f === 'endDate') a[f] = t.value;
      else if (f === 'interests' || f === 'audiences' || f === 'exclusions') a[f] = linesOf(t.value);
      else return;
      state.dirty = true; refresh();
    });
    root.addEventListener('change', e => {
      const t = e.target;
      const cEl = t.closest('[data-cid]');
      const sEl = t.closest('[data-sid]');
      const aEl = t.closest('[data-aid]');
      state.dirty = true;
      if (t.dataset.cf && cEl && !sEl) {
        const c = findC(cEl.dataset.cid); const f = t.dataset.cf;
        if (f === 'objective') { c.objective = t.value || null; if (!LOCATIONS_FOR[c.objective] || !LOCATIONS_FOR[c.objective].some(x => x[0] === (c.conversionLocation || ''))) c.conversionLocation = LOCATIONS_FOR[c.objective] ? LOCATIONS_FOR[c.objective][0][0] || null : null; setsOf(c).forEach(a => { a.goal = ''; }); }
        else if (f === 'budgetLevel') switchBudgetLevel(c, t.value);
        else if (f === 'budgetPeriod') { c.budget = Object.assign({ amount: '' }, c.budget || {}, { period: t.value, basis: t.value }); }
        else if (f === 'conversionLocation') { c.conversionLocation = t.value || null; setsOf(c).forEach(a => { a.goal = ''; }); }
        else if (f === 'event') { c.event = t.value; setsOf(c).forEach(a => { a.event = ''; }); }
        else if (f === 'special') c.special = t.value;
        else if (f === 'bidStrategy') { c.bidStrategy = t.value; if (!['COST_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(t.value)) c.bidAmount = null; }
        else return;
        rerenderCamp(c); refresh();
        return;
      }
      if (t.dataset.af && aEl) {
        const ad = findAd(aEl.dataset.aid); const f = t.dataset.af;
        if (f === 'cta') { ad.cta = t.value; updateFeed(ad); refresh(); }
        else if (f === 'format') { ad.format = t.value; if (t.value === 'video') ad.imageHash = ''; else ad.videoId = ''; rerenderSet(findSet(ad.adSetId)); refresh(); }
        return;
      }
      if (t.dataset.pl && sEl) {
        const a = findSet(sEl.dataset.sid);
        const positions = {};
        $$('[data-pl]', sEl).filter(x => x.checked).forEach(x => { const [p, v] = x.dataset.pl.split(':'); (positions[p] = positions[p] || []).push(v); });
        a.placements = { mode: 'manual', platforms: Object.keys(positions), positions };
        refresh(); return;
      }
      if (!sEl || !t.dataset.f) return;
      const a = findSet(sEl.dataset.sid); const f = t.dataset.f;
      if (f === 'locations') {
        const r = E.parseLocations(t.value);
        a.locations = r.list;
        if (r.notes.length) toast(r.notes[0], true);
        t.value = a.locations.map(E.locLabel).join('; ');
        $('[data-locchips]', sEl).innerHTML = locChips(a);
      } else if (f === 'gender') a.gender = t.value;
      else if (f === 'goal') a.goal = t.value;
      else if (f === 'budgetPeriod') a.budget = Object.assign({ amount: '' }, a.budget || {}, { period: t.value, basis: t.value });
      else if (f === 'placementsMode') {
        a.placements = t.value === 'manual' ? { mode: 'manual', platforms: ['facebook', 'instagram'], positions: { facebook: ['feed', 'story', 'facebook_reels'], instagram: ['stream', 'story', 'reels'] } } : { mode: 'advantage' };
        rerenderSet(a);
      } else return;
      refresh();
    });
    root.addEventListener('toggle', e => {
      const d = e.target; if (!d.matches || !d.matches('details.ag')) return;
      const id = d.dataset.sid;
      if (d.open && !state.open.has(id)) { state.open.add(id); rerenderSet(findSet(id)); refresh(); }
      else if (!d.open && state.open.has(id)) { state.open.delete(id); }
      $('#toggleAll').textContent = state.open.size >= state.model.adSets.length ? 'Collapse all' : 'Expand all';
    }, true);
    root.addEventListener('click', e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'sample') { loadSample(); return; }
      const cEl = b.closest('[data-cid]');
      const sEl = b.closest('[data-sid]');
      const aEl = b.closest('[data-aid]');
      const m = state.model;
      if (act === 'del-camp') {
        const c = findC(cEl.dataset.cid); const ix = m.campaigns.indexOf(c);
        const sets = setsOf(c), ads = m.ads.filter(x => sets.some(s => s.id === x.adSetId));
        m.campaigns.splice(ix, 1); m.adSets = m.adSets.filter(a => a.campaignId !== c.id); m.ads = m.ads.filter(x => !ads.includes(x));
        state.dirty = true; renderTree(); refresh();
        toast(c.name + ' removed.', false, () => { m.campaigns.splice(ix, 0, c); m.adSets = m.adSets.concat(sets); m.ads = m.ads.concat(ads); renderTree(); refresh(); });
        return;
      }
      if (act === 'add-set') {
        const c = findC(cEl.dataset.cid);
        const a = { id: E.nid('s'), campaignId: c.id, name: 'New ad set', budget: null, startDate: '', endDate: '', ageMin: null, ageMax: null, gender: '', locations: [], interests: [], audiences: [], exclusions: [], placements: { mode: 'advantage' }, goal: '', event: '', bidStrategy: '', bidAmount: null, notes: [] };
        const ix = m.adSets.map(x => x.campaignId).lastIndexOf(c.id);
        m.adSets.splice(ix + 1, 0, a);
        insertAd(Object.assign(newAd(a), { name: 'Ad 1' }));
        state.open.add(a.id); state.dirty = true; rerenderCamp(c); refresh();
        const n = $('#sn-' + a.id); if (n) { n.focus(); n.select(); }
        return;
      }
      if (!sEl) return;
      const a = findSet(sEl.dataset.sid);
      if (act === 'del-set') {
        const ix = m.adSets.indexOf(a); const ads = adsOf(a);
        m.adSets.splice(ix, 1); m.ads = m.ads.filter(x => x.adSetId !== a.id); state.open.delete(a.id); state.dirty = true;
        rerenderCamp(findC(a.campaignId)); refresh();
        toast(a.name + ' removed.', false, () => { m.adSets.splice(ix, 0, a); m.ads = m.ads.concat(ads); state.open.add(a.id); renderTree(); refresh(); });
        return;
      }
      if (act === 'add-ad') {
        const ad = newAd(a); insertAd(ad); state.dirty = true; rerenderSet(a); refresh();
        const f = $('#primary-' + ad.id); if (f) f.focus();
        return;
      }
      if (!aEl) return;
      const ad = findAd(aEl.dataset.aid);
      if (act === 'dup-ad') {
        const copy = Object.assign(clone(ad), { id: E.nid('a'), name: ad.name + ' copy' });
        m.ads.splice(m.ads.indexOf(ad) + 1, 0, copy); state.dirty = true; rerenderSet(a); refresh();
        const n = $('#an-' + copy.id); if (n) { n.focus(); n.select(); }
        return;
      }
      if (act === 'del-ad') {
        const ix = m.ads.indexOf(ad);
        m.ads.splice(ix, 1); state.dirty = true; rerenderSet(a); refresh();
        toast(ad.name + ' removed.', false, () => { m.ads.splice(ix, 0, ad); rerenderSet(a); refresh(); });
      }
    });

    $('#addCamp').addEventListener('click', () => {
      const m = state.model;
      const c = { id: E.nid('c'), name: 'New campaign', objective: null, conversionLocation: null, special: 'NONE', budget: null, budgetLevel: 'campaign', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', bidAmount: null, startDate: '', endDate: '', event: '', leadFormId: '' };
      m.campaigns.push(c);
      const a = { id: E.nid('s'), campaignId: c.id, name: 'Ad set 1', budget: null, startDate: '', endDate: '', ageMin: null, ageMax: null, gender: '', locations: [], interests: [], audiences: [], exclusions: [], placements: { mode: 'advantage' }, goal: '', event: '', bidStrategy: '', bidAmount: null, notes: [] };
      m.adSets.push(a);
      insertAd(Object.assign(newAd(a), { name: 'Ad 1' }));
      state.open.add(a.id);
      if (!state.source) { state.source = { name: 'Built by hand', kind: 'manual', blocks: [] }; m.name = 'Built by hand'; }
      renderDoc(); renderTree(); refresh();
      const n = $('#cn-' + c.id); if (n) { n.focus(); n.select(); }
    });
    $('#toggleAll').addEventListener('click', () => {
      const all = state.open.size >= state.model.adSets.length;
      state.open = all ? new Set() : new Set(state.model.adSets.map(a => a.id));
      renderTree(); refresh();
    });
    $('#reportPanel').addEventListener('change', e => { const s = e.target.closest('select[data-rep]'); if (s && s.value) onReportChoice(s); });
  }
  // Campaign budget <-> ad set budgets: the money moves with the switch
  function switchBudgetLevel(c, level) {
    const sets = setsOf(c);
    if (level === c.budgetLevel) return;
    if (level === 'adset') {
      const b = c.budget;
      sets.forEach(a => { if (!a.budget && b && +b.amount > 0) a.budget = { amount: Math.round(b.amount / sets.length * 100) / 100, period: b.period, basis: b.period }; });
      if (b && +b.amount > 0 && sets.length > 1) toast('Split the campaign budget evenly across ' + plural(sets.length, 'ad set') + '.');
      c.budget = null;
    } else {
      const bs = sets.map(a => a.budget).filter(b => b && +b.amount > 0);
      const period = bs.length && bs.every(b => b.period === bs[0].period) ? bs[0].period : 'daily';
      const sum = bs.filter(b => b.period === period).reduce((s, b) => s + +b.amount, 0);
      c.budget = sum > 0 ? { amount: Math.round(sum * 100) / 100, period, basis: period } : null;
      sets.forEach(a => { a.budget = null; });
      if (sum > 0) toast('Added the ad set budgets into one campaign budget of ' + money(sum) + '.');
    }
    c.budgetLevel = level;
  }

  /* ---------------- validation display ---------------- */
  let exportCache = null;
  function refresh() {
    const m = state.model;
    const v = state.v = E.validate(m, S, todayISO());
    exportCache = null;
    const has = !!state.source || m.campaigns.length > 0;

    $('#stC').textContent = m.campaigns.length;
    $('#stS').textContent = m.adSets.length;
    $('#stA').textContent = m.ads.length;
    const pill = $('#statusPill');
    pill.className = 'pill ' + (v.errors.length ? 'err' : v.warnings.length ? 'warn' : 'ok');
    pill.textContent = v.errors.length ? plural(v.errors.length, 'issue') + ' to fix' : v.warnings.length ? 'Ready, ' + plural(uniqMsgs(v.warnings).length, 'note') : 'Ready to export';

    $$('.bad').forEach(x => x.classList.remove('bad'));
    if (has) v.errors.forEach(er => { const el = fieldEl(er); if (el) el.classList.add('bad'); });

    m.campaigns.forEach(c => {
      const el = $('[data-cid="' + c.id + '"] [data-cmeta]'); if (!el) return;
      const sets = setsOf(c);
      el.textContent = plural(sets.length, 'ad set') + ' · ' + plural(m.ads.filter(x => sets.some(s => s.id === x.adSetId)).length, 'ad');
    });
    m.adSets.forEach(a => {
      const d = $('details.ag[data-sid="' + a.id + '"]'); if (!d) return;
      const errs = v.errors.filter(x => x.adSetId === a.id);
      const warns = v.warnings.filter(x => x.adSetId === a.id);
      $('[data-counts]', d).textContent = setSummary(a);
      const st = $('[data-state]', d);
      st.className = 'pill-sm ' + (errs.length ? 'err' : warns.length ? 'warn' : 'ok');
      st.textContent = errs.length ? errs.length + ' to fix' : warns.length ? plural(uniqMsgs(warns).length, 'note') : 'Ready';
      const list = $('[data-issues]', d);
      if (list) list.innerHTML = errs.map(x => '<li class="err">' + esc(x.msg) + '</li>').join('') + uniqMsgs(warns).map(x => '<li class="warn">' + esc(x) + '</li>').join('');
    });

    const ep = $('#exportPill');
    ep.className = 'pill-sm ' + (v.errors.length ? 'err' : 'ok');
    ep.textContent = v.errors.length ? plural(v.errors.length, 'issue') + ' to fix' : 'Ready';
    const errs = has ? v.errors.slice(0, 8) : [];
    $('#errList').innerHTML = errs.map((x, i) => '<li><button type="button" data-err="' + i + '">' + esc(x.msg) + '</button></li>').join('') +
      (has && v.errors.length > 8 ? '<li class="hint" style="padding:4px 2px">+' + (v.errors.length - 8) + ' more in the ad sets below</li>' : '');
    const t = getExport();
    const wm = has ? uniqMsgs(v.warnings).concat(t.missing && t.missing.length ? ['Your template has no column for: ' + t.missing.join(', ') + '. That data is left out of the file.'] : []) : [];
    $('#warnBox').hidden = !wm.length;
    $('#warnSum').textContent = plural(wm.length, 'note') + ' worth a look';
    $('#warnList').innerHTML = wm.map(x => '<li>' + esc(x) + '</li>').join('');
    const blocked = v.errors.length > 0;
    ['#dlXlsx', '#dlCsv', '#copyBtn'].forEach(s => $(s).setAttribute('aria-disabled', blocked ? 'true' : 'false'));
    $('#exportMeta').textContent = has ? t.rows.length + ' rows · ' + t.headers.length + ' columns · ' + fileBase() + '.xlsx' : '';
    renderAfter();
    if ($('#previewBox').open) renderPreview();
  }
  const uniqMsgs = arr => [...new Set(arr.map(x => x.msg))];
  function getExport() { if (!exportCache) exportCache = E.exportTable(state.model, S, state.template); return exportCache; }

  function fieldEl(er) {
    const f = er.field;
    if (er.adId) return f === 'urlTags' ? $('#urlTags') : f ? $('#' + f + '-' + er.adId) : null;
    if (er.adSetId) {
      if (f === 'budget') return $('#sb-' + er.adSetId);
      if (f === 'locations') return $('#sloc-' + er.adSetId);
      if (f === 'age') return $('#sagemin-' + er.adSetId);
      if (f === 'pixelId' || f === 'leadFormId') return $('#' + f);
      return null;
    }
    if (er.campaignId) {
      if (f === 'objective') return $('#cobj-' + er.campaignId);
      if (f === 'budget') return $('#cbud-' + er.campaignId);
      if (f === 'endDate') return $('#cend-' + er.campaignId);
      return null;
    }
    return f ? $('#' + f) : null;
  }
  function jumpTo(er) {
    if (er.adSetId && !state.open.has(er.adSetId)) { state.open.add(er.adSetId); rerenderSet(findSet(er.adSetId)); refresh(); }
    let el = fieldEl(er);
    if (!el && er.adSetId) el = $('details.ag[data-sid="' + er.adSetId + '"] summary');
    if (!el && er.campaignId) el = $('#cn-' + er.campaignId);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setTimeout(() => el.focus({ preventScroll: true }), 250);
  }

  function renderPreview() {
    const t = getExport();
    const used = t.headers.map((h, i) => i).filter(i => t.rows.some(r => r[i]));
    const rows = t.rows.slice(0, 80);
    $('#previewTable').innerHTML = '<thead><tr>' + used.map(i => '<th>' + esc(t.headers[i]) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + used.map(i => '<td>' + esc(String(r[i]).replace(/\n/g, ' ⏎ ')) + '</td>').join('') + '</tr>').join('') + '</tbody>';
  }

  /* ---------------- after import ---------------- */
  function renderAfter() {
    const list = E.checklist(state.model, S);
    const n = list.reduce((s, g) => s + g.items.reduce((t, it) => t + it.values.length, 0), 0);
    $('#afterPanel').hidden = !list.length;
    $('#afterCount').textContent = plural(n, 'item');
    $('#afterList').innerHTML = list.map(g => '<div class="after-set"><h4>' + esc(g.adSet) + ' <span>in ' + esc(g.campaign) + '</span></h4>' +
      g.items.map(it => '<div class="after-item"><b>' + esc(it.label) + '</b><ul>' + it.values.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul></div>').join('') + '</div>').join('');
  }

  /* ---------------- export ---------------- */
  function fileBase() {
    const base = (state.model.name || 'campaigns').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'campaigns';
    return base + '_Meta_Import';
  }
  function blockedNotice() {
    toast('Fix ' + plural(state.v.errors.length, 'issue') + ' before exporting. The first one is highlighted.', true);
    if (state.v.errors[0]) jumpTo(state.v.errors[0]);
  }
  function showFallback(text, kind) {
    $('#fallbackBox').hidden = false;
    $('#fallbackLbl').textContent = kind === 'csv'
      ? 'Saving files did not work here. Copy this text into a file named ' + fileBase() + '.csv.'
      : 'Copy did not go through. Select all of this text and copy it, then paste it under the headers of your template in Excel or Google Sheets.';
    const ta = $('#fallbackText'); ta.value = text; ta.focus(); ta.select();
  }
  const saveErr = (e, onOther) => {
    const code = e && e.code;
    if (code === 'declined') toast('Download cancelled.');
    else if (code === 'rate_limited') toast('A save prompt is already open.');
    else onOther();
  };
  function bindExport() {
    $('#dlXlsx').addEventListener('click', async () => {
      if (state.v.errors.length) return blockedNotice();
      const t = getExport();
      let data;
      try { data = await R.writeXlsx(t, window.JSZip, 'Ads'); } catch (e) { toast('Could not build the .xlsx here. Use Download CSV.', true); return; }
      try {
        await saveFile(fileBase() + '.xlsx', new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        toast('Saved ' + fileBase() + '.xlsx. Import it in Ads Manager.');
      } catch (e) { saveErr(e, () => showFallback(E.toCSV(t), 'csv')); }
    });
    $('#dlCsv').addEventListener('click', async () => {
      if (state.v.errors.length) return blockedNotice();
      const csv = E.toCSV(getExport());
      try { await saveFile(fileBase() + '.csv', csv, 'text/csv;charset=utf-8'); toast('Saved ' + fileBase() + '.csv.'); }
      catch (e) { saveErr(e, () => showFallback(csv, 'csv')); }
    });
    $('#copyBtn').addEventListener('click', () => {
      if (state.v.errors.length) return blockedNotice();
      const tsv = E.toTSV(getExport());
      const n = getExport().rows.length;
      copyText(tsv).then(() => toast('Copied ' + plural(n, 'row') + ' with headers. Paste into a spreadsheet.'), () => showFallback(tsv, 'tsv'));
    });
    $('#errList').addEventListener('click', e => { const b = e.target.closest('[data-err]'); if (b) jumpTo(state.v.errors[+b.dataset.err]); });
    $('#previewBox').addEventListener('toggle', () => { if ($('#previewBox').open) renderPreview(); });
    $('#afterDl').addEventListener('click', async () => {
      const text = E.checklistText(E.checklist(state.model, S), state.model);
      try { await saveFile(fileBase().replace(/_Meta_Import$/, '') + '_after_import.txt', text, 'text/plain;charset=utf-8'); toast('Saved the after-import list.'); }
      catch (e) { saveErr(e, () => showFallback(text, 'tsv')); }
    });
    $('#afterCopy').addEventListener('click', () => {
      const text = E.checklistText(E.checklist(state.model, S), state.model);
      copyText(text).then(() => toast('Copied the after-import list.'), () => showFallback(text, 'tsv'));
    });

    // the user's own Ads Manager template decides the columns
    const saved = mem.template();
    if (saved) applyTemplate(saved.headers, saved.name, true);
    $('#tplIn').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const headers = await R.readTemplateHeaders(f, {});
        const mt = E.mapTemplate(headers);
        if (mt.matched < 6) { toast('Only ' + mt.matched + ' of its columns look like Ads Manager columns. Load the template you downloaded from Ads Manager.', true); return; }
        mem.setTemplate(headers, f.name);
        applyTemplate(headers, f.name);
        refresh();
      } catch (err) { toast(err.message || 'Could not read that template.', true); }
    });
    $('#tplClear').addEventListener('click', () => { mem.setTemplate(null); state.template = null; renderTemplate(); refresh(); toast('Back to the built-in columns.'); });
    $('#tplLbl').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#tplIn').click(); } });
  }
  function applyTemplate(headers, name, quiet) {
    state.template = Object.assign(E.mapTemplate(headers), { name: name || 'template' });
    renderTemplate();
    if (!quiet) toast('Using ' + (name || 'your template') + ': ' + state.template.matched + ' columns matched.');
  }
  function renderTemplate() {
    const t = state.template;
    $('#tplState').textContent = t ? 'Your template' : 'Built-in columns';
    $('#tplState').className = 'pill-sm' + (t ? ' ok' : '');
    $('#tplClear').hidden = !t;
    $('#tplHint').textContent = t
      ? (t.name || 'Your template') + ': ' + t.headers.length + ' columns, ' + t.matched + ' filled by this tool. The file keeps its column names and order.'
      : 'Optional. In Ads Manager, open Import and export, download the blank template, and load it here. The export then uses its exact column names and order.';
  }

  /* ---------------- sources ---------------- */
  async function handleFile(file) {
    if (!file) return;
    try {
      const src = await R.readFile(file, {});
      loadSource(src);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast(e.message || 'Could not read that file.', true);
    }
  }
  function loadSample(opts) {
    const s = window.MBSample;
    loadSource({ name: s.name, kind: 'md', blocks: E.textToBlocks(s.text) }, Object.assign({ sample: true }, opts || {}));
  }
  function bindSources() {
    $('#fileIn').addEventListener('change', e => { handleFile(e.target.files[0]); e.target.value = ''; });
    document.addEventListener('keydown', e => {
      const l = e.target.closest && e.target.closest('label[for="fileIn"], label[for="memImportIn"]');
      if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); $('#' + l.getAttribute('for')).click(); }
    });
    $('#pasteToggle').addEventListener('click', () => { const p = $('#pastePanel'); p.hidden = !p.hidden; if (!p.hidden) $('#pasteArea').focus(); });
    $('#pasteCancel').addEventListener('click', () => { $('#pastePanel').hidden = true; });
    $('#pasteParse').addEventListener('click', () => {
      const txt = $('#pasteArea').value;
      if (!txt.trim()) { toast('Paste the doc text first.', true); return; }
      $('#pastePanel').hidden = true; $('#pasteArea').value = '';
      loadSource({ name: 'Pasted text', kind: 'text', blocks: E.textToBlocks(txt) });
    });
    let depth = 0;
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropOverlay').hidden = false; });
    document.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('#dropOverlay').hidden = true; });
    document.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('#dropOverlay').hidden = true; handleFile(e.dataTransfer.files[0]); });
  }

  /* ---------------- AI reading ---------------- */
  const KEY_STORE = 'mbb.aiKey';
  let sampleFn = null; // the Claude plan route, when this page runs as a Claude artifact
  function idleAIState() {
    $('#aiState').textContent = sampleFn ? 'Claude plan' : 'Optional';
    $('#aiState').className = 'pill-sm' + (sampleFn ? ' ok' : '');
  }
  const docText = () => E.blocksToText(state.source.blocks);
  const needDoc = () => { if (!state.source || !state.source.blocks.length) { toast('Load a doc first.', true); return true; } return false; };

  function useAIResult(data, info) {
    const result = E.buildModel(AI.toResult(data), state.source.name);
    state.aiInfo = info;
    state.readMode = 'ai';
    loadModel(result, { announce: true });
    $('#aiBack').hidden = !state.ruleModel;
    $('#aiState').textContent = 'In use'; $('#aiState').className = 'pill-sm ok';
  }
  function busy(on, which) {
    ['#aiRun', '#planRun', '#aiQuick', '#replyUse', '#promptCopy'].forEach(s => { $(s).disabled = on; });
    $('#aiStop').hidden = !(on && which === 'api');
    $('#planStop').hidden = !(on && which === 'plan');
    if (on) { $('#aiState').textContent = 'Reading'; $('#aiState').className = 'pill-sm warn'; }
  }
  async function runWith(which, fn) {
    if (needDoc() || state.aiAbort) return;
    const ctrl = new AbortController();
    state.aiAbort = ctrl;
    busy(true, which);
    const started = Date.now();
    const tick = setInterval(() => { if (!ctrl.signal.aborted && !$('#aiProgress').dataset.writing) $('#aiProgress').textContent = 'Reading the doc... ' + Math.round((Date.now() - started) / 1000) + 's'; }, 1000);
    delete $('#aiProgress').dataset.writing;
    const onProgress = n => { $('#aiProgress').dataset.writing = '1'; $('#aiProgress').textContent = 'Writing the structure... ' + n.toLocaleString() + ' characters'; };
    try {
      await fn(ctrl, onProgress, started);
    } finally {
      clearInterval(tick);
      delete $('#aiProgress').dataset.writing;
      state.aiAbort = null;
      busy(false);
    }
  }
  function failed(f) {
    $('#aiProgress').textContent = f.message;
    if (f.cancelled) idleAIState(); else { $('#aiState').textContent = 'Failed'; $('#aiState').className = 'pill-sm err'; }
    if (!f.cancelled) toast(f.message, true);
  }
  function runPlan() {
    if (!sampleFn) return;
    return runWith('plan', async (ctrl, onProgress, started) => {
      try {
        const out = await AI.readWithPlan(sampleFn, docText(), { tier: $('#planTier').value, signal: ctrl.signal, hints: AI.hintsFromMemory(mem.labels()), onProgress });
        useAIResult(out.data, 'Read by Claude on your Claude plan. No API credit used.');
        $('#aiProgress').textContent = 'Done in ' + Math.round((Date.now() - started) / 1000) + 's.';
      } catch (e) {
        const f = e && e.code ? AI.planError(e) : { message: (e && e.message) || 'AI reading failed.' };
        if (f.hide) { $('#planRoute').hidden = true; sampleFn = null; $('#pasteRouteTitle').textContent = 'With a Claude chat (any plan)'; }
        failed(f);
      }
    });
  }
  function runAPI() {
    const key = $('#aiKey').value.trim();
    if (!key) { $('#aiPanel').open = true; $('#apiRoute').open = true; $('#aiKey').focus(); toast('Add your Anthropic API key first.', true); return; }
    if (!window.Anthropic) { toast('The AI library did not load. Reload the page.', true); return; }
    if ($('#aiRemember').checked) store.set(KEY_STORE, key);
    const model = $('#aiModel').value || AI.DEFAULT_MODEL;
    return runWith('api', async (ctrl, onProgress, started) => {
      try {
        const client = new window.Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 });
        const out = await AI.read(client, docText(), { model, signal: ctrl.signal, hints: AI.hintsFromMemory(mem.labels()), onProgress });
        const cost = AI.costOf(out.usage, out.model);
        useAIResult(out.data, 'Read by AI (' + out.model + '). Used ' + (out.usage.input_tokens || 0).toLocaleString() + ' input and ' + (out.usage.output_tokens || 0).toLocaleString() + ' output tokens, about $' + cost.toFixed(2) + '.');
        $('#aiProgress').textContent = 'Done in ' + Math.round((Date.now() - started) / 1000) + 's. About $' + cost.toFixed(2) + '.';
      } catch (e) { failed(AI.friendlyError(e, window.Anthropic)); }
    });
  }
  function bindAI() {
    $('#aiModel').innerHTML = AI.MODELS.map(m => opt(m.id, m.label, '')).join('');
    const savedModel = store.get('mbb.aiModel');
    if (savedModel && AI.MODELS.some(m => m.id === savedModel)) $('#aiModel').value = savedModel;
    const savedKey = store.get(KEY_STORE);
    if (savedKey) { $('#aiKey').value = savedKey; $('#aiRemember').checked = true; }
    $('#aiModel').addEventListener('change', e => store.set('mbb.aiModel', e.target.value));
    $('#aiRemember').addEventListener('change', e => { if (e.target.checked && $('#aiKey').value.trim()) store.set(KEY_STORE, $('#aiKey').value.trim()); else store.del(KEY_STORE); });
    $('#aiKey').addEventListener('change', e => { if ($('#aiRemember').checked) store.set(KEY_STORE, e.target.value.trim()); });
    $('#aiKeyShow').addEventListener('click', () => { const k = $('#aiKey'); const show = k.type === 'password'; k.type = show ? 'text' : 'password'; $('#aiKeyShow').textContent = show ? 'Hide' : 'Show'; });
    $('#aiRun').addEventListener('click', runAPI);
    $('#planRun').addEventListener('click', runPlan);
    $('#aiStop').addEventListener('click', () => { if (state.aiAbort) state.aiAbort.abort(); });
    $('#planStop').addEventListener('click', () => { if (state.aiAbort) state.aiAbort.abort(); });
    $('#aiQuick').addEventListener('click', () => {
      $('#aiPanel').open = true;
      if (sampleFn) { runPlan(); return; }
      if ($('#aiKey').value.trim()) { runAPI(); return; }
      $('#aiPanel').scrollIntoView({ block: 'start' });
      $('#promptCopy').focus();
      toast('Copy the prompt into a Claude chat, or add an API key.');
    });
    $('#promptCopy').addEventListener('click', () => {
      if (needDoc()) return;
      const text = AI.promptFor(docText(), AI.hintsFromMemory(mem.labels()));
      const box = $('#promptBox');
      copyText(text).then(() => { box.hidden = true; toast('Prompt copied. Paste it into a new Claude chat, then paste the reply below.'); },
        () => { box.hidden = false; box.value = text; box.focus(); box.select(); toast('Copy did not go through. Select the prompt in the box and copy it.', true); });
    });
    $('#replyUse').addEventListener('click', () => {
      if (needDoc()) return;
      try {
        const data = AI.parseReply($('#replyArea').value);
        useAIResult(data, 'Read by Claude from a pasted chat reply. No API credit used.');
        $('#aiProgress').textContent = 'Used the pasted reply.';
        $('#replyArea').value = ''; $('#promptBox').hidden = true;
      } catch (e) { toast(e.message, true); }
    });
    $('#aiBack').addEventListener('click', () => {
      if (!state.ruleModel) return;
      state.readMode = 'rules'; $('#aiBack').hidden = true;
      loadModel(state.ruleModel, {});
      idleAIState();
    });
    // Inside claude.ai the page can ask Claude on the viewer's plan; the API route is not reachable from there
    if (inClaude) {
      $('#apiRoute').hidden = true;
      window.claude.use('sample').then(fn => {
        if (!fn) return;
        sampleFn = fn;
        $('#planRoute').hidden = false;
        $('#pasteRouteTitle').textContent = 'Or with a Claude chat';
        if (state.readMode !== 'ai') idleAIState();
      }).catch(() => { /* no plan route in this view */ });
    }
  }

  /* ---------------- memory panel ---------------- */
  function renderMemory() {
    const labels = mem.labels();
    $('#memCount').textContent = plural(labels.length, 'label');
    $('#memList').innerHTML = labels.length
      ? labels.map(l => '<li><div><div>' + esc(l.example) + '</div><div class="role">' + esc(mem.ROLE_LABEL[l.role] || l.role) + '</div></div><button type="button" class="x" data-forget="' + esc(l.key) + '" aria-label="Forget ' + esc(l.example) + '">&times;</button></li>').join('')
      : '<li class="hint" style="display:block">Nothing taught yet. Use the import report after loading a doc.</li>';
  }
  function bindMemory() {
    $('#memList').addEventListener('click', e => {
      const b = e.target.closest('[data-forget]'); if (!b) return;
      mem.forget(b.dataset.forget); renderMemory(); toast('Forgotten. It applies the next time you load a doc.');
    });
    $('#memExport').addEventListener('click', async () => {
      try { await saveFile('meta-builder-memory.json', mem.exportJSON(), 'application/json'); toast('Memory exported.'); }
      catch (e) { saveErr(e, () => toast('Could not save the memory file here.', true)); }
    });
    $('#memImportIn').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try {
        const counts = mem.importJSON(await f.text());
        renderMemory(); renderProfiles();
        const t = mem.template(); if (t) { applyTemplate(t.headers, t.name, true); refresh(); }
        toast('Imported ' + plural(counts.labels, 'label') + ' and ' + plural(counts.profiles, 'profile') + (counts.template ? ', plus your template' : '') + '.');
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg, isErr, action, actionLabel) {
    const t = $('#toast');
    t.className = isErr ? 'is-err' : '';
    t.innerHTML = '<span></span>' + (action ? '<button type="button"></button>' : '');
    t.firstChild.textContent = msg;
    if (action) { const b = t.querySelector('button'); b.textContent = actionLabel || 'Undo'; b.onclick = () => { t.hidden = true; action(); }; }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 8000 : 4500);
  }

  /* ---------------- boot ---------------- */
  if (window.MBB_SINGLE_FILE || location.protocol === 'file:' || inClaude) $('#offlineLink').parentElement.hidden = true;
  buildSettingsUI(); bindTree(); bindExport(); bindSources(); bindAI(); bindMemory();
  syncSettingsUI(); renderMemory(); renderDoc(); renderTree(); renderReport(); refresh();
  // the claude.ai build opens on the sample, so the first view shows the tool at work
  if (window.MBB_ARTIFACT) loadSample({ announce: false });
})();
