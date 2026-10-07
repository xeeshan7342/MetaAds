/* Meta Bulk Builder engine.
   Source (Word HTML, text, CSV or spreadsheet rows) -> blocks -> parse result -> campaign model -> Ads Manager import rows.
   Plain browser script (window.MBEngine) that also loads in Node for the tests (module.exports). No dependencies. */
(function (root) {
  'use strict';

  /* ---------- text helpers ---------- */

  const norm = s => String(s == null ? '' : s)
    .replace(/[  -   　]/g, ' ')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    // zero-width joiners stay: they hold emoji such as 🧘‍♀️ together
    .replace(/[​﻿]/g, '')
    .replace(/\s+/g, ' ').trim();

  // Like norm, but keeps line breaks: primary text often runs over several lines.
  const normBlock = s => String(s == null ? '' : s).split(/\r?\n/).map(norm).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const key = s => norm(s).toLowerCase()
    .replace(/&/g, ' ').replace(/\band\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  // Normalised form used to recognise labels and to store taught labels: no numbers, counts or punctuation.
  const labelKey = s => norm(s).toLowerCase()
    .replace(/\*\*|__/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\s]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();

  const cellNorm = s => String(s == null ? '' : s).split(/\r?\n/).map(norm).filter(Boolean).join('\n');

  // Meta counts characters, and an emoji counts once
  const textLen = s => Array.from(String(s || '')).length;

  function sim(a, b) {
    const A = new Set(key(a).split(' ').filter(Boolean));
    const B = new Set(key(b).split(' ').filter(Boolean));
    if (!A.size || !B.size) return 0;
    if (key(a) === key(b)) return 1;
    let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  let uid = 0;
  const nid = p => p + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);

  /* ---------- 1. Sources -> blocks ---------- */
  // Block types: {t:'h', level, text} {t:'p', text, bold} {t:'li', text} {t:'table', rows}

  function brText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    return c.textContent;
  }
  const lines = t => String(t).split('\n').map(norm).filter(Boolean);
  // "🎯 Campaign 1: Leads", "📝 Primary Text": the icon AI tools put in front of a heading or label
  const LEAD_ICON = /^(?:[\p{Extended_Pictographic}←-⇿⌀-➿⬀-⯿️‍⃣]|\p{Regional_Indicator})+\s*/u;
  const stripIcon = t => { const s = norm(t).replace(LEAD_ICON, ''); return s || norm(t); };
  const HR = /^(?:[-*_=~]\s*){3,}$/;

  function cellText(c) {
    const parts = c.querySelectorAll('p, li');
    const texts = parts.length > 1 ? Array.from(parts).map(brText) : [brText(c)];
    return texts.map(t => lines(t).join('\n')).filter(Boolean).join('\n');
  }

  function htmlToBlocks(html, ParserCtor) {
    const P = ParserCtor || root.DOMParser;
    const doc = new P().parseFromString('<div id="__r">' + html + '</div>', 'text/html');
    const r = doc.getElementById('__r');
    const out = [];
    const walk = el => {
      for (const n of Array.from(el.children)) {
        const tag = n.tagName.toLowerCase();
        if (tag === 'hr') continue;
        if (/^h[1-6]$/.test(tag)) {
          const t = stripIcon(n.textContent);
          if (t) out.push({ t: 'h', level: +tag[1], text: t });
        } else if (tag === 'p') {
          const t = norm(n.textContent);
          if (!t) continue;
          const strong = norm(Array.from(n.querySelectorAll('strong, b')).map(x => x.textContent).join(''));
          const bold = strong.length > 0 && strong.length >= t.length - 1;
          lines(brText(n)).forEach(line => { if (!HR.test(line)) out.push({ t: 'p', text: bold ? stripIcon(line) : line, bold }); });
        } else if (tag === 'ul' || tag === 'ol') {
          for (const li of Array.from(n.children)) {
            if (li.tagName.toLowerCase() !== 'li') continue;
            const c = li.cloneNode(true);
            c.querySelectorAll('ul, ol').forEach(x => x.remove());
            lines(brText(c)).forEach(t => out.push({ t: 'li', text: t }));
            Array.from(li.children).filter(x => /^(ul|ol)$/i.test(x.tagName)).forEach(x => walk({ children: [x] }));
          }
        } else if (tag === 'table') {
          // expand merged cells so later columns never shift
          const grid = [];
          Array.from(n.querySelectorAll('tr')).forEach((tr, ri) => {
            const row = grid[ri] = grid[ri] || [];
            let ci = 0;
            Array.from(tr.children).filter(c => /^t[dh]$/i.test(c.tagName)).forEach(c => {
              while (row[ci] !== undefined) ci++;
              const text = cellText(c);
              const rs = Math.max(1, Math.min(50, +c.getAttribute('rowspan') || 1));
              const cs = Math.max(1, Math.min(50, +c.getAttribute('colspan') || 1));
              for (let rr = 0; rr < rs; rr++) {
                const target = grid[ri + rr] = grid[ri + rr] || [];
                for (let k = 0; k < cs; k++) target[ci + k] = (k === 0) ? text : '';
              }
              ci += cs;
            });
          });
          const rows = grid.map(row => Array.from(row, x => x === undefined ? '' : x)).filter(row => row.some(Boolean));
          if (rows.length) out.push({ t: 'table', rows });
        } else {
          walk(n);
        }
      }
    };
    walk(r);
    return out;
  }

  const PIPE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const splitPipeRow = line => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(c => cellNorm(c.replace(/\*\*|__/g, '').replace(/<br\s*\/?>/gi, '\n')));
  };
  const BULLET = /^(?:[-*•◦▪●○·▸►→–—]|\d{1,2}[.)])\s+(.*)$/u;

  function textToBlocks(txt) {
    const out = [];
    const src = String(txt).replace(/^﻿/, '').split(/\r?\n/);
    let table = null, gap = false;
    const push = b => { if (gap) { b.gapBefore = true; gap = false; } out.push(b); };
    for (let i = 0; i < src.length; i++) {
      const raw = src[i];
      // Markdown pipe tables (what ChatGPT and Claude produce)
      if (/\|/.test(raw) && (/^\s*\|/.test(raw) || PIPE_SEP.test(src[i + 1] || '')) && (raw.match(/\|/g) || []).length >= 2) {
        const rows = [];
        while (i < src.length && /\|/.test(src[i]) && src[i].trim()) {
          if (!PIPE_SEP.test(src[i])) rows.push(splitPipeRow(src[i]));
          i++;
        }
        i--;
        if (rows.length) push({ t: 'table', rows });
        table = null;
        continue;
      }
      if (raw.includes('\t')) {
        const cells = raw.split('\t').map(norm);
        if (cells.some(Boolean)) {
          if (!table) { table = { t: 'table', rows: [] }; push(table); }
          table.rows.push(cells);
        }
        continue;
      }
      table = null;
      let line = norm(raw);
      if (!line) { gap = true; continue; }
      if (HR.test(line)) { gap = true; continue; }
      if (/^#{1,6}\s/.test(line)) {
        const lv = line.match(/^#+/)[0].length;
        push({ t: 'h', level: lv, text: stripIcon(line.replace(/^#+/, '').replace(/\*\*|__/g, '')) });
        continue;
      }
      const bold = /^(?:\*\*|__).+(?:\*\*|__):?$/.test(line) || /^(?:\*\*|__)[^*_]+(?:\*\*|__)\s*$/.test(line);
      line = norm(line.replace(/\*\*|__/g, ''));
      const bullet = line.match(BULLET);
      if (bullet) { if (norm(bullet[1]) && !HR.test(norm(bullet[1]))) push({ t: 'li', text: norm(bullet[1]) }); continue; }
      push({ t: 'p', text: bold ? stripIcon(line) : line, bold });
    }
    return out;
  }

  function csvToRows(text) {
    const s = String(text).replace(/^﻿/, '');
    const first = s.split(/\r?\n/, 1)[0] || '';
    const count = ch => (first.split(ch).length - 1);
    const delim = count('\t') > count(',') && count('\t') >= count(';') ? '\t' : (count(';') > count(',') ? ';' : ',');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"' && cell === '') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(r => r.map(cellNorm)).filter(r => r.some(Boolean));
  }

  // One spreadsheet tab (or a CSV file) -> blocks. The tab name acts as a heading.
  function rowsToBlocks(rows, sheetName) {
    const out = [];
    const nm = norm(sheetName);
    if (nm && !/^(?:sheet|tab|page)\s*\d*$/i.test(nm)) out.push({ t: 'h', level: 1, text: nm, sheet: true });
    const clean = (rows || []).map(r => r.map(cellNorm)).filter(r => r.some(Boolean));
    if (clean.length) out.push({ t: 'table', rows: clean });
    return out;
  }

  /* ---------- 2. Vocabulary ---------- */

  // Words in front of a label that do not change what it is: "Suggested Headlines", "Meta Primary Text"
  const LABEL_PREFIX = /^(?:(?:sample|suggested|proposed|recommended|example|draft|final|optional|meta|facebook|fb|ig|instagram|new|our|ad|ads)\s+)+/;
  const labelCore = s => labelKey(s).replace(/\b(?:options?|variations?|versions?|variants?|ideas?|examples?|alternatives?|copy options?)\b/g, ' ').replace(/\s+/g, ' ').trim();

  // Field labels: what a "Label: value" line, a bold label, a heading or a table header sets.
  const FIELDS = [
    ['campaignName', /^(?:campaign\s+name|name\s+of\s+campaign)$/],
    ['adSetName', /^(?:ad\s*set|adset|audience)\s+name$/],
    ['adName', /^(?:ad|creative)\s+name$/],
    ['objective', /^(?:campaign\s+|buying\s+|marketing\s+|advertising\s+)?(?:objectives?|goals?)$/],
    ['budgetType', /^(?:budget\s+(?:type|level|optimi[sz]ation|setup|structure|strategy)|cbo|abo|cbo\s+or\s+abo|campaign\s+budget\s+optimi[sz]ation|advantage\s+campaign\s+budget)$/],
    ['budget', /^(?:(?:avg|average|est|estimated|recommended|suggested|starting|initial|test|testing|campaign|ad\s*set|total|overall|proposed|daily|monthly|weekly|lifetime|ad|media|meta|facebook)\s+)*(?:budgets?|spend|ad\s+spend)(?:\s+(?:per\s+(?:day|month|week)|daily|monthly|weekly|lifetime|cap|amount|limit|split|allocation))*$/],
    ['specialCategory', /^special\s+(?:ad\s+)?categor(?:y|ies)$/],
    ['bidStrategy', /^(?:campaign\s+|ad\s*set\s+)?(?:bid(?:ding)?(?:\s+strategy)?|bid\s+type|bidding\s+approach)$/],
    ['bidAmount', /^(?:cost\s+cap|cost\s+per\s+result\s+goal|bid\s+cap|target\s+(?:cpa|cpl|cost(?:\s+per\s+(?:lead|result|acquisition))?)|(?:cpa|cpl)\s+(?:goal|target|cap)|bid\s+(?:amount|limit)|roas\s+(?:goal|target)|minimum\s+roas)$/],
    ['startDate', /^(?:campaign\s+|ad\s*set\s+)?(?:start(?:\s+date)?|launch(?:\s+date)?|go\s*live(?:\s+date)?)$/],
    ['endDate', /^(?:campaign\s+|ad\s*set\s+)?(?:end(?:\s+date)?|stop(?:\s+date)?|finish(?:\s+date)?)$/],
    ['schedule', /^(?:schedule|flight(?:\s+dates)?|run\s+dates|campaign\s+dates|dates|duration)$/],
    ['conversionLocation', /^(?:conversion\s+location|lead\s+(?:method|type|capture(?:\s+method)?)|destination(?:\s+type)?)$/],
    ['engagementType', /^engagement\s+type$/],
    ['messageApps', /^(?:message|messaging)\s+(?:destinations?|apps?|channels?|platforms?)$/],
    ['phone', /^(?:(?:business|call|calling|whatsapp|contact)\s+)?(?:phone(?:\s+number)?|number\s+to\s+call|call\s+number)$/],
    ['appId', /^(?:app|application)\s+id$/],
    ['appStore', /^(?:app\s+store|play\s+store|google\s+play|app)(?:\s+(?:url|link))?$/],
    ['event', /^(?:conversion(?:\s+event)?|optimi[sz]ation\s+event|pixel\s+event|conversion\s+goal|tracking\s+event|key\s+event|event)$/],
    ['optimization', /^(?:optimi[sz]ation(?:\s+goal)?|performance\s+goal|optimi[sz]e\s+for|delivery\s+optimi[sz]ation|optimi[sz]ed\s+for)$/],
    ['pixel', /^(?:meta\s+|facebook\s+)?(?:pixel|dataset)(?:\s+id)?$/],
    ['page', /^(?:facebook\s+|fb\s+|meta\s+)?page(?:\s+id)?$/],
    ['leadForm', /^(?:instant\s+form|lead\s+form|form)(?:\s+id)?$/],
    ['age', /^(?:age(?:\s+(?:range|group|bracket|targeting))?|ages)$/],
    ['gender', /^(?:genders?|sex)$/],
    ['locations', /^(?:(?:target(?:ed)?|targeting|campaign|geo)\s+)?(?:locations?|geo(?:graph(?:y|ies))?|geos?|geo[\s-]?target(?:ing|s)?|countries|country|markets?|regions?|cities|city|areas?|service\s+areas?|radius|location\s+targeting|geographic\s+targeting)$/],
    ['interests', /^(?:(?:core|layered|detailed|interest|targeted)\s+)?(?:interests?|detailed\s+targeting|behaviou?rs?|demographics|interests?\s+and\s+behaviou?rs?|interest\s+targeting|targeting\s+interests?|interest\s+stack)$/],
    ['audiences', /^(?:custom\s+audiences?|retargeting(?:\s+audiences?)?|remarketing(?:\s+audiences?)?|warm\s+audiences?|audience\s+source|source\s+audiences?|seed\s+audiences?|lookalikes?(?:\s+audiences?)?|lals?|llas?)$/],
    ['exclusions', /^(?:exclu(?:sions?|de|ded)(?:\s+audiences?)?|audience\s+exclusions?|excluded\s+audiences?)$/],
    ['audience', /^(?:(?:target\s+)?audience(?:\s+(?:focus|description|details|definition|profile|summary|type|targeting))?|targeting(?:\s+(?:details|summary))?|persona)$/],
    ['placements', /^(?:placements?|placement\s+(?:strategy|type|settings)|platforms?|advantage\s+placements?)$/],
    ['languages', /^(?:languages?|locales?)$/],
    ['devices', /^devices?$/],
    ['primary', /^(?:primary\s+texts?|primary\s+copy|body(?:\s+(?:copy|text))?|copy|texts?|main\s+text|captions?|post\s+(?:copy|text)|ad\s+copy)$/],
    ['headline', /^(?:headlines?|titles?)$/],
    ['description', /^(?:(?:news\s*feed\s+)?link\s+descriptions?|descriptions?)$/],
    ['cta', /^(?:cta(?:\s+button)?|call\s*to\s*action(?:\s+button)?|button(?:\s+text)?)$/],
    ['url', /^(?:(?:website|destination|landing\s+page|final|link|lp)\s+(?:url|link)|urls?|website|landing\s+pages?|link|lp)$/],
    ['displayLink', /^display\s+(?:link|url)$/],
    ['urlTags', /^(?:url\s+(?:parameters|tags|params)|utms?|utm\s+(?:parameters|tags|codes?|params)|tracking(?:\s+(?:parameters|template))?)$/],
    ['format', /^(?:(?:creative\s+)?format|creative\s+type|media\s+type|post\s+(?:type|format)|ad\s+(?:type|format))$/],
    ['media', /^(?:image|video|visual|media|asset|creative(?:\s+(?:asset|file|concept|idea|direction|notes?|description))?|image\s+(?:hash|file)|video\s+(?:id|file)|visuals?|imagery|design|thumbnail)$/],
    ['postId', /^(?:(?:page|facebook|fb|instagram|ig|existing)\s+)?(?:post|story)\s+(?:id|link|url)$/],
    // settings the import file has no column for: they go on the after-import list
    ['setting', /^(?:buying\s+type|a\s*b\s+test(?:ing)?|split\s+test(?:ing)?|advantage\s+(?:audience|creative(?:\s+enhancements?)?|shopping(?:\s+campaign)?)|(?:standard\s+)?creative\s+enhancements?|multi\s+advertiser(?:\s+ads?)?|translate\s+text|(?:text\s+)?translations?|brand\s+safety|inventory\s+filter|block\s+lists?|identity|ad\s+(?:setup|creation|source)|instagram\s+(?:account|profile)|attribution(?:\s+(?:setting|window|model))?|frequency(?:\s+cap(?:ping)?)?|dynamic\s+creative|site\s+links|value\s+rules|audience\s+suggestions?|campaign\s+spending\s+limit|spending\s+limit|budget\s+scheduling|placement\s+controls|(?:website|app|offline)\s+events|beneficiary|payer|delivery\s+type)$/],
    ['keywords', /^(?:negative\s+)?key\s?words?$/]
  ];
  // labels that describe the plan, not a setting: "Structure: 1 campaign, 1 ad set, 3 ads"
  const IGNORE_LABEL = /^(?:structure|campaign\s+structure|account\s+structure|naming(?:\s+conventions?)?|why|reason|rationale|purpose|notes?|comments?|tips?)$/;
  // "Use existing post", "Existing Facebook Page posts", "Ad01_ExistingPost_Image"
  const EXISTING_POST = /existing[\s_-]*(?:(?:page|facebook|fb|instagram|ig|organic)[\s_-]+)*posts?|use\s+(?:an?\s+)?existing\b|boost(?:ed|ing)?\s+(?:the\s+|a\s+|an\s+)?(?:page\s+|organic\s+)?posts?/i;
  // The post an existing-post ad runs: "122115687656432835", "s:1221…", "1106712235857730_1221…" or a /posts/123… link.
  // Ads Manager exports it as Story ID "s:" + the post's own ID, so that is the form kept.
  function postIdOf(v) {
    const t = norm(v).replace(/^s:/i, '');
    const m = t.match(/\/posts\/(\d{5,25})\b/) || t.match(/story_fbid=(\d{5,25})/) || t.match(/^(?:\d{5,25}_)?(\d{5,25})$/);
    return m ? m[1] : '';
  }
  // a value that is only a placeholder: "[Client Page name]", "[date]"
  const PLACEHOLDER = /\[[^\]]{1,60}\]/;
  const onlyPlaceholder = v => /^\s*\[[^\]]{1,60}\]\s*$/.test(String(v).replace(/\([^)]*\)/g, ''));
  const LIST_FIELDS = new Set(['primary', 'headline', 'description', 'interests', 'audiences', 'exclusions', 'locations', 'audience', 'placements']);
  const COPY_FIELDS = new Set(['primary', 'headline', 'description']);
  const TARGETING_FIELDS = new Set(['age', 'gender', 'locations', 'interests', 'audiences', 'exclusions', 'audience', 'placements']);

  function fieldOf(label) {
    const k = labelKey(label);
    if (!k || k.length > 60) return null;
    const core = labelCore(k).replace(LABEL_PREFIX, '');
    for (const [f, rx] of FIELDS) if (rx.test(k) || rx.test(core)) return f;
    return null;
  }

  // Prose sections that never hold ad content: skipped as one unit
  const SKIP_SECTION = /^(?:notes?(?:\s+for\s+(?:the\s+)?(?:team|client))?|internal\s+notes?|strategy|strategic\s+(?:overview|rationale)|overview|rationale|why\s+this\s+works|kpis?(?:\s+and\s+(?:benchmarks?|targets?|goals?))?|benchmarks?|goals?\s+and\s+kpis?|success\s+metrics|reporting(?:\s+(?:plan|cadence))?|timeline|next\s+steps?|testing\s+(?:plan|strategy|framework|roadmap|schedule)|a\s*b\s+testing(?:\s+plan)?|optimi[sz]ation\s+(?:plan|strategy|schedule|roadmap|notes|checklist)|scaling(?:\s+(?:plan|strategy))?|measurement(?:\s+plan)?|tracking\s+(?:setup|plan)|assumptions?|creative\s+(?:guidelines|notes|brief|strategy|best\s+practices|requirements|specs?)|best\s+practices|recommendations?|budget\s+(?:rationale|notes|split\s+rationale|justification)|funnel(?:\s+(?:strategy|overview))?|competitor\s+\w+|appendix|introduction|executive\s+summary|table\s+of\s+contents|contents|(?:pre\s+|post\s+)?launch\s+checklist|checklist|faqs?|questions?|(?:key\s+)?metrics(?:\s+to\s+(?:track|watch|monitor))?|what\s+to\s+(?:track|watch|monitor)|monitoring(?:\s+plan)?|troubleshooting|common\s+mistakes|(?:optimi[sz]ation|testing)\s+(?:rules|guide|tips)|after\s+launch)$/;

  // Platforms. A section for another platform is skipped as one unit when the doc also has a Meta section.
  const META_WORDS = /\b(?:meta|facebook|fb|instagram|insta|ig|messenger|whatsapp)\b/i;
  const OTHER_PLATFORMS = [
    ['Google', /\b(?:google|adwords|youtube|performance\s+max|p\s?max|search\s+(?:ads?|campaigns?|network)|display\s+network|gdn|rsa|responsive\s+search|ppc|sem)\b/i],
    ['Microsoft Ads', /\b(?:microsoft\s+(?:ads|advertising)|bing)\b/i],
    ['LinkedIn', /\blinked\s?in\b/i], ['TikTok', /\btik\s?tok\b/i], ['Snapchat', /\bsnap(?:chat)?\b/i],
    ['Pinterest', /\bpinterest\b/i], ['X (Twitter)', /\b(?:twitter|x\s+ads)\b/i], ['Reddit', /\breddit\b/i],
    ['Email', /\bemail\s+(?:marketing|campaigns?|sequences?|flows?)\b/i], ['SEO', /\bseo\b/i]
  ];
  // 'meta', the name of another platform, 'mixed' (names Meta and another one), or null
  function platformOf(text) {
    const t = norm(text);
    const meta = META_WORDS.test(t);
    const other = OTHER_PLATFORMS.find(([, rx]) => rx.test(t));
    if (meta && other) return 'mixed';
    if (meta) return 'meta';
    if (other) return other[0];
    return null;
  }

  // "2.2 ", "1. ", "IV. ", "a) " in front of a heading
  const OUTLINE = /^(?:(?:\d{1,2}(?:\.\d{1,2})*\.?|[ivx]{1,5}\.|[a-z][.)])\s+)/i;
  const stripOutline = t => norm(t).replace(OUTLINE, '');
  const ID = '#?\\s*(?:\\d{1,3}|[a-z])(?![\\p{L}\\d])';
  const SEP = '\\s*(?:[:.)|\\-–—]|\\s-\\s)\\s*';
  const PLAT = '(?:(?:meta|facebook|fb|instagram|ig)\\s+(?:ads?\\s+)?)?';
  const CAMP_RX = new RegExp('^' + PLAT + 'campaign\\s*(?:' + ID + ')?' + SEP + '(.+)$', 'iu');
  const CAMP_ONLY = new RegExp('^' + PLAT + 'campaign\\s*(' + ID + ')$', 'iu');
  const ADSET_RX = new RegExp('^(?:ad\\s*set|adset)\\s*(?:' + ID + ')?' + SEP + '(.+)$', 'iu');
  const ADSET_AUD_RX = new RegExp('^(?:audience|ad\\s*group|segment)\\s*' + ID + SEP + '(.+)$', 'iu');
  const ADSET_ONLY = new RegExp('^(?:ad\\s*set|adset|audience|segment)\\s*(' + ID + ')$', 'iu');
  const AD_RX = new RegExp('^(?:ad|ads|creative|concept|ad\\s+(?:variation|creative|concept))\\s*' + ID + SEP + '(.*)$', 'iu');
  const AD_ONLY = new RegExp('^(?:ad|creative|concept|ad\\s+(?:variation|creative|concept))\\s*(' + ID + ')$', 'iu');
  // "Primary Text 2: ...", "Headline 3 - ...", "H1: ...", "PT2: ..."
  const NUMBERED = /^(primary\s+text|body|text|headline|title|description|desc|link\s+description|pt|h|d)\s*#?\s*(\d{1,2})\s*(?:\([^)]*\))?\s*(?:[:.)\-–—|=]\s*|\t)(.+)$/i;
  // "Option 2: ...", "Variation B - ...", "V1: ..." inside a list
  const OPTION = /^(?:option|variation|version|variant|copy|v|alt(?:ernative)?)\s*#?\s*(?:\d{1,2}|[a-e])(?![\p{L}\d])\s*(?:\([^)]*\))?\s*(?:[:.)\-–—|]\s*)(.*)$/iu;

  // Settings-like heading names that are containers, never an ad set: "Shared Targeting Parameters", "Account setup"
  const CONTAINER_NAME = /\b(?:shared|global|account|general|default|common|overall|setup|settings?|parameters|structure|summary|overview|plan|framework|details|breakdown|allocation|split|campaigns|ad\s*sets|audiences\s+overview|targeting\s+overview|glance|snapshot|quick\s+view|at\s+a\s+look)\b/i;

  const isCopyNoteLine = t => /^\(.*\)$|^\[.*\]$/.test(t);
  const isNameLike = t => {
    const s = norm(t);
    return s.length >= 2 && s.length <= 70 && s.split(' ').length <= 9 && !/[.!?;,]$/.test(s) && !/https?:|www\./i.test(s) && !/:\s*\S/.test(s);
  };
  const isCaps = x => { const l = String(x).replace(/[^A-Za-z]/g, ''); return l.length >= 4 && l === l.toUpperCase(); };
  const cleanName = s => norm(s).replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[:\s]+$/, '').replace(/\*\*|__/g, '').trim();

  // Strip numbering, character counts and quotes from one line of ad text
  const STRIP_NUM = /^(?:\d{1,2}[.)]\s+|#\d{1,2}\s*[:.)-]?\s*)/;
  const TRAIL_COUNT = /\s*[([]\s*(?:\d{1,4}\s*(?:\/\s*\d{1,4}\s*)?(?:chars?|characters?|ch|c)?|chars?:?\s*\d{1,4})\s*[)\]]\s*$/i;
  const cleanCopy = s => {
    let t = normBlock(s).replace(STRIP_NUM, '').replace(TRAIL_COUNT, '');
    if (/^["“][^"“”]+["”]$/.test(t)) t = t.slice(1, -1);
    return t.trim();
  };

  /* ---------- 3. Value parsers ---------- */

  // Amounts in any currency. "$1,500", "1.500 €", "CHF 1'200", "₹2,00,000", "1.5k", "₹1.5L", "₹1.2 Cr", "1.2M"
  const asciiDigits = s => String(s || '').replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6F0));
  const THREE_DECIMALS = /\b(?:kwd|bhd|omr|jod|tnd|lyd|iqd)\b/i;
  const MULTIPLIERS = [[/^(?:k|thousand)$/i, 1e3], [/^(?:lakhs?|lacs?|l)$/i, 1e5], [/^(?:crores?|cr)$/i, 1e7], [/^(?:m|mn|mio|million|millions)$/i, 1e6]];
  function findAmount(text) {
    const t = asciiDigits(text);
    const m = t.match(/\d(?:\d|[.,'’](?=\d)|[   ](?=\d{3}(?!\d)))*/);
    if (!m) return null;
    let raw = m[0].replace(/[   '’]/g, '');
    const dots = (raw.match(/\./g) || []).length, commas = (raw.match(/,/g) || []).length;
    if (dots && commas) {
      const dec = raw.lastIndexOf('.') > raw.lastIndexOf(',') ? '.' : ',';
      raw = raw.split(dec === '.' ? ',' : '.').join('').replace(',', '.');
    } else if (commas) {
      raw = /^\d{1,3}(?:,\d{3})+$|^\d{1,2}(?:,\d{2})*,\d{3}$/.test(raw) || commas > 1 ? raw.replace(/,/g, '') : raw.replace(',', '.');
    } else if (dots > 1 || (dots === 1 && /^\d{1,3}\.\d{3}$/.test(raw) && !THREE_DECIMALS.test(t))) {
      raw = raw.replace(/\./g, '');
    }
    let n = parseFloat(raw);
    if (!isFinite(n)) return null;
    let end = m.index + m[0].length;
    const mult = t.slice(end).match(/^\s*([a-z]+)(?![a-z\d])/i);
    if (mult) {
      const hit = MULTIPLIERS.find(([rx]) => rx.test(mult[1]));
      if (hit && !(hit[1] === 1e6 && /^m$/i.test(mult[1]) && /\/\s*$/.test(t.slice(0, m.index)))) { n *= hit[1]; end += mult[0].length; }
    }
    return { n: Math.round(n * 100) / 100, index: m.index, end, text: t };
  }

  const round2 = n => Math.round(n * 100) / 100;
  // "$1,500/month", "50 per day", "$2,000 lifetime" -> { amount, basis, daily, period }
  function parseBudget(label, value) {
    const t = asciiDigits(value)
      .replace(/(^|[\s\d])(?:pcm|p\.\s?m\.?|p\/m|per calendar month)(?=[\s).;]|$)/gi, '$1 per month')
      .replace(/(^|[\s\d])(?:p\/d|p\.\s?d\.)(?=[\s).;]|$)/gi, '$1 per day')
      .replace(/\/\s*m(?![\p{L}])/giu, ' per month');
    const a = findAmount(t);
    if (!a) return null;
    const amount = a.n;
    const unitOf = w => /^d/i.test(w) ? 'daily' : /^(?:mo|mth|month)/i.test(w) ? 'monthly' : /^w/i.test(w) ? 'weekly' : 'yearly';
    const UNIT = /(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+)?(?<![\p{L}\d])(day|daily|d|month|monthly|mo|mth|week|weekly|wk|year|yr|annual|annually)(?![\p{L}\d])/iu;
    let basis = null;
    const after = t.slice(a.end).match(new RegExp('^\\s*' + UNIT.source, 'iu'));
    if (after) basis = unitOf(after[1]);
    const before = t.slice(0, a.index);
    const l = String(label || '').toLowerCase();
    if (!basis && /\b(?:daily|per day|a day)\b/i.test(before)) basis = 'daily';
    if (!basis && /\b(?:monthly|per month|a month)\b/i.test(before)) basis = 'monthly';
    if (!basis && /\bweekly\b/i.test(before)) basis = 'weekly';
    if (!basis) {
      if (/month/.test(l)) basis = 'monthly'; else if (/week/.test(l)) basis = 'weekly'; else if (/\bday\b|daily/.test(l)) basis = 'daily';
      else if (/lifetime|total|flight/.test(l)) basis = 'lifetime';
    }
    if (!basis && /\b(?:lifetime|total\s+(?:budget|spend)|for\s+the\s+(?:whole|entire)|flight|one[\s-]off)\b/i.test(t)) basis = 'lifetime';
    if (!basis) {
      const bare = t.replace(/\([^)]*\)/g, ' ');
      const units = bare.match(new RegExp(UNIT.source, 'giu')) || [];
      if (units.length === 1) basis = unitOf(units[0].replace(/^(?:\/\s*|per\s+|a\s+|an\s+|each\s+|every\s+)/i, ''));
    }
    if (basis === 'lifetime') return { amount, basis, period: 'lifetime', daily: null };
    const div = { daily: 1, monthly: 30.4, weekly: 7, yearly: 365 }[basis || 'daily'];
    return { amount, basis: basis || 'unlabeled', period: 'daily', daily: round2(amount / div) };
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = n => String(n).padStart(2, '0');
  function parseDate(v, yearHint) {
    const t = norm(v).toLowerCase();
    let m;
    if ((m = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    if ((m = t.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/))) {
      const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (a > 12 && b <= 12) return y + '-' + pad(b) + '-' + pad(a);
      // month first, as Ads Manager writes it, unless the day comes first
      if (a <= 12) return y + '-' + pad(a) + '-' + pad(b);
      return null;
    }
    const mi = MONTHS.findIndex(mo => new RegExp('\\b' + mo).test(t));
    const day = t.replace(/\b20\d{2}\b/, ' ').match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    const yr = t.match(/\b(20\d{2})\b/);
    const y = yr ? yr[1] : yearHint;
    if (mi >= 0 && day && y) return y + '-' + pad(mi + 1) + '-' + pad(+day[1]);
    return null;
  }
  // "Oct 10 – Nov 10, 2026", "2026-10-10 to 2026-11-10"
  function parseSchedule(v) {
    const t = norm(v);
    const yr = (t.match(/\b(20\d{2})\b/) || [])[1];
    const parts = t.split(/\s+(?:to|until|till|through|thru)\s+|\s*[–—]\s*|\s+-\s+/i);
    if (parts.length < 2) return { start: parseDate(t, yr) };
    return { start: parseDate(parts[0], yr), end: parseDate(parts.slice(1).join(' '), yr) };
  }

  const OBJECTIVES = [
    ['AWARENESS', 'Awareness', 'Outcome Awareness'],
    ['TRAFFIC', 'Traffic', 'Outcome Traffic'],
    ['ENGAGEMENT', 'Engagement', 'Outcome Engagement'],
    ['LEADS', 'Leads', 'Outcome Leads'],
    ['APP_PROMOTION', 'App promotion', 'Outcome App Promotion'],
    ['SALES', 'Sales', 'Outcome Sales']
  ];
  function parseObjective(v) {
    const t = norm(v).toLowerCase();
    if (!t) return null;
    if (/\blead|instant\s+forms?|lead\s+forms?|sign[\s-]?ups?\b|enquir|inquir|appointments?|consultations?|bookings?\b/.test(t)) return 'LEADS';
    if (/\bapp\s+(?:installs?|promotion|engagement)|\binstalls?\b/.test(t)) return 'APP_PROMOTION';
    if (/\bsales?\b|\bconversions?\b|purchases?|catalog|e-?commerce|\broas\b|revenue|checkout|add\s+to\s+cart/.test(t)) return 'SALES';
    if (/\btraffic\b|link\s+clicks?|landing\s+page\s+views?|website\s+visits?|\bclicks?\b/.test(t)) return 'TRAFFIC';
    if (/engagement|\bmessages?\b|messaging|conversations?|video\s+views?|thruplay|page\s+likes?|followers?|event\s+responses?|\bdms?\b|retarget/.test(t)) return 'ENGAGEMENT';
    if (/awareness|\breach\b|\bbrand\b|impressions|ad\s+recall/.test(t)) return 'AWARENESS';
    return null;
  }
  const objectiveLabel = k => (OBJECTIVES.find(o => o[0] === k) || [, ''])[1];

  // Conversion locations as Ads Manager names them, and which objectives offer each
  const LOCATIONS = [
    ['website', 'Website'], ['app', 'App'], ['messages', 'Message destinations'], ['form', 'Instant forms'], ['calls', 'Calls'],
    ['on_ad', 'On your ad'], ['profile', 'Instagram or Facebook'], ['ig_live', 'Instagram live video']
  ];
  const LOCATIONS_BY_OBJECTIVE = {
    AWARENESS: [],
    TRAFFIC: ['website', 'app', 'messages', 'profile', 'calls'],
    ENGAGEMENT: ['on_ad', 'messages', 'ig_live', 'calls', 'website', 'app', 'profile'],
    LEADS: ['website', 'form', 'messages', 'calls', 'app'],
    APP_PROMOTION: ['app'],
    SALES: ['website', 'app', 'messages', 'calls']
  };
  const DEFAULT_LOCATION = { TRAFFIC: 'website', ENGAGEMENT: 'on_ad', LEADS: 'website', APP_PROMOTION: 'app', SALES: 'website' };
  const locationLabel = k => (LOCATIONS.find(l => l[0] === k) || [, ''])[1];
  // "On your ad" engagement types
  const ENGAGEMENT_TYPES = [['interactions', 'Post engagement'], ['video_views', 'Video views'], ['event_responses', 'Event responses'], ['reminders', 'Reminders set']];
  const MESSAGE_APPS = [['messenger', 'Messenger'], ['instagram', 'Instagram'], ['whatsapp', 'WhatsApp']];

  function parseConversionLocation(v) {
    const t = norm(v).toLowerCase();
    if (/instant\s+forms?|lead\s+forms?|native\s+forms?|on[\s-]facebook\s+forms?|in[\s-]app\s+forms?|\bforms?\b/.test(t)) return 'form';
    if (/instagram\s+live|\blive\s+(?:video|stream)/.test(t)) return 'ig_live';
    if (/messenger|whats\s?app|\bmessages?\b|messaging|\bdms?\b|direct\s+messages?|instagram\s+direct|conversations?/.test(t)) return 'messages';
    if (/\bcalls?\b|phone/.test(t)) return 'calls';
    if (/on\s+(?:your|the)\s+ad|video\s+views?|thru\s?play|2[\s-]second|post\s+engagement|interactions?|likes?,?\s+comments|event\s+responses?|reminders?/.test(t)) return 'on_ad';
    if (/profile\s+visits?|page\s+visits?|page\s+likes?|followers?|instagram\s+or\s+facebook|instagram\s+profile|facebook\s+page\b/.test(t)) return 'profile';
    if (/\bapp\b|app\s+store|play\s+store|\binstalls?\b/.test(t)) return 'app';
    if (/website|\bsite\b|landing\s+page|\bweb\b|pixel/.test(t)) return 'website';
    return null;
  }
  function parseEngagementType(v) {
    const t = norm(v).toLowerCase();
    if (/video\s+views?|thru\s?play|2[\s-]second|video\s+plays?/.test(t)) return 'video_views';
    if (/event\s+(?:responses?|rsvps?)/.test(t)) return 'event_responses';
    if (/reminders?/.test(t)) return 'reminders';
    if (/interactions?|post\s+engagement|\blikes?\b|comments?|shares?/.test(t)) return 'interactions';
    return null;
  }
  function parseMessageApps(v) {
    const t = norm(v).toLowerCase();
    const out = [];
    if (/messenger|facebook\s+messag/.test(t)) out.push('messenger');
    if (/instagram|\big\b|insta\b/.test(t)) out.push('instagram');
    if (/whats\s?app/.test(t)) out.push('whatsapp');
    return out;
  }

  const EVENTS = [
    ['LEAD', 'Lead', /\blead|form\s+submi|enquir|inquir/],
    ['PURCHASE', 'Purchase', /purchase|\bsales?\b|\border|checkout\s+complete|transaction/],
    ['COMPLETE_REGISTRATION', 'Complete registration', /registration|register|sign[\s-]?up/],
    ['SCHEDULE', 'Schedule', /schedul|booking|\bbook|appointment|consult/],
    ['CONTACT', 'Contact', /contact|\bcalls?\b/],
    ['SUBMIT_APPLICATION', 'Submit application', /application|apply/],
    ['ADD_TO_CART', 'Add to cart', /add\s+to\s+cart|\batc\b/],
    ['INITIATED_CHECKOUT', 'Initiate checkout', /initiat\w*\s+checkout|begin\s+checkout|\bic\b/],
    ['SUBSCRIBE', 'Subscribe', /subscri/],
    ['START_TRIAL', 'Start trial', /trial/],
    ['CONTENT_VIEW', 'View content', /view\s+content|content\s+view/],
    ['SEARCH', 'Search', /\bsearch\b/],
    ['FIND_LOCATION', 'Find location', /find\s+(?:a\s+)?location/],
    ['DONATE', 'Donate', /donat/]
  ];
  const parseEvent = v => { const t = norm(v).toLowerCase(); const hit = EVENTS.find(e => e[2].test(t)); return hit ? hit[0] : null; };

  // Performance goals, worded as Ads Manager shows them
  const GOALS = {
    REACH: 'Maximise reach of ads', IMPRESSIONS: 'Maximise number of impressions', AD_RECALL_LIFT: 'Maximise ad recall lift',
    THRUPLAY: 'Maximise ThruPlay views', TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: 'Maximise 2-second continuous video plays',
    LANDING_PAGE_VIEWS: 'Maximise number of landing page views', LINK_CLICKS: 'Maximise number of link clicks',
    POST_ENGAGEMENT: 'Maximise engagement with a post', EVENT_RESPONSES: 'Maximise number of event responses', REMINDERS_SET: 'Maximise number of reminders set',
    CONVERSATIONS: 'Maximise number of conversations', QUALITY_CALL: 'Maximise number of calls',
    PROFILE_VISIT: 'Maximise number of Facebook Page visits', VISIT_INSTAGRAM_PROFILE: 'Maximise number of Instagram profile visits',
    OFFSITE_CONVERSIONS: 'Maximise number of conversions', VALUE: 'Maximise value of conversions',
    LEAD_GENERATION: 'Maximise number of leads', QUALITY_LEAD: 'Maximise number of conversion leads',
    APP_INSTALLS: 'Maximise number of app installs'
  };
  const WEB = ['LANDING_PAGE_VIEWS', 'LINK_CLICKS', 'REACH', 'IMPRESSIONS'];
  const GOAL_TABLE = {
    AWARENESS: { '': ['REACH', 'IMPRESSIONS', 'AD_RECALL_LIFT', 'THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'] },
    TRAFFIC: { website: WEB, app: ['LINK_CLICKS', 'REACH'], messages: ['LINK_CLICKS', 'REACH', 'IMPRESSIONS'], profile: ['VISIT_INSTAGRAM_PROFILE', 'PROFILE_VISIT'], calls: ['QUALITY_CALL'] },
    ENGAGEMENT: {
      on_ad: null, messages: ['CONVERSATIONS', 'LINK_CLICKS'], ig_live: ['REACH', 'IMPRESSIONS'], calls: ['QUALITY_CALL'],
      website: ['OFFSITE_CONVERSIONS'].concat(WEB), app: ['OFFSITE_CONVERSIONS', 'LINK_CLICKS', 'REACH'], profile: ['PROFILE_VISIT', 'VISIT_INSTAGRAM_PROFILE']
    },
    LEADS: { website: ['OFFSITE_CONVERSIONS'].concat(WEB), form: ['LEAD_GENERATION', 'QUALITY_LEAD'], messages: ['LEAD_GENERATION', 'CONVERSATIONS'], calls: ['QUALITY_CALL'], app: ['OFFSITE_CONVERSIONS', 'LINK_CLICKS'] },
    APP_PROMOTION: { app: ['APP_INSTALLS', 'OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS'] },
    SALES: { website: ['OFFSITE_CONVERSIONS', 'VALUE'].concat(WEB), app: ['OFFSITE_CONVERSIONS', 'VALUE', 'LINK_CLICKS'], messages: ['CONVERSATIONS', 'OFFSITE_CONVERSIONS'], calls: ['QUALITY_CALL'] }
  };
  const ON_AD_GOALS = {
    interactions: ['POST_ENGAGEMENT', 'REACH', 'IMPRESSIONS'], video_views: ['THRUPLAY', 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS'],
    event_responses: ['EVENT_RESPONSES', 'POST_ENGAGEMENT'], reminders: ['REMINDERS_SET']
  };
  // The performance goals Ads Manager offers for this campaign's objective, conversion location and engagement type
  function goalsFor(c) {
    const table = GOAL_TABLE[c && c.objective];
    if (!table) return [];
    if (c.objective === 'AWARENESS') return table[''];
    const loc = (LOCATIONS_BY_OBJECTIVE[c.objective] || []).includes(c.conversionLocation) ? c.conversionLocation : DEFAULT_LOCATION[c.objective];
    if (c.objective === 'ENGAGEMENT' && loc === 'on_ad') return ON_AD_GOALS[c.engagementType] || ON_AD_GOALS.interactions;
    return table[loc] || [];
  }
  const goalLabel = (g, c) => c && c.conversionLocation === 'app' && g === 'OFFSITE_CONVERSIONS' ? 'Maximise number of app events' : (GOALS[g] || g);
  function parseGoal(v) {
    const t = norm(v).toLowerCase();
    if (/landing\s+page\s+views?|\blpv/.test(t)) return 'LANDING_PAGE_VIEWS';
    if (/link\s+clicks?|\bclicks?\b/.test(t)) return 'LINK_CLICKS';
    if (/2[\s-]second/.test(t)) return 'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS';
    if (/thru\s?play|video\s+views?/.test(t)) return 'THRUPLAY';
    if (/event\s+responses?/.test(t)) return 'EVENT_RESPONSES';
    if (/reminders?/.test(t)) return 'REMINDERS_SET';
    if (/instagram\s+profile\s+visits?|profile\s+visits?\s+on\s+instagram/.test(t)) return 'VISIT_INSTAGRAM_PROFILE';
    if (/page\s+visits?|profile\s+visits?|page\s+likes?|followers?/.test(t)) return 'PROFILE_VISIT';
    if (/app\s+installs?|\binstalls?\b/.test(t)) return 'APP_INSTALLS';
    if (/ad\s+recall/.test(t)) return 'AD_RECALL_LIFT';
    if (/\breach\b/.test(t)) return 'REACH';
    if (/impressions/.test(t)) return 'IMPRESSIONS';
    if (/conversation|messag/.test(t)) return 'CONVERSATIONS';
    if (/conversion\s+leads|quality\s+leads?/.test(t)) return 'QUALITY_LEAD';
    if (/\bcalls?\b/.test(t)) return 'QUALITY_CALL';
    if (/instant\s+form|lead\s+form/.test(t)) return 'LEAD_GENERATION';
    if (/\bvalue\b|roas/.test(t)) return 'VALUE';
    if (/engagement/.test(t)) return 'POST_ENGAGEMENT';
    if (/conversions?|purchases?|\bleads?\b|pixel|event/.test(t)) return 'OFFSITE_CONVERSIONS';
    return null;
  }

  const BID_STRATEGIES = [
    ['LOWEST_COST_WITHOUT_CAP', 'Highest volume or value'],
    ['COST_CAP', 'Cost per result goal'],
    ['LOWEST_COST_WITH_BID_CAP', 'Bid cap'],
    ['LOWEST_COST_WITH_MIN_ROAS', 'ROAS goal']
  ];
  function parseBidStrategy(v) {
    const t = norm(v).toLowerCase();
    let k = null;
    if (/cost\s*cap|cost\s+per\s+result\s+goal|target\s+(?:cpa|cpl|cost)|(?:cpa|cpl)\s+(?:goal|target|cap)/.test(t)) k = 'COST_CAP';
    else if (/bid\s*cap|manual\s+bid/.test(t)) k = 'LOWEST_COST_WITH_BID_CAP';
    else if (/roas/.test(t)) k = 'LOWEST_COST_WITH_MIN_ROAS';
    else if (/highest\s+(?:volume|value)|lowest\s+cost|automatic|\bauto\b|maximi[sz]e|default|no\s+cap/.test(t)) k = 'LOWEST_COST_WITHOUT_CAP';
    if (!k) return null;
    const a = k === 'LOWEST_COST_WITHOUT_CAP' ? null : findAmount(t);
    return { strategy: k, amount: a ? a.n : null };
  }

  const SPECIAL = [
    ['NONE', 'None'],
    ['HOUSING', 'Housing'],
    ['EMPLOYMENT', 'Employment'],
    ['FINANCIAL_PRODUCTS_SERVICES', 'Financial products and services'],
    ['ISSUES_ELECTIONS_POLITICS', 'Social issues, elections or politics']
  ];
  function parseSpecial(v) {
    // "None (select one only if the Page covers housing…)": the note in brackets is advice, not the answer
    const t = norm(v).toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(?:none|n\/?a|no|not\s+applicable|nil|not\s+needed|not\s+required)\b/.test(t)) return 'NONE';
    if (/\b(?:none|n\/?a|no|not\s+applicable|nil)\b/.test(t) && !/housing|employ|credit|financ|politic|election/.test(t)) return 'NONE';
    if (/housing|real\s+estate|rental|mortgage/.test(t)) return 'HOUSING';
    if (/employ|jobs?\b|hiring|recruit/.test(t)) return 'EMPLOYMENT';
    if (/credit|financ|loan|lending|insurance|banking/.test(t)) return 'FINANCIAL_PRODUCTS_SERVICES';
    if (/politic|election|social\s+issue|advocacy/.test(t)) return 'ISSUES_ELECTIONS_POLITICS';
    return null;
  }

  // Call to action buttons for website ads. Values are the ones Ads Manager imports.
  const CTAS = [
    ['LEARN_MORE', 'Learn more', /learn\s+more|find\s+out|read\s+more|discover|more\s+info|see\s+more/],
    ['BOOK_TRAVEL', 'Book now', /\bbook|reserve|schedule|appointment|consult/],
    ['SHOP_NOW', 'Shop now', /\bshop|buy\s+now|\bbuy\b|purchase/],
    ['SIGN_UP', 'Sign up', /sign\s*up|register|\bjoin|enrol/],
    ['CONTACT_US', 'Contact us', /contact/],
    ['GET_QUOTE', 'Get quote', /quote|estimate/],
    ['GET_OFFER', 'Get offer', /\boffer|\bdeal|claim|coupon|discount|promo/],
    ['APPLY_NOW', 'Apply now', /apply/],
    ['INSTALL_MOBILE_APP', 'Install now', /install/],
    ['DOWNLOAD', 'Download', /download|get\s+(?:the\s+|your\s+)?(?:free\s+)?(?:guide|ebook|e-book|checklist|brochure)/],
    ['ORDER_NOW', 'Order now', /\border/],
    ['SUBSCRIBE', 'Subscribe', /subscri/],
    ['WATCH_MORE', 'Watch more', /watch/],
    ['WHATSAPP_MESSAGE', 'Send WhatsApp message', /whats\s?app/],
    ['MESSAGE_PAGE', 'Send message', /\bmessage|\bdm\b|\bchat/],
    ['CALL_NOW', 'Call now', /\bcall\b|\bphone/],
    ['GET_STARTED', 'Get started', /get\s+started|start\s+(?:now|today|here)/],
    ['DONATE_NOW', 'Donate now', /donat/],
    ['BUY_TICKETS', 'Buy tickets', /ticket/],
    ['REQUEST_TIME', 'Request time', /request\s+(?:a\s+)?time/],
    ['NO_BUTTON', 'No button', /no\s+(?:button|cta)|^none$/]
  ];
  function parseCta(v) {
    const t = norm(v).toLowerCase().replace(/[!.]+$/, '');
    if (!t) return null;
    const exact = CTAS.find(c => c[0].toLowerCase() === t.replace(/\s+/g, '_') || c[1].toLowerCase() === t);
    if (exact) return exact[0];
    const hit = CTAS.find(c => c[2].test(t));
    return hit ? hit[0] : null;
  }
  const ctaLabel = k => (CTAS.find(c => c[0] === k) || [, k || ''])[1];

  function parseFormat(v) {
    const t = norm(v).toLowerCase();
    if (/carousel|multi[\s-]?(?:image|card)|slides?\b/.test(t)) return 'carousel';
    if (/video|reels?\b|\bugc\b|motion|animation|animated|gif|\bclip\b|vsl|testimonial\s+video/.test(t)) return 'video';
    if (/image|static|photo|graphic|picture|still|single\s+image|banner|infographic|before\s*(?:\/|and|&)\s*after/.test(t)) return 'image';
    return null;
  }

  function parseAge(v) {
    const t = asciiDigits(norm(v)).toLowerCase();
    const NOT_AGE = '(?!\\s*(?:mi\\b|miles?|km|kilomet|%|percent|days?\\b|day\\b|hours?|mins?|minutes|sec|k\\b|ft|feet|\\.\\d))';
    let m = t.match(new RegExp('(?<![\\d$.,:/])(1[3-9]|[2-6]\\d)\\s*(?:-|–|—|to|through|thru)\\s*(1[3-9]|[2-6]\\d)\\s*(\\+)?' + NOT_AGE));
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; return { min: a, max: Math.min(b, 65) }; }
    m = t.match(new RegExp('(?<![\\d$.,:/])(1[3-9]|[2-6]\\d)\\s*\\+' + NOT_AGE)) || t.match(/(?:over|above|older\s+than)\s+(1[3-9]|[2-6]\d)\b/) || t.match(/\b(1[3-9]|[2-6]\d)\s+(?:and|&)\s+(?:over|older|up)\b/);
    if (m) return { min: +m[1], max: 65 };
    m = t.match(/(?:under|below|younger\s+than)\s+(1[4-9]|[2-6]\d)\b/);
    if (m) return { min: 18, max: +m[1] - 1 };
    if (/\ball\s+(?:ages|adults)\b/.test(t)) return { min: 18, max: 65 };
    return null;
  }

  function parseGender(v) {
    const t = ' ' + norm(v).toLowerCase() + ' ';
    const w = /\b(?:women|woman|female|females|ladies|moms?|mums?|mothers?|girls|brides?)\b/.test(t);
    const m = /\b(?:men|man|male|males|dads?|fathers?|guys|boys|grooms?)\b/.test(t);
    if (w && m) return 'all';
    if (w) return 'women';
    if (m) return 'men';
    if (/\b(?:all|both|any|everyone|everybody)\b/.test(t)) return 'all';
    return null;
  }

  // Placements. Position values are the ones Ads Manager uses in its import file.
  const POSITIONS = {
    facebook: [['feed', 'Feed'], ['profile_feed', 'Profile feed'], ['marketplace', 'Marketplace'], ['video_feeds', 'Video feeds'], ['right_hand_column', 'Right column'], ['story', 'Stories'], ['facebook_reels', 'Reels'], ['instream_video', 'In-stream video'], ['search', 'Search results']],
    instagram: [['stream', 'Feed'], ['profile_feed', 'Profile feed'], ['explore', 'Explore'], ['explore_home', 'Explore home'], ['story', 'Stories'], ['reels', 'Reels'], ['ig_search', 'Search results']],
    messenger: [['messenger_home', 'Inbox'], ['story', 'Stories']],
    audience_network: [['classic', 'Native, banner and interstitial'], ['rewarded_video', 'Rewarded video']]
  };
  const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', messenger: 'Messenger', audience_network: 'Audience Network' };
  // position words -> the value on each platform that has that position
  const POSITION_WORDS = [
    ['video_feeds', /\bvideo\s+feeds?\b/, { facebook: 'video_feeds' }],
    ['feed', /(?<!video\s|profile\s)\bfeeds?\b|\bnews\s*feed\b/, { facebook: 'feed', instagram: 'stream' }],
    ['story', /\bstor(?:y|ies)\b/, { facebook: 'story', instagram: 'story', messenger: 'story' }],
    ['reels', /\breels?\b/, { facebook: 'facebook_reels', instagram: 'reels' }],
    ['explore', /\bexplore\b/, { instagram: 'explore' }],
    ['marketplace', /\bmarketplace\b/, { facebook: 'marketplace' }],
    ['right_column', /\bright\s+(?:hand\s+)?column\b/, { facebook: 'right_hand_column' }],
    ['instream', /\bin[\s-]?stream\b/, { facebook: 'instream_video' }],
    ['search', /\bsearch\b/, { facebook: 'search', instagram: 'ig_search' }],
    ['profile', /\bprofile\b/, { facebook: 'profile_feed', instagram: 'profile_feed' }],
    ['inbox', /\binbox\b/, { messenger: 'messenger_home' }]
  ];
  const PLAT_WORD = /\b(facebook|fb|instagram|insta|ig|messenger|audience\s+network)\b/g;
  const platKey = w => /^(?:facebook|fb)$/.test(w) ? 'facebook' : /^(?:instagram|insta|ig)$/.test(w) ? 'instagram' : w === 'messenger' ? 'messenger' : 'audience_network';
  const wordsIn = s => POSITION_WORDS.filter(([, rx]) => rx.test(s)).map(w => w[0]);
  // "Instagram Feed, Stories and Reels; Facebook Feed": each platform takes the positions written after it.
  // "Facebook & Instagram Feed, Reels" shares them; "Instagram only" takes all of Instagram's.
  // Words that turn a placement off: "Instagram, Messenger and Audience Network all unchecked", "no Stories"
  const PLACEMENT_OFF = /\b(?:un-?check(?:ed)?|untick(?:ed)?|de-?select(?:ed)?|remove[ds]?|off|exclud(?:e|ed|ing)|not|no|without|except|disabled?|skip(?:ped)?|avoid)\b/;
  function parsePlacements(v) {
    const t = norm(v).toLowerCase();
    if (!t) return null;
    if (PLACEMENT_OFF.test(t)) return parsePlacementClauses(t);
    return parsePlacementText(t);
  }
  // Each clause either adds platforms and positions or takes them away
  function parsePlacementClauses(t) {
    const clauses = t.split(/[.;!]+\s*|\s*,?\s*\bbut\b\s*|\s*,\s*(?=(?:and\s+)?(?:no|not|without|except|excluding)\b)|\s+(?=(?:except|excluding|without)\b)/).map(x => x.trim()).filter(Boolean);
    let on = null;
    const offPlat = new Set(), offPos = [];
    clauses.forEach(c => {
      if (!PLACEMENT_OFF.test(c)) { const p = parsePlacementText(c); if (p) on = mergePlacements(on, p); return; }
      const plats = [];
      let m;
      PLAT_WORD.lastIndex = 0;
      while ((m = PLAT_WORD.exec(c))) plats.push(platKey(m[1].replace(/\s+/g, ' ')));
      const words = wordsIn(c);
      if (words.length) offPos.push({ plats, words });
      else plats.forEach(p => offPlat.add(p));
    });
    if (!on || on.mode !== 'manual') {
      if (!offPlat.size && !offPos.length) return on;
      // "No Audience Network": every other platform stays on
      on = { mode: 'manual', platforms: [], positions: {} };
      ['facebook', 'instagram', 'messenger', 'audience_network'].forEach(p => { on.platforms.push(p); on.positions[p] = POSITIONS[p].map(x => x[0]); });
    }
    const out = { mode: 'manual', platforms: [], positions: {} };
    on.platforms.forEach(p => {
      if (offPlat.has(p)) return;
      let list = (on.positions[p] || []).slice();
      offPos.forEach(o => {
        if (o.plats.length && !o.plats.includes(p)) return;
        const drop = POSITION_WORDS.filter(w => o.words.includes(w[0]) && w[2][p]).map(w => w[2][p]);
        list = list.filter(x => !drop.includes(x) && !(x === 'explore_home' && drop.includes('explore')));
      });
      if (!list.length) return;
      out.platforms.push(p);
      out.positions[p] = list;
    });
    return out.platforms.length ? out : null;
  }
  function parsePlacementText(t) {
    if (/advantage\s*\+?\s*placements?|\bautomatic\b|\bauto\s+placements?|\ball\s+placements\b|advantage\s*\+|\bautomated\b/.test(t)) return { mode: 'advantage' };
    const mentions = [];
    let m;
    PLAT_WORD.lastIndex = 0;
    while ((m = PLAT_WORD.exec(t))) mentions.push({ p: platKey(m[1].replace(/\s+/g, ' ')), at: m.index, end: m.index + m[0].length });
    const want = {};
    if (!mentions.length) {
      const words = wordsIn(t);
      if (!words.length) return null;
      want.facebook = words; want.instagram = words;
    } else {
      const pre = wordsIn(t.slice(0, mentions[0].at));
      const spans = mentions.map((x, i) => t.slice(x.end, i + 1 < mentions.length ? mentions[i + 1].at : t.length));
      const words = spans.map(wordsIn);
      for (let i = mentions.length - 1; i >= 0; i--) {
        if (words[i].length) continue;
        if (i + 1 < mentions.length && /^[\s&,+/]*(?:and)?[\s&,+/]*$/.test(spans[i])) words[i] = words[i + 1];
        else if (pre.length) words[i] = pre;
      }
      mentions.forEach((x, i) => { want[x.p] = Array.from(new Set((want[x.p] || []).concat(words[i].length ? words[i] : ['*']))); });
    }
    const out = { mode: 'manual', platforms: [], positions: {} };
    ['facebook', 'instagram', 'messenger', 'audience_network'].forEach(p => {
      if (!want[p]) return;
      const list = want[p].includes('*') ? POSITIONS[p].map(x => x[0])
        : POSITION_WORDS.filter(w => want[p].includes(w[0]) && w[2][p]).map(w => w[2][p]);
      if (!list.length) return;
      if (list.includes('explore')) list.push('explore_home');
      out.platforms.push(p);
      out.positions[p] = Array.from(new Set(list));
    });
    return out.platforms.length ? out : null;
  }
  const mergePlacements = (a, b) => {
    if (!a) return b; if (!b) return a;
    if (a.mode === 'advantage' || b.mode === 'advantage') return a.mode === 'advantage' ? a : b;
    const out = { mode: 'manual', platforms: [], positions: {} };
    [a, b].forEach(x => x.platforms.forEach(p => {
      if (!out.platforms.includes(p)) out.platforms.push(p);
      out.positions[p] = Array.from(new Set((out.positions[p] || []).concat(x.positions[p] || [])));
    }));
    return out;
  };
  function placementsText(pl) {
    if (!pl || pl.mode !== 'manual') return 'Advantage+ placements';
    return pl.platforms.map(p => PLATFORM_LABEL[p] + ' ' + (pl.positions[p] || []).map(x => (POSITIONS[p].find(q => q[0] === x) || [, x])[1]).join(', ')).join('; ');
  }

  /* ---------- 4. Locations ---------- */

  const COUNTRY_SRC = 'AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua and Barbuda|AI:Anguilla|AL:Albania|AM:Armenia|AO:Angola|AQ:Antarctica|AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|AW:Aruba|AX:Aland Islands|AZ:Azerbaijan|BA:Bosnia and Herzegovina|BB:Barbados|BD:Bangladesh|BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:Saint Barthelemy|BM:Bermuda|BN:Brunei|BO:Bolivia|BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CC:Cocos Islands|CD:Democratic Republic of the Congo|CF:Central African Republic|CG:Republic of the Congo|CH:Switzerland|CI:Cote d\'Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|CU:Cuba|CV:Cape Verde|CW:Curacao|CX:Christmas Island|CY:Cyprus|CZ:Czechia|DE:Germany|DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|EG:Egypt|EH:Western Sahara|ER:Eritrea|ES:Spain|ET:Ethiopia|FI:Finland|FJ:Fiji|FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|GB:United Kingdom|GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|GN:Guinea|GP:Guadeloupe|GQ:Equatorial Guinea|GR:Greece|GS:South Georgia and the South Sandwich Islands|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|HK:Hong Kong|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IO:British Indian Ocean Territory|IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:Saint Kitts and Nevis|KP:North Korea|KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:Saint Lucia|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:Saint Martin|MG:Madagascar|MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macau|MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|MS:Montserrat|MT:Malta|MU:Mauritius|MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland|PM:Saint Pierre and Miquelon|PN:Pitcairn Islands|PR:Puerto Rico|PS:Palestine|PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RE:Reunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|SA:Saudi Arabia|SB:Solomon Islands|SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|SH:Saint Helena|SI:Slovenia|SJ:Svalbard and Jan Mayen|SK:Slovakia|SL:Sierra Leone|SM:San Marino|SN:Senegal|SO:Somalia|SR:Suriname|SS:South Sudan|ST:Sao Tome and Principe|SV:El Salvador|SX:Sint Maarten|SY:Syria|SZ:Eswatini|TC:Turks and Caicos Islands|TD:Chad|TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Turkey|TT:Trinidad and Tobago|TV:Tuvalu|TW:Taiwan|TZ:Tanzania|UA:Ukraine|UG:Uganda|US:United States|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VC:Saint Vincent and the Grenadines|VE:Venezuela|VG:British Virgin Islands|VI:US Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis and Futuna|WS:Samoa|XK:Kosovo|YE:Yemen|YT:Mayotte|ZA:South Africa|ZM:Zambia|ZW:Zimbabwe';
  const COUNTRIES = COUNTRY_SRC.split('|').map(x => { const i = x.indexOf(':'); return { code: x.slice(0, i), name: x.slice(i + 1) }; });
  const COUNTRY_ALIASES = {
    'usa': 'US', 'u s': 'US', 'u s a': 'US', 'united states of america': 'US', 'america': 'US', 'the us': 'US', 'the usa': 'US', 'the united states': 'US', 'us': 'US',
    'uk': 'GB', 'u k': 'GB', 'great britain': 'GB', 'britain': 'GB', 'the uk': 'GB', 'the united kingdom': 'GB',
    'uae': 'AE', 'u a e': 'AE', 'emirates': 'AE', 'the uae': 'AE', 'ksa': 'SA', 'saudi': 'SA', 'kingdom of saudi arabia': 'SA',
    'holland': 'NL', 'the netherlands': 'NL', 'czech republic': 'CZ', 'ivory coast': 'CI', 'burma': 'MM', 'turkiye': 'TR', 'türkiye': 'TR',
    'korea': 'KR', 'republic of korea': 'KR', 'russian federation': 'RU', 'viet nam': 'VN', 'macedonia': 'MK', 'swaziland': 'SZ', 'cabo verde': 'CV',
    'drc': 'CD', 'dr congo': 'CD', 'congo': 'CG', 'lao': 'LA', 'brunei darussalam': 'BN', 'palestinian territories': 'PS', 'holy see': 'VA',
    'macao': 'MO', 'east timor': 'TL', 'st lucia': 'LC', 'st kitts and nevis': 'KN', 'st vincent and the grenadines': 'VC', 'the bahamas': 'BS', 'the gambia': 'GM',
    'curaçao': 'CW', 'côte d ivoire': 'CI', 'cote d ivoire': 'CI', 'réunion': 'RE', 'são tomé and príncipe': 'ST'
  };
  const plainKey = s => key(String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''));
  const COUNTRY_BY_KEY = {};
  COUNTRIES.forEach(c => { COUNTRY_BY_KEY[plainKey(c.name)] = c.code; });
  Object.keys(COUNTRY_ALIASES).forEach(k => { COUNTRY_BY_KEY[plainKey(k)] = COUNTRY_ALIASES[k]; });
  const countryName = code => (COUNTRIES.find(c => c.code === code) || {}).name || code;
  // A country by name or alias; two-letter codes only when written in capitals ("US", "CA") or as us/uk/uae
  function findCountry(p, allowCode) {
    const s = norm(p);
    const k = plainKey(s);
    if (COUNTRY_BY_KEY[k]) return COUNTRY_BY_KEY[k];
    if (allowCode !== false && /^[A-Z]{2}$/.test(s) && COUNTRIES.some(c => c.code === s)) return s;
    return null;
  }

  const US_STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };
  const CA_PROVINCES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
  const AU_STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
  const OTHER_REGIONS = { 'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB', 'abu dhabi': 'AE', 'sharjah': 'AE', 'ajman': 'AE', 'ras al khaimah': 'AE', 'fujairah': 'AE', 'punjab': 'PK', 'sindh': 'PK', 'maharashtra': 'IN', 'karnataka': 'IN', 'tamil nadu': 'IN', 'kerala': 'IN', 'gujarat': 'IN', 'telangana': 'IN' };
  // Big cities that can stand alone; value is [region or '', country code]
  const BIG_CITIES = {
    'new york city': ['NY', 'US'], 'nyc': ['NY', 'US'], 'los angeles': ['CA', 'US'], 'chicago': ['IL', 'US'], 'houston': ['TX', 'US'], 'phoenix': ['AZ', 'US'], 'philadelphia': ['PA', 'US'], 'san antonio': ['TX', 'US'], 'san diego': ['CA', 'US'], 'dallas': ['TX', 'US'], 'austin': ['TX', 'US'], 'miami': ['FL', 'US'], 'atlanta': ['GA', 'US'], 'boston': ['MA', 'US'], 'seattle': ['WA', 'US'], 'denver': ['CO', 'US'], 'las vegas': ['NV', 'US'], 'san francisco': ['CA', 'US'], 'nashville': ['TN', 'US'], 'orlando': ['FL', 'US'], 'tampa': ['FL', 'US'], 'charlotte': ['NC', 'US'], 'detroit': ['MI', 'US'], 'minneapolis': ['MN', 'US'], 'portland': ['OR', 'US'], 'salt lake city': ['UT', 'US'], 'san jose': ['CA', 'US'],
    'toronto': ['ON', 'CA'], 'vancouver': ['BC', 'CA'], 'montreal': ['QC', 'CA'], 'calgary': ['AB', 'CA'], 'ottawa': ['ON', 'CA'], 'edmonton': ['AB', 'CA'], 'mississauga': ['ON', 'CA'],
    'london': ['', 'GB'], 'manchester': ['', 'GB'], 'leeds': ['', 'GB'], 'liverpool': ['', 'GB'], 'glasgow': ['', 'GB'], 'edinburgh': ['', 'GB'], 'bristol': ['', 'GB'],
    'sydney': ['NSW', 'AU'], 'melbourne': ['VIC', 'AU'], 'brisbane': ['QLD', 'AU'], 'perth': ['WA', 'AU'], 'adelaide': ['SA', 'AU'], 'auckland': ['', 'NZ'], 'wellington': ['', 'NZ'],
    'dublin': ['', 'IE'], 'dubai': ['', 'AE'], 'riyadh': ['', 'SA'], 'jeddah': ['', 'SA'], 'doha': ['', 'QA'], 'karachi': ['', 'PK'], 'lahore': ['', 'PK'], 'islamabad': ['', 'PK'],
    'mumbai': ['', 'IN'], 'delhi': ['', 'IN'], 'new delhi': ['', 'IN'], 'bangalore': ['', 'IN'], 'bengaluru': ['', 'IN'], 'hyderabad': ['', 'IN'], 'chennai': ['', 'IN'],
    'paris': ['', 'FR'], 'berlin': ['', 'DE'], 'munich': ['', 'DE'], 'madrid': ['', 'ES'], 'barcelona': ['', 'ES'], 'rome': ['', 'IT'], 'milan': ['', 'IT'], 'amsterdam': ['', 'NL'],
    'cape town': ['', 'ZA'], 'johannesburg': ['', 'ZA'], 'lagos': ['', 'NG'], 'nairobi': ['', 'KE'], 'cairo': ['', 'EG'], 'kuala lumpur': ['', 'MY'], 'manila': ['', 'PH'], 'jakarta': ['', 'ID'], 'bangkok': ['', 'TH'], 'tokyo': ['', 'JP'], 'seoul': ['', 'KR'], 'mexico city': ['', 'MX'], 'sao paulo': ['', 'BR'], 'buenos aires': ['', 'AR']
  };
  const lookup = (map, p, allowCode) => {
    const s = norm(p).replace(/\./g, '');
    if (allowCode && /^[A-Za-z]{2,3}$/.test(s) && map[s.toUpperCase()] && s === s.toUpperCase()) return s.toUpperCase();
    const k = plainKey(s);
    for (const c in map) if (plainKey(map[c]) === k) return c;
    return null;
  };
  const usState = (p, code) => lookup(US_STATES, p, code !== false);
  const caProvince = (p, code) => lookup(CA_PROVINCES, p, code !== false);
  const auState = (p, code) => lookup(AU_STATES, p, code !== false);
  const otherRegion = p => OTHER_REGIONS[plainKey(p)] || null;
  const titleCase = s => s.replace(/\b\p{L}/gu, c => c.toUpperCase());
  const nice = p => p === p.toLowerCase() ? titleCase(p) : p;

  // Compound names that contain "and" stay together when a list is split on "and"
  const AND_NAMES = new Set(COUNTRIES.map(c => c.name).concat(Object.values(CA_PROVINCES)).filter(n => / and /.test(n)).map(plainKey));

  // A location value -> { list: [{type, name, code, region, country, radius, unit}], notes }
  // type: country (code), region (name, country), city (name, region, country)
  function parseLocations(value) {
    const out = [];
    const notes = [];
    const add = loc => { if (!out.some(o => o.type === loc.type && plainKey(o.name) === plainKey(loc.name) && o.region === loc.region && o.country === loc.country)) out.push(loc); };
    let t = norm(value)
      .replace(/\b(?:and|plus|&)\s+(?:the\s+)?(?:surrounding|nearby|neighbou?ring)\s+(?:areas?|suburbs?|towns?|cities|region)\b/gi, '')
      .replace(/\b(?:surrounding|nearby|neighbou?ring)\s+(?:areas?|suburbs?|towns?|cities)\b/gi, '')
      .replace(/\b(?:people\s+)?(?:living\s+in|located\s+in|who\s+live\s+in|based\s+in|in)\s+(?=[A-Z])/g, '')
      .replace(/^(?:target(?:ing)?\s*:?\s*)/i, '');
    if (!t) return { list: out, notes };
    // split on ; | newlines and "plus"/"and"/"&" between places, then rejoin compound names
    let segs = t.split(/\s*(?:;|\||\n|\s+plus\s+|\s+as\s+well\s+as\s+)\s*/i).filter(Boolean);
    segs = segs.flatMap(s => {
      const parts = s.split(/\s+(?:and|&)\s+/i);
      const res = [];
      parts.forEach(p => {
        if (res.length && AND_NAMES.has(plainKey(res[res.length - 1] + ' and ' + p))) res[res.length - 1] += ' and ' + p;
        else res.push(p);
      });
      return res;
    });
    let lastRegion = null; // a town list inherits the state written with its first town
    segs.forEach(seg => {
      let s = norm(seg).replace(/^[-–—:,.]+|[.,;:]+$/g, '').trim();
      if (!s) return;
      let radius = null, unit = 'mi';
      let m;
      const R = '(\\d+(?:\\.\\d+)?)(?:\\s*(?:-|–|to)\\s*(\\d+(?:\\.\\d+)?))?\\s*(mi(?:les?)?|km|kms|kilomet(?:er|re)s?)\\b';
      if ((m = s.match(new RegExp('^(?:a\\s+|the\\s+|within\\s+(?:a\\s+)?)?' + R + '\\s*(?:radius\\s*)?(?:of|around|from|surrounding|near)\\s+(.+)$', 'i')))) {
        radius = +(m[2] || m[1]); unit = /^k/i.test(m[3]) ? 'km' : 'mi'; s = m[4];
      } else if ((m = s.match(new RegExp('^(.+?)\\s*\\(?\\s*(?:\\+|within)\\s*' + R + '(?:\\s*radius)?\\s*\\)?$', 'i')))) {
        radius = +(m[3] || m[2]); unit = /^k/i.test(m[4]) ? 'km' : 'mi'; s = m[1];
      } else if ((m = s.match(new RegExp('^(.+?)\\s*(?:,|-|–|with\\s+a|\\()?\\s*' + R + '\\s*radius\\)?$', 'i')))) {
        radius = +(m[3] || m[2]); unit = /^k/i.test(m[4]) ? 'km' : 'mi'; s = m[1];
      }
      s = s.replace(/^(?:downtown|greater|central|metro(?:politan)?|the)\s+/i, '').replace(/\s+(?:metro(?:\s+area)?|area|region|county|city\s+area)$/i, '').replace(/[.,;:]+$/, '').trim();
      if (!s) return;
      const parts = s.split(/\s*,\s*/).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i], next = parts[i + 1], third = parts[i + 2];
        const rad = { radius, unit };
        const st = next && (usState(next) || null);
        if (st && !findCountry(p, false) && !usState(p, false)) {
          add(Object.assign({ type: 'city', name: nice(p), region: st, country: 'US' }, rad));
          lastRegion = { region: st, country: 'US' };
          i += (third && findCountry(third) === 'US') ? 2 : 1;
          continue;
        }
        const pr = next && caProvince(next);
        if (pr && !findCountry(p, false)) { add(Object.assign({ type: 'city', name: nice(p), region: pr, country: 'CA' }, rad)); lastRegion = { region: pr, country: 'CA' }; i += (third && findCountry(third) === 'CA') ? 2 : 1; continue; }
        const au = next && auState(next);
        if (au && !findCountry(p, false)) { add(Object.assign({ type: 'city', name: nice(p), region: au, country: 'AU' }, rad)); lastRegion = { region: au, country: 'AU' }; i += (third && findCountry(third) === 'AU') ? 2 : 1; continue; }
        const orc = next && otherRegion(next);
        if (orc && !findCountry(p, false)) { add(Object.assign({ type: 'city', name: nice(p), region: nice(next), country: orc }, rad)); lastRegion = { region: nice(next), country: orc }; i += (third && findCountry(third) === orc) ? 2 : 1; continue; }
        const nc = next && findCountry(next);
        if (nc && !findCountry(p, false) && !usState(p, false)) { add(Object.assign({ type: 'city', name: nice(p), region: '', country: nc }, rad)); i++; continue; }
        const c = findCountry(p);
        if (c && !radius) { add({ type: 'country', code: c, name: countryName(c) }); continue; }
        const big = BIG_CITIES[plainKey(p)];
        if (big) { add(Object.assign({ type: 'city', name: nice(p).replace(/^Nyc$/i, 'New York'), region: big[0], country: big[1] }, rad)); continue; }
        const us = usState(p, false) || (/^[A-Z]{2}$/.test(p) && !findCountry(p) ? usState(p) : null);
        if (us && !radius) { add({ type: 'region', name: US_STATES[us], code: us, country: 'US' }); continue; }
        const ca = caProvince(p, false);
        if (ca && !radius) { add({ type: 'region', name: CA_PROVINCES[ca], code: ca, country: 'CA' }); continue; }
        const aus = auState(p, false);
        if (aus && !radius) { add({ type: 'region', name: AU_STATES[aus], code: aus, country: 'AU' }); continue; }
        const oth = otherRegion(p);
        if (oth && !radius) { add({ type: 'region', name: nice(p), code: '', country: oth }); continue; }
        if (!/^[\p{L}][\p{L}\s'.-]{1,40}$/u.test(p) || p.split(' ').length > 4) { notes.push('Could not read "' + p + '" as a place.'); continue; }
        if (lastRegion) { add(Object.assign({ type: 'city', name: nice(p), region: lastRegion.region, country: lastRegion.country }, rad)); continue; }
        add(Object.assign({ type: 'city', name: nice(p), region: '', country: '', unmatched: true }, rad));
      }
    });
    // Meta's city radius runs from 10 to 50 miles (17 to 80 km)
    out.forEach(l => {
      if (l.type !== 'city' || l.radius == null) return;
      const lo = l.unit === 'km' ? 17 : 10, hi = l.unit === 'km' ? 80 : 50;
      if (l.radius < lo || l.radius > hi) {
        const r = Math.min(hi, Math.max(lo, l.radius));
        notes.push(l.name + ': a ' + l.radius + ' ' + l.unit + ' radius is outside Meta\'s ' + lo + ' to ' + hi + ' ' + l.unit + ' range for cities, so it is set to ' + r + ' ' + l.unit + '.');
        l.radius = r;
      }
    });
    return { list: out, notes };
  }
  const locLabel = l => l.type === 'country' ? l.name
    : l.type === 'region' ? l.name + (l.country && l.country !== 'US' ? ', ' + countryName(l.country) : '')
      : l.name + (l.region ? ', ' + l.region : '') + (l.country && l.country !== 'US' ? ', ' + countryName(l.country) : '') + (l.radius ? ' (+' + l.radius + ' ' + l.unit + ')' : '');
  const locCountry = l => l.type === 'country' ? l.code : l.country;

  // "weight loss, fitness and nutrition" -> list; keeps "Health & wellness" together
  function splitList(v) {
    return norm(v).replace(/^(?:e\.?g\.?|such\s+as|like|including|incl\.?)\s+/i, '')
      .split(/\s*[,;\n]\s*|\s+(?:and|or)\s+(?=[\p{L}])|\s*\|\s*|\s+\/\s+/u)
      .map(x => norm(x).replace(/^(?:and|or|e\.?g\.?|such\s+as|like|including)\s+/i, '').replace(/[.;:]+$/, '').replace(/^["']|["']$/g, ''))
      .filter(x => x && x.length <= 80);
  }

  // Free text such as "Women 30 to 55 in Austin, interested in weight loss, fitness" -> pieces
  function parseAudience(v) {
    const t = norm(v);
    const out = { age: parseAge(t), gender: null, interests: [], audiences: [], locations: [], notes: [] };
    const g = parseGender(t);
    if (g && g !== 'all') out.gender = g;
    let rest = t;
    let m = rest.match(/\binterest(?:s|ed)?\s*(?:in|:|-|–|around|such\s+as|like|including|incl\.?)?\s*(.+?)(?:[.;]|$)/i);
    if (m) {
      out.interests = splitList(m[1]).filter(x => !/^\d/.test(x));
      rest = rest.replace(m[0], ' ');
    }
    if (/\blook\s?alike|\blal\b|\blla\b/i.test(rest)) {
      const lm = rest.match(/(?:\d{1,2}\s*%\s*)?(?:look\s?alike|\blal\b|\blla\b)[^.;,]*/i);
      out.audiences.push(norm(lm ? lm[0] : 'Lookalike audience'));
    } else if (/\b(?:website\s+visitors|site\s+visitors|retarget|remarket|engagers|engaged\s+with|past\s+customers|customer\s+list|email\s+list|abandon|video\s+viewers|page\s+followers|ig\s+followers|warm\s+audience|existing\s+customers)\b/i.test(rest)) {
      const am = rest.match(/[^.;,]*(?:website\s+visitors|site\s+visitors|retarget|remarket|engagers|engaged\s+with|past\s+customers|customer\s+list|email\s+list|abandon|video\s+viewers|page\s+followers|ig\s+followers|warm\s+audience|existing\s+customers)[^.;,]*/i);
      out.audiences.push(norm(am ? am[0] : rest).replace(/^(?:and|plus|target(?:ing)?)\s+/i, ''));
    }
    m = t.match(/(?:within\s+)?\d+(?:\s*(?:-|–|to)\s*\d+)?\s*(?:mi|miles?|km)\b[^.;]*?(?:of|around|from)\s+[^.;]+/i);
    if (m) out.locations = parseLocations(m[0]).list;
    return out;
  }

  const findUrl = v => {
    const m = norm(v).match(/\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|co|io|ae|uk|ca|au|in|pk|us|biz|info|health|clinic|dental|law|me|app|shop|store|online|site)(?:\.[a-z]{2})?(?:\/[^\s<>"')\]]*)?/i);
    if (!m) return '';
    let u = m[0].replace(/[.,;:!?]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  };

  /* ---------- 5. Doc -> nodes ---------- */

  function newNode(kind, name, parent) {
    return { kind, name: name || '', parent: parent || null, f: {}, l: { primary: [], headline: [], description: [], interests: [], audiences: [], exclusions: [], locations: [], notes: [], settings: [] }, placeholder: false, explicit: false };
  }
  function newResult() {
    return { title: '', account: newNode('account', ''), campaigns: [], adSets: [], ads: [], notes: [], skipped: [], placeholders: [] };
  }

  function findCampaign(res, name) {
    const k = key(name);
    if (!k) return null;
    return res.campaigns.find(c => key(c.name) === k) || res.campaigns.find(c => sim(c.name, name) >= 0.8) || null;
  }
  function addCampaign(res, name, opts) {
    const nm = cleanName(name);
    const hit = findCampaign(res, nm);
    if (hit) { if (!(opts && opts.placeholder)) { hit.placeholder = false; hit.explicit = true; } return hit; }
    const c = newNode('campaign', nm);
    c.placeholder = !!(opts && opts.placeholder);
    c.explicit = !c.placeholder;
    res.campaigns.push(c);
    return c;
  }
  function findAdSet(res, campaign, name) {
    const nm = cleanName(name);
    const pool = res.adSets.filter(a => a.parent === campaign);
    const tail = /:\s*(.+)$/.exec(nm);
    return pool.find(a => key(a.name) === key(nm)) || pool.find(a => sim(a.name, nm) >= 0.75)
      || (tail && pool.find(a => sim(a.name, tail[1]) >= 0.75)) || null;
  }
  function addAdSet(res, campaign, name, opts) {
    const hit = findAdSet(res, campaign, name);
    if (hit) {
      if (!(opts && opts.placeholder)) { hit.placeholder = false; hit.explicit = true; }
      return hit;
    }
    const a = newNode('adset', cleanName(name), campaign);
    a.placeholder = !!(opts && opts.placeholder);
    a.explicit = !a.placeholder;
    res.adSets.push(a);
    return a;
  }
  function addAd(res, adSet, name) {
    const ad = newNode('ad', cleanName(name), adSet);
    ad.explicit = true;
    res.ads.push(ad);
    return ad;
  }

  // Which node a field belongs to, given the current campaign / ad set / ad
  const CAMPAIGN_FIELDS = new Set(['objective', 'specialCategory', 'budgetType', 'engagementType', 'messageApps']);
  const ACCOUNT_FIELDS = new Set(['phone', 'appId', 'appStore']);
  const ADSET_FIELDS = new Set(['budget', 'bidStrategy', 'bidAmount', 'startDate', 'endDate', 'schedule', 'conversionLocation', 'event', 'optimization', 'pixel', 'page', 'leadForm', 'age', 'gender', 'locations', 'interests', 'audiences', 'exclusions', 'audience', 'placements', 'languages', 'devices']);

  // A goal that only one conversion location offers
  const GOAL_LOCATION = { THRUPLAY: 'on_ad', TWO_SECOND_CONTINUOUS_VIDEO_VIEWS: 'on_ad', POST_ENGAGEMENT: 'on_ad', EVENT_RESPONSES: 'on_ad', REMINDERS_SET: 'on_ad', CONVERSATIONS: 'messages', QUALITY_CALL: 'calls', PROFILE_VISIT: 'profile', VISIT_INSTAGRAM_PROFILE: 'profile', LEAD_GENERATION: 'form', APP_INSTALLS: 'app' };
  // the engagement type and message apps a location phrase carries
  function setLocationDetail(f, v) {
    const et = parseEngagementType(v);
    if (et && (f.conversionLocation === 'on_ad' || !f.conversionLocation)) f.engagementType = f.engagementType || et;
    if (f.conversionLocation === 'messages') { const apps = parseMessageApps(v); if (apps.length && !f.messageApps) f.messageApps = apps; }
  }

  // Put one field value on a node. Returns false when the value could not be read.
  function putField(res, node, field, value, src) {
    const v = norm(value);
    const f = node.f, l = node.l;
    const srcLabel = norm(src && src.label || '');
    // "[Client Page name]", "[date]": a blank the doc's author left to fill in
    if (!COPY_FIELDS.has(field) && !/Name$/.test(field) && field !== 'setting' && (onlyPlaceholder(v) || (PLACEHOLDER.test(v) && !findAmount(v.replace(/\[[^\]]*\]/g, ' ')) && !/\d{4}/.test(v) && ['schedule', 'startDate', 'endDate', 'page', 'pixel', 'leadForm', 'url', 'phone', 'appId', 'appStore'].includes(field)))) {
      if (res.placeholders && !res.placeholders.some(x => x.value === v)) res.placeholders.push({ label: srcLabel || fieldName(field), value: v });
      return true;
    }
    switch (field) {
      case 'objective': {
        const o = parseObjective(v);
        if (!o) return false;
        f.objective = o;
        // "Engagement – Video views", "Leads (Instant Form)", "Traffic to Instagram profile"
        const rest = v.replace(/^[^(–—:-]*?(?:awareness|traffic|engagement|leads?|lead\s+gen(?:eration)?|sales|app\s+promotion)\b/i, '');
        const loc = parseConversionLocation(rest) || (o === 'APP_PROMOTION' ? 'app' : null);
        if (loc && (LOCATIONS_BY_OBJECTIVE[o] || []).includes(loc) && !f.conversionLocation) f.conversionLocation = loc;
        setLocationDetail(f, rest);
        if (o === 'TRAFFIC' && /link\s+clicks?/i.test(v) && !f.optimization) f.optimization = 'LINK_CLICKS';
        return true;
      }
      case 'budget': {
        const b = parseBudget(src && src.label, v);
        if (!b) return false;
        if (/\b(?:cbo|campaign\s+budget|advantage\s+(?:\+\s*)?campaign\s+budget|(?:at\s+)?campaign\s+level)\b/i.test(v) && !/\bno\s+cbo\b|campaign\s+budget\s+(?:is\s+)?off/i.test(v) && !f.budgetType) f.budgetType = 'campaign';
        if (/\b(?:abo|ad\s*set\s+budgets?|ad\s*set\s+level)\b/i.test(v) && !f.budgetType) f.budgetType = 'adset';
        // "Monthly $600 | Daily $19.74": the daily figure the doc worked out wins
        if (f.budget && f.budget.basis === 'daily' && b.basis !== 'daily' && b.basis !== 'lifetime') return true;
        f.budget = b;
        return true;
      }
      case 'budgetType':
        if (/\babo\b|ad\s*set/i.test(v)) { f.budgetType = 'adset'; return true; }
        // "Advantage+ campaign budget: OFF" means ad set budgets
        if (/advantage|campaign\s+budget|\bcbo\b/i.test(srcLabel) && /^(?:off|no|disabled?|not\s+used|none)\b/i.test(v)) { f.budgetType = 'adset'; return true; }
        if (/advantage|campaign\s+budget|\bcbo\b/i.test(srcLabel) && /^(?:on|yes|enabled?|used)\b/i.test(v)) { f.budgetType = 'campaign'; return true; }
        if (/\bcbo\b|campaign|advantage/i.test(v)) { f.budgetType = 'campaign'; return true; }
        return false;
      case 'specialCategory': { const s = parseSpecial(v); if (!s) return false; f.specialCategory = s; return true; }
      case 'bidStrategy': { const b = parseBidStrategy(v); if (!b) return false; f.bidStrategy = b.strategy; if (b.amount) f.bidAmount = b.amount; return true; }
      case 'bidAmount': {
        const a = findAmount(v);
        // "Leave blank (highest volume bidding)": no cost goal
        if (!a && /leave\s+(?:it\s+)?(?:blank|empty)|highest\s+volume|lowest\s+cost|^(?:none|n\/?a|no|blank|not\s+set|no\s+cap|automatic)\b/i.test(v)) { f.bidStrategy = f.bidStrategy || 'LOWEST_COST_WITHOUT_CAP'; return true; }
        if (!a) return false;
        const lk = labelKey(src && src.label || '');
        f.bidStrategy = f.bidStrategy || (/bid\s+cap/.test(lk) ? 'LOWEST_COST_WITH_BID_CAP' : /roas/.test(lk) ? 'LOWEST_COST_WITH_MIN_ROAS' : 'COST_CAP');
        f.bidAmount = a.n;
        return true;
      }
      case 'startDate': { const d = parseDate(v); if (!d) return false; f.startDate = d; return true; }
      case 'endDate': { const d = parseDate(v); if (!d) return false; f.endDate = d; return true; }
      case 'schedule': {
        const s = parseSchedule(v);
        if (!s || (!s.start && !s.end)) return false;
        if (s.start) f.startDate = s.start;
        if (s.end) f.endDate = s.end;
        return true;
      }
      case 'conversionLocation': { const c = parseConversionLocation(v); if (!c) return false; f.conversionLocation = c; setLocationDetail(f, v); return true; }
      case 'engagementType': { const e = parseEngagementType(v); if (!e) return false; f.engagementType = e; f.conversionLocation = f.conversionLocation || 'on_ad'; return true; }
      case 'messageApps': { const a = parseMessageApps(v); if (!a.length) return false; f.messageApps = a; f.conversionLocation = f.conversionLocation || 'messages'; return true; }
      case 'phone': { const m = v.match(/\+?\d[\d\s().-]{6,}\d/); if (!m) return false; f.phone = m[0].replace(/[^\d+]/g, ''); return true; }
      case 'appId': { const m = v.match(/\d{6,20}/); if (!m) return false; f.appId = m[0]; return true; }
      case 'appStore': { const u = findUrl(v); if (!u) return false; f.appStoreUrl = u; return true; }
      case 'event': {
        const e = parseEvent(v);
        const loc = parseConversionLocation(v);
        if (loc) f.conversionLocation = f.conversionLocation || loc;
        if (!e) return !!loc;
        f.event = e;
        return true;
      }
      case 'optimization': {
        const g = parseGoal(v);
        const e = parseEvent(v);
        const loc = parseConversionLocation(v) || GOAL_LOCATION[g] || null;
        if (loc) { f.conversionLocation = f.conversionLocation || loc; setLocationDetail(f, v); }
        if (g) f.optimization = g;
        if (e && (g === 'OFFSITE_CONVERSIONS' || !g)) f.event = f.event || e;
        return !!(g || e || loc);
      }
      case 'pixel': { const m = v.match(/\d{6,20}/); if (!m) return false; f.pixel = m[0]; return true; }
      case 'page': {
        const m = v.match(/\d{6,20}/);
        if (m) { f.page = m[0]; return true; }
        if (v && v.length < 80) { f.pageName = v; return true; }
        return false;
      }
      case 'leadForm': { const m = v.match(/\d{6,20}/); if (!m) return false; f.leadForm = m[0]; return true; }
      case 'age': { const a = parseAge(v); if (!a) return false; f.ageMin = a.min; f.ageMax = a.max; const g = parseGender(v); if (g && g !== 'all') f.gender = g; return true; }
      case 'gender': { const g = parseGender(v); if (!g) return false; f.gender = g; return true; }
      case 'locations': {
        const r = parseLocations(v);
        r.list.forEach(x => { if (!l.locations.some(o => locLabel(o) === locLabel(x))) l.locations.push(x); });
        r.notes.forEach(n => res.notes.push({ msg: n, level: 'warn' }));
        return r.list.length > 0;
      }
      case 'interests': {
        const items = splitList(v);
        items.forEach(x => { if (!l.interests.some(o => key(o) === key(x))) l.interests.push(x); });
        return items.length > 0;
      }
      case 'audiences': case 'exclusions': {
        const lk = labelKey(src && src.label || '');
        // "People who like or follow your Page, if the goal is new people": one audience, without the condition
        const cv = v.replace(/,?\s+\b(?:if|when|unless|so\s+that)\b\s.*$/i, '').trim();
        const parts = /\b(?:who|that|which|people|users|anyone|everyone)\b/i.test(cv) ? cv.split(/\s*[;\n]\s*/).map(x => norm(x).replace(/[.;:]+$/, '')).filter(Boolean) : splitList(cv);
        const optional = /\boptional\b/i.test(srcLabel) ? ' (optional)' : '';
        const items = parts.map(x => (field === 'audiences' && /look\s?alike|\blal\b|\blla\b/.test(lk) && !/look\s?alike|\blal\b|\blla\b|%/i.test(x)) ? 'Lookalike: ' + x : x).map(x => x + optional);
        items.forEach(x => { if (!l[field].some(o => key(o) === key(x))) l[field].push(x); });
        return items.length > 0;
      }
      case 'audience': {
        const a = parseAudience(v);
        if (a.age) { f.ageMin = f.ageMin || a.age.min; f.ageMax = f.ageMax || a.age.max; }
        if (a.gender) f.gender = f.gender || a.gender;
        a.interests.forEach(x => { if (!l.interests.some(o => key(o) === key(x))) l.interests.push(x); });
        a.audiences.forEach(x => { if (!l.audiences.some(o => key(o) === key(x))) l.audiences.push(x); });
        a.locations.forEach(x => { if (!l.locations.some(o => locLabel(o) === locLabel(x))) l.locations.push(x); });
        if (!l.notes.includes(v)) l.notes.push(v);
        // the text itself is kept on the ad set, so the line always counts as read
        return true;
      }
      case 'placements': {
        // "Advantage+ placements: OFF" says manual; the platforms come from elsewhere
        if (/advantage/i.test(srcLabel) && /^(?:off|no|disabled?|manual)\b/i.test(v)) return true;
        if (/advantage/i.test(srcLabel) && /^(?:on|yes|enabled?)\b/i.test(v)) { f.placements = { mode: 'advantage' }; return true; }
        const p = parsePlacements(v); if (!p) return false; f.placements = mergePlacements(f.placements && f.placements.mode === 'manual' && p.mode === 'manual' ? f.placements : null, p); return true; }
      case 'languages': f.languages = v; return true;
      case 'devices': f.devices = v; return true;
      case 'primary': case 'headline': case 'description': {
        const t = cleanCopy(value);
        if (!t || isCopyNoteLine(t)) return false;
        l[field].push(t);
        return true;
      }
      case 'cta': { const c = parseCta(v); if (!c) return false; f.cta = c; return true; }
      case 'url': {
        const u = findUrl(v);
        if (!u) return false;
        f.url = u;
        return true;
      }
      case 'displayLink': f.displayLink = v.replace(/^https?:\/\//i, ''); return !!v;
      case 'urlTags': {
        const q = v.replace(/^.*?\?/, '').replace(/^[?&]/, '');
        // "Tracking: Website events and app events OFF" is a setting, not URL parameters
        if (!/=/.test(q) && /^tracking$/i.test(labelKey(srcLabel)) && v) return putField(res, node, 'setting', v, src);
        if (!/=/.test(q)) return false;
        f.urlTags = q.replace(/\s+/g, '');
        return true;
      }
      case 'format': { const fm = parseFormat(v); if (!fm) return false; f.format = fm; return true; }
      case 'media': {
        const fm = parseFormat(v);
        if (fm && !f.format) f.format = fm;
        const hash = v.match(/\b[a-f0-9]{32}\b/i);
        if (hash) f.imageHash = hash[0];
        const vid = v.match(/\bv:(\d{6,20})\b|\bvideo\s+id\s*:?\s*(\d{6,20})\b/i);
        if (vid) f.videoId = vid[1] || vid[2];
        if (EXISTING_POST.test(v)) f.existingPost = true;
        f.media = f.media ? f.media + '\n' + v : v;
        return true;
      }
      case 'campaignName': case 'adSetName': case 'adName':
        node.name = cleanName(v) || node.name;
        return !!v;
      case 'postId': {
        const id = postIdOf(v);
        if (!id) return false;
        f.postId = id;
        f.existingPost = true;
        return true;
      }
      case 'setting': {
        const lk = labelKey(srcLabel);
        if (!v) return false;
        if (EXISTING_POST.test(v)) {
          f.existingPost = true;
          if (/^ad\s+(?:setup|creation|source)$/.test(lk)) return true;
        }
        // already in the import file
        if (/^buying\s+type$/.test(lk) && /auction/i.test(v)) return true;
        l.settings = l.settings || [];
        const label = srcLabel.replace(/:\s*$/, '') || 'Setting';
        if (!l.settings.some(x => key(x.label) === key(label))) l.settings.push({ label, value: v });
        return true;
      }
      default:
        return false;
    }
  }

  // Classify a table by its header row
  function colField(cell) {
    const k = labelKey(cell);
    if (!k) return null;
    if (/^(?:campaigns?|campaign\s+names?|campaign\s+type)$/.test(k)) return 'campaignName';
    if (/^(?:ad\s*sets?|adsets?|ad\s*set\s+names?|audiences?|audience\s+names?|audience\s+segments?|segments?|ad\s*sets?\s+audiences?)$/.test(k)) return 'adSetName';
    if (/^(?:ads?|ad\s+names?|creatives?|creative\s+names?|variations?|versions?|concepts?|ad\s+variations?|ad\s+concepts?|ad\s+#)$/.test(k)) return 'adName';
    if (/^(?:platforms?|channels?|networks?)$/.test(k)) return 'platform';
    if (/^(?:chars?|characters?|char\s+count|character\s+count|length|count|no|number|ch)$/.test(k) || /^#$/.test(norm(cell))) return 'count';
    if (/^(?:attributes?|settings?|parameters?|fields?|items?|elements?|components?|labels?)$/.test(k)) return 'label';
    if (/^(?:values?|details?|specifications?|specs?|setup|configuration)$/.test(k)) return 'value';
    return fieldOf(cell);
  }

  function parseBlocks(blocks, opts) {
    opts = opts || {};
    const mem = opts.memory || {};
    const res = newResult();
    const notes = res.notes;
    const skip = (text, reason, kind, at) => { if (norm(text)) res.skipped.push({ text: normBlock(text), reason, kind: kind || 'line', at: at || null }); };

    /* platform regions */
    const isPlatformHead = b => b.t === 'h' || (b.t === 'p' && (b.bold || isCaps(b.text)) && norm(b.text).split(' ').length <= 8 && !/:\s*\S/.test(b.text));
    const plats = blocks.map(b => isPlatformHead(b) ? platformOf(b.text) : null);
    const multi = plats.includes('meta') && plats.some(p => p && p !== 'meta' && p !== 'mixed') || (!plats.includes('meta') && plats.some(p => p && p !== 'meta' && p !== 'mixed'));
    const region = new Array(blocks.length).fill('neutral');
    if (multi) {
      const st = [];
      blocks.forEach((b, i) => {
        const lv = b.t === 'h' ? b.level : (plats[i] ? 7 : null);
        if (lv != null) while (st.length && st[st.length - 1].level >= lv) st.pop();
        if (plats[i] && plats[i] !== 'mixed') {
          const wasSkip = st.length && st[st.length - 1].region === 'skip';
          st.push({ level: lv, region: plats[i] === 'meta' ? 'meta' : 'skip' });
          if (plats[i] !== 'meta' && !wasSkip) {
            notes.push({ msg: 'Skipped the "' + norm(b.text) + '" section (' + plats[i] + '). Only Meta sections are read.', level: 'info' });
            skip(b.text, plats[i] + ' section, not Meta', 'platform');
          }
        }
        region[i] = st.length ? st[st.length - 1].region : 'neutral';
      });
    }

    /* title */
    const firstText = blocks.find((b, i) => region[i] !== 'skip' && (b.t === 'h' || (b.t === 'p' && b.bold)));
    if (firstText) res.title = stripOutline(firstText.text);

    /* look-ahead: what a heading's section holds */
    const sectionEnd = (i, level) => {
      let j = i + 1;
      while (j < blocks.length && !(blocks[j].t === 'h' && blocks[j].level <= level)) j++;
      return j;
    };
    const labelOfLine = t => {
      const m = /^([^:]{1,60}):\s*(.*)$/.exec(norm(t));
      return m ? { label: m[1], value: m[2] } : null;
    };
    function info(i, level) {
      const end = sectionEnd(i, level);
      const o = { targeting: false, copy: false, adSetHeads: false, adHeads: false, campaignHeads: false, childTargeting: false };
      for (let j = i + 1; j < end; j++) {
        const b = blocks[j];
        if (region[j] === 'skip') continue;
        const txt = stripOutline(b.text || '');
        if (b.t === 'h' || b.t === 'p') {
          if (CAMP_RX.test(txt) || CAMP_ONLY.test(txt)) o.campaignHeads = true;
          if (ADSET_RX.test(txt) || ADSET_AUD_RX.test(txt) || ADSET_ONLY.test(txt)) o.adSetHeads = true;
          if ((b.t === 'h' || b.bold) && (AD_RX.test(txt) || AD_ONLY.test(txt))) o.adHeads = true;
          const lab = labelOfLine(txt);
          const fld = fieldOf(lab ? lab.label : txt);
          if (fld && TARGETING_FIELDS.has(fld)) { o.targeting = true; if (b.t === 'h' && j > i + 1) o.childTargeting = true; }
          if (fld && COPY_FIELDS.has(fld)) o.copy = true;
          if (NUMBERED.test(txt)) o.copy = true;
          if (b.t === 'h' && !fld && !SKIP_SECTION.test(labelKey(txt))) {
            const sub = info(j, b.level);
            if (sub.targeting) o.childTargeting = true;
          }
        } else if (b.t === 'li') {
          const lab = labelOfLine(b.text);
          const fld = lab && fieldOf(lab.label);
          if (fld && TARGETING_FIELDS.has(fld)) o.targeting = true;
          if (fld && COPY_FIELDS.has(fld)) o.copy = true;
        } else if (b.t === 'table') {
          const fields = (b.rows[0] || []).map(colField);
          const col0 = b.rows.map(r => fieldOf(r[0] || ''));
          if (fields.some(f => TARGETING_FIELDS.has(f)) || col0.some(f => TARGETING_FIELDS.has(f))) o.targeting = true;
          if (fields.some(f => COPY_FIELDS.has(f)) || col0.some(f => COPY_FIELDS.has(f))) o.copy = true;
          if (fields.includes('adSetName')) o.adSetHeads = true;
        }
      }
      return o;
    }

    /* the walk */
    const stack = []; // {level, kind: campaign|adset|ad|role|skip|container, node, role, synthetic, name, lines}
    let pending = null; // role from a label line: {field, plural, items, lastWasP}
    const cur = kind => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].node && stack[i].node.kind === kind) return stack[i].node; return null; };
    const roleEntry = () => { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].kind === 'role' || stack[i].kind === 'skip') return stack[i]; if (stack[i].kind !== 'container') return null; } return null; };
    const popTo = (level, keepSynthetic) => {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.level < level) break;
        if (keepSynthetic && top.synthetic) break;
        stack.pop();
      }
    };
    const nodeFor = field => {
      if (ACCOUNT_FIELDS.has(field)) return res.account;
      if (CAMPAIGN_FIELDS.has(field)) return cur('campaign') || res.account;
      if (ADSET_FIELDS.has(field)) return cur('adset') || cur('campaign') || res.account;
      return cur('ad') || cur('adset') || cur('campaign') || res.account;
    };

    function openCampaign(name, level, synthetic) {
      popTo(level, false);
      let nm = cleanName(name);
      // "Campaign 2" with no name: take the second campaign of a campaign table
      const only = CAMP_ONLY.exec(nm);
      if (only) {
        const n = parseInt(only[1].replace(/\D/g, ''), 10);
        const fromTable = res.campaigns.filter(c => c.placeholder);
        if (n && fromTable[n - 1]) nm = fromTable[n - 1].name;
      }
      const c = addCampaign(res, nm);
      dropAnchors(c);
      stack.push({ level, kind: 'campaign', node: c, synthetic });
      pending = null;
      return c;
    }
    // A structure table with one campaign and one ad set anchors them under every later section.
    // Opening another campaign or ad set lifts the anchor.
    function dropAnchors(camp) {
      for (let k = stack.length - 1; k >= 0; k--) {
        const e = stack[k];
        if (!e.anchor) continue;
        if (camp === undefined ? e.kind === 'adset' : !(e.kind === 'adset' && e.node.parent === camp)) stack.splice(k, 1);
      }
    }
    function openAdSet(name, level, synthetic) {
      popTo(level, false);
      let camp = cur('campaign');
      let nm = cleanName(name);
      const only = ADSET_ONLY.exec(nm);
      if (only && camp) {
        const n = parseInt(only[1].replace(/\D/g, ''), 10);
        const ph = res.adSets.filter(a => a.parent === camp && a.placeholder);
        if (n && ph[n - 1]) nm = ph[n - 1].name;
      }
      const a = addAdSet(res, camp, nm);
      dropAnchors();
      stack.push({ level, kind: 'adset', node: a, synthetic });
      pending = null;
      return a;
    }
    function openAd(name, level, synthetic) {
      popTo(level, false);
      let as = cur('adset');
      if (!as) {
        const camp = cur('campaign');
        as = res.adSets.filter(a => a.parent === camp).slice(-1)[0] || addAdSet(res, camp, camp ? camp.name + ' - Ad set' : 'Ad set 1');
        stack.push({ level: level - 0.5, kind: 'adset', node: as, synthetic: true });
      }
      const nm = cleanName(name);
      // "Ad 2" after a structure table that named the ads: the second named ad
      const only = AD_ONLY.exec(nm);
      const named = res.ads.filter(a => a.parent === as && a.fromTable);
      let ad = null;
      if (only) { const n = parseInt(only[1].replace(/\D/g, ''), 10); if (n && named[n - 1] && named[n - 1].placeholder) ad = named[n - 1]; }
      else ad = named.find(a => a.placeholder && (key(a.name) === key(nm) || sim(a.name, nm) >= 0.75)) || null;
      if (ad) ad.placeholder = false;
      else { ad = addAd(res, as, only ? '' : nm); if (!ad.name) ad.name = nm; }
      stack.push({ level, kind: 'ad', node: ad, synthetic });
      pending = null;
      return ad;
    }

    // Structural name from a line: { kind, name } or null
    function structural(text, isHeading) {
      const t = stripOutline(text).replace(/\*\*|__/g, '').replace(/:\s*$/, '');
      const taught = mem[labelKey(t)];
      if (taught === 'campaign' || taught === 'adset' || taught === 'ad') return { kind: taught, name: t };
      let m;
      if ((m = CAMP_RX.exec(t)) && !fieldOf(t.split(':')[0])) return { kind: 'campaign', name: m[1] };
      if (CAMP_ONLY.test(t)) return { kind: 'campaign', name: t };
      if ((m = ADSET_RX.exec(t))) return { kind: 'adset', name: m[1] };
      if ((m = ADSET_AUD_RX.exec(t))) return { kind: 'adset', name: m[1] };
      if (ADSET_ONLY.test(t)) return { kind: 'adset', name: t };
      if ((m = AD_RX.exec(t)) && (isHeading || isNameLike(m[1]) || !m[1])) return { kind: 'ad', name: m[1] || t.replace(/\s*[:.\-–—]\s*$/, '') };
      if (AD_ONLY.test(t)) return { kind: 'ad', name: t };
      return null;
    }

    function addRoleItem(field, text, b, roleState) {
      const node = nodeFor(field);
      let t = normBlock(text);
      // "Option 2: ...", "Primary Text 2: ..." start a new item
      const opt = OPTION.exec(norm(t));
      if (opt) { t = opt[1]; if (roleState) roleState.lastWasP = false; }
      if (!norm(t)) return true;
      if (field === 'primary') {
        const list = node.l.primary;
        const startsEmoji = /^(?:[\p{Extended_Pictographic}✅✔✓•➡⭐]|\p{Regional_Indicator})/u.test(norm(t));
        // a multi-line primary text: plain paragraphs under a singular label run on, and emoji lines continue it
        if (roleState && list.length && !opt && ((b && b.t === 'p' && roleState.lastWasP && !roleState.plural) || (startsEmoji && textLen(t) < 90 && roleState.started))) {
          list[list.length - 1] = list[list.length - 1] + '\n' + cleanCopy(t);
          roleState.lastWasP = b && b.t === 'p';
          return true;
        }
        const ok = putField(res, node, 'primary', t);
        if (roleState) { roleState.lastWasP = b && b.t === 'p'; roleState.started = true; }
        return ok;
      }
      if (field === 'headline' || field === 'description') return putField(res, node, field, t);
      return putField(res, node, field, t, { label: roleState && roleState.label });
    }

    // A "Label: value" line, a bold label, or a numbered copy line. Returns true when handled.
    function handleLabelLine(text, b) {
      const t = norm(text);
      const num = NUMBERED.exec(t);
      if (num) {
        const w = num[1].toLowerCase();
        const field = /^(?:primary|body|text|pt)/.test(w) ? 'primary' : /^(?:headline|title|h)$|^(?:headline|title)/.test(w) ? 'headline' : 'description';
        pending = { field, plural: true, label: num[1], started: true };
        return putField(res, nodeFor(field), field, num[3]) || true;
      }
      const lab = labelOfLine(t);
      if (lab) {
        const taught = mem[labelKey(lab.label)];
        const fld = (taught && !['campaign', 'adset', 'ad', 'ignore', 'other'].includes(taught) ? taught : null) || fieldOf(lab.label);
        if (taught === 'ignore') return true;
        if (fld) {
          if (fld === 'keywords') { skip(t, 'Keywords are for Google Search. Meta does not use them.', 'google'); pending = { field: 'keywords' }; return true; }
          if (!lab.value) { pending = { field: fld, plural: /s$|options?|variations?|versions?/i.test(lab.label.trim()), label: lab.label }; return true; }
          if (fld === 'adSetName' && cur('campaign') && !(cur('adset') && !cur('adset').name)) { openAdSet(lab.value, (stack.length ? stack[stack.length - 1].level : 0) + 0.1, true); return true; }
          if (fld === 'campaignName' && !cur('campaign')) { openCampaign(lab.value, 9, true); return true; }
          if (fld === 'adName' && !cur('ad')) { openAd(lab.value, (stack.length ? stack[stack.length - 1].level : 0) + 0.1, true); return true; }
          const node = fld === 'campaignName' ? (cur('campaign') || res.account) : fld === 'adSetName' ? (cur('adset') || res.account) : fld === 'adName' ? (cur('ad') || res.account) : nodeFor(fld);
          pending = LIST_FIELDS.has(fld) && fld !== 'audience' && fld !== 'locations' && fld !== 'placements' ? { field: fld, plural: true, label: lab.label, started: true, lastWasP: false, inline: true } : null;
          let ok;
          if (fld === 'headline' && / \| /.test(lab.value)) ok = lab.value.split(/\s+\|\s+/).map(x => putField(res, node, fld, x)).some(Boolean);
          else ok = putField(res, node, fld, lab.value, { label: lab.label });
          if (!ok) {
            const reason = fld === 'url' ? 'Landing page described in words, not a URL. Add the URL to the ad.' : 'Could not read the ' + labelKey(lab.label) + ' value.';
            skip(t, reason, fld === 'url' ? 'lp' : 'value', nodeRef());
          }
          return true;
        }
      }
      // a bold label with no colon: "Primary Text", "Headlines (40 characters)"
      const lone = t.replace(/:$/, '');
      const fld = (mem[labelKey(lone)] && !['campaign', 'adset', 'ad', 'ignore', 'other'].includes(mem[labelKey(lone)]) ? mem[labelKey(lone)] : null) || fieldOf(lone);
      if (fld && (b.bold || /:$/.test(t) || b.t === 'p' && lone.split(' ').length <= 5)) {
        if (fld === 'keywords') { skip(t, 'Keywords are for Google Search. Meta does not use them.', 'google'); pending = { field: 'keywords' }; return true; }
        pending = { field: fld, plural: /s$|options?|variations?|versions?/i.test(lone.replace(/\s*\([^)]*\)\s*$/, '').trim()), label: lone };
        return true;
      }
      if (mem[labelKey(lone)] === 'other' || ((b.bold || /:$/.test(t)) && SKIP_SECTION.test(labelKey(lone)))) { pending = { field: 'skip', label: lone, lines: 0 }; return true; }
      if (mem[labelKey(lone)] === 'ignore') return true;
      return false;
    }
    const nodeRef = () => { const a = cur('adset'); const c = cur('campaign'); return a ? { adSet: a } : c ? { campaign: c } : null; };

    function handleTable(rows, b) {
      if (!rows.length) return;
      const head = rows[0].map(colField);
      // "Ad Set | Audience | ...": a second name column describes the audience
      head.forEach((f, i) => { if (i > head.indexOf(f) && f === 'adSetName') head[i] = 'audience'; else if (i > head.indexOf(f) && (f === 'campaignName' || f === 'adName')) head[i] = null; });
      const body = rows.slice(1);
      const has = f => head.includes(f);
      const idx = f => head.indexOf(f);
      const copyCols = head.filter(f => COPY_FIELDS.has(f)).length;
      const platCol = idx('platform');
      const rowsKept = platCol >= 0 ? body.filter(r => !r[platCol] || META_WORDS.test(r[platCol]) || platformOf(r[platCol]) === 'meta' || platformOf(r[platCol]) === 'mixed') : body;
      if (platCol >= 0 && rowsKept.length < body.length) notes.push({ msg: 'Left out ' + (body.length - rowsKept.length) + ' table row(s) for other platforms.', level: 'info' });

      if (structureTable(rows, head)) return;
      // campaign table: Campaign | Objective | Budget | Ad Sets
      if (has('campaignName') && !copyCols && head.filter(f => f && f !== 'campaignName').length >= 1 && !has('adName')) {
        const asCol = idx('adSetName');
        const targetingCols = head.filter(f => TARGETING_FIELDS.has(f)).length;
        // one row per ad set with a campaign column: an ad set table
        if (asCol >= 0 && (targetingCols || rowsKept.every(r => !/[,;\n]/.test(r[asCol] || '')))) return adSetTable(rows, rowsKept, head);
        rowsKept.forEach(r => {
          const name = cleanName(r[idx('campaignName')] || '');
          if (!name) return;
          const c = addCampaign(res, name, { placeholder: true });
          const dailyCol = rows[0].findIndex((h, i) => head[i] === 'budget' && /daily|per\s+day/i.test(h));
          head.forEach((f, ci) => {
            const cell = r[ci];
            if (!cell || !f || f === 'campaignName' || f === 'count' || f === 'platform') return;
            if (f === 'adSetName') {
              splitAdSetNames(cell).forEach(n => addAdSet(res, c, n, { placeholder: true }));
              return;
            }
            if (f === 'budget' && dailyCol >= 0 && ci !== dailyCol && r[dailyCol]) return;
            putField(res, c, f, cell, { label: rows[0][ci] });
          });
        });
        return;
      }
      if (has('adSetName') && !copyCols && !has('adName')) return adSetTable(rows, rowsKept, head);
      // ad table: rows are ads
      if (copyCols >= 2 || (copyCols >= 1 && (has('adName') || has('cta') || has('url') || has('format') || has('adSetName')))) {
        rowsKept.forEach((r, ri) => {
          let as = cur('adset');
          if (has('campaignName') && r[idx('campaignName')]) {
            const c = addCampaign(res, r[idx('campaignName')]);
            as = null;
            if (!has('adSetName')) as = res.adSets.filter(a => a.parent === c)[0] || addAdSet(res, c, c.name + ' - Ad set');
            if (has('adSetName') && r[idx('adSetName')]) as = addAdSet(res, c, r[idx('adSetName')]);
          } else if (has('adSetName') && r[idx('adSetName')]) {
            as = addAdSet(res, cur('campaign'), r[idx('adSetName')]);
          }
          if (!as) as = addAdSet(res, cur('campaign'), cur('campaign') ? cur('campaign').name + ' - Ad set' : 'Ad set 1');
          const name = has('adName') ? cleanName(r[idx('adName')]) : '';
          const ad = addAd(res, as, name);
          head.forEach((f, ci) => {
            const cell = r[ci];
            if (!cell || !f || ['adName', 'adSetName', 'campaignName', 'count', 'platform', 'label', 'value'].includes(f)) return;
            if (COPY_FIELDS.has(f)) { putField(res, ad, f, cell); return; }
            if (ADSET_FIELDS.has(f) || CAMPAIGN_FIELDS.has(f)) { putField(res, f === 'objective' ? (as.parent || res.account) : as, f, cell, { label: rows[0][ci] }); return; }
            putField(res, ad, f, cell, { label: rows[0][ci] });
          });
          if (!ad.name) ad.name = 'Ad ' + (res.ads.filter(a => a.parent === as).length);
        });
        return;
      }
      // Ad | Post type | What to look for: details for ads the doc named earlier
      if (idx('adName') === 0 && !copyCols && !has('campaignName') && !has('adSetName') && head.some((f, i) => i > 0 && rows[0][i])) {
        let as = cur('adset') || res.adSets.filter(a => a.parent === cur('campaign')).slice(-1)[0] || null;
        rowsKept.forEach(r => {
          const ref = norm(r[0] || '');
          if (!ref) return;
          if (!as) as = addAdSet(res, cur('campaign'), cur('campaign') ? cur('campaign').name + ' - Ad set' : 'Ad set 1');
          const mine = res.ads.filter(a => a.parent === as);
          const only = AD_ONLY.exec(ref);
          let ad = null;
          if (only) { const n = parseInt(only[1].replace(/\D/g, ''), 10); if (n) ad = mine[n - 1] || null; }
          if (!ad) ad = mine.find(a => key(a.name) === key(ref) || sim(a.name, ref) >= 0.75) || null;
          if (!ad) { ad = addAd(res, as, only ? '' : ref); if (!ad.name) ad.name = cleanName(ref); }
          const extra = [];
          head.forEach((f, ci) => {
            const cell = r[ci];
            if (!cell || ci === 0) return;
            if (f && !['count', 'label', 'value', 'platform', 'adName'].includes(f) && putField(res, ADSET_FIELDS.has(f) || CAMPAIGN_FIELDS.has(f) ? as : ad, f, cell, { label: rows[0][ci] })) return;
            extra.push(cell);
          });
          const fm = parseFormat(extra.join(' '));
          if (fm && !ad.f.format) ad.f.format = fm;
          if (EXISTING_POST.test(extra.join(' '))) ad.f.existingPost = true;
          extra.forEach(x => { if (!ad.l.notes.includes(x)) ad.l.notes.push(x); });
        });
        return;
      }
      // one copy column (+ a character count): a list for the current ad set
      if (copyCols === 1 && head.filter(f => f && f !== 'count').length === 1) {
        const f = head.find(x => COPY_FIELDS.has(x));
        const ci = idx(f);
        const node = nodeFor(f);
        body.forEach(r => { if (r[ci]) putField(res, node, f, r[ci]); });
        return;
      }
      // a list with the role written in the header: | Interests | or | Primary Text |
      if (rows[0].filter(Boolean).length === 1 && head[0] && body.every(r => r.filter(Boolean).length <= 1)) {
        const f = head[0];
        body.forEach(r => { if (r[0]) putField(res, nodeFor(f), f, r[0], { label: rows[0][0] }); });
        return;
      }
      // key / value table, also "Attribute | Meta | Google" and "Element | Ad 1 | Ad 2"
      const col0 = rows.map(r => IGNORE_LABEL.test(labelKey(r[0] || '')) ? 'ignore' : fieldOf(r[0] || ''));
      const known = col0.filter(Boolean).length;
      if (known >= Math.max(1, Math.ceil(rows.length * 0.4)) && rows[0].length >= 2) {
        const metaCol = rows[0].findIndex((h, i) => i > 0 && META_WORDS.test(h));
        const adCols = rows[0].map((h, i) => (i > 0 && (AD_ONLY.test(norm(h)) || AD_RX.test(norm(h)) || /^(?:variation|version|option)\s*\w?$/i.test(norm(h)))) ? i : -1).filter(i => i > 0);
        if (adCols.length >= 1 && col0.some(f => COPY_FIELDS.has(f))) {
          let as = cur('adset') || addAdSet(res, cur('campaign'), cur('campaign') ? cur('campaign').name + ' - Ad set' : 'Ad set 1');
          adCols.forEach(ci => {
            const ad = addAd(res, as, norm(rows[0][ci]));
            rows.forEach((r, ri) => { const f = col0[ri]; if (f && r[ci]) putField(res, COPY_FIELDS.has(f) || !ADSET_FIELDS.has(f) ? ad : as, f, r[ci], { label: r[0] }); });
          });
          return;
        }
        const vc = metaCol > 0 ? metaCol : 1;
        rows.forEach((r, ri) => {
          const f = col0[ri];
          if (ri === 0 && !f) return;
          if (f === 'ignore') return;
          // a row the settings table holds that is not an Ads Manager setting: commentary
          if (!f) { if (r.some(Boolean)) skip(r.filter(Boolean).join(' | '), 'Row not used (not a setting this tool reads)', 'note', nodeRef()); return; }
          if (!r[vc]) return;
          if (f === 'keywords') { skip(r.join(' | '), 'Keywords are for Google Search. Meta does not use them.', 'google'); return; }
          const node = f === 'campaignName' ? (cur('campaign') || res.account) : f === 'adSetName' ? (cur('adset') || res.account) : f === 'adName' ? (cur('ad') || res.account) : nodeFor(f);
          if (LIST_FIELDS.has(f) && f !== 'audience' && /\n/.test(r[vc]) && !COPY_FIELDS.has(f)) r[vc].split('\n').forEach(x => putField(res, node, f, x, { label: r[0] }));
          else if (COPY_FIELDS.has(f) && /\n/.test(r[vc]) && f !== 'primary') r[vc].split('\n').forEach(x => putField(res, node, f, x));
          else if (!putField(res, node, f, r[vc], { label: r[0] })) skip(r[0] + ': ' + r[vc], f === 'url' ? 'Landing page described in words, not a URL. Add the URL to the ad.' : 'Could not read this value', f === 'url' ? 'lp' : 'value', nodeRef());
        });
        return;
      }
      skip(rows.slice(0, 3).map(r => r.filter(Boolean).join(' | ')).join('\n') + (rows.length > 3 ? '\n…' : ''), 'Table not recognized (' + rows.length + ' rows)', 'table', nodeRef());
    }

    // "Campaign", "Ad set", "Ad 2" in a Level column
    const levelOf = cell => {
      const m = /^(campaign|ad\s*set|adset|ad|creative)\s*#?\s*(?:\d{1,3}|[a-z])?$/i.exec(norm(cell).replace(/[:.]\s*$/, ''));
      if (!m) return null;
      return /^campaign/i.test(m[1]) ? 'campaign' : /set/i.test(m[1]) ? 'adset' : 'ad';
    };
    // Level | Name | Purpose: the campaign, ad set and ads written out as a table
    function structureTable(rows, head) {
      const body = rows.slice(1);
      if (body.length < 2) return false;
      const width = Math.max.apply(null, rows.map(r => r.length));
      let lc = -1;
      for (let ci = 0; ci < Math.min(width, 3); ci++) {
        const lv = body.map(r => levelOf(r[ci] || ''));
        const n = lv.filter(Boolean).length;
        if (n >= 2 && n >= body.length * 0.6 && lv.some(x => x === 'campaign' || x === 'adset')) { lc = ci; break; }
      }
      if (lc < 0) return false;
      let nc = rows[0].findIndex((h, i) => i !== lc && /\bname\b/.test(labelKey(h)));
      if (nc < 0) nc = lc + 1 < width ? lc + 1 : -1;
      if (nc < 0) return false;
      const counts = { campaign: 0, adset: 0 };
      body.forEach(r => { const k = levelOf(r[lc] || ''); if (k && k !== 'ad' && norm(r[nc])) counts[k]++; });
      let camp = cur('campaign'), as = cur('adset');
      body.forEach(r => {
        const kind = levelOf(r[lc] || '');
        const name = cleanName(r[nc] || '');
        if (!kind) { if (r.some(Boolean)) skip(r.filter(Boolean).join(' | '), 'Table row not recognized', 'table', nodeRef()); return; }
        if (!name) return;
        let node;
        if (kind === 'campaign') { camp = addCampaign(res, name); as = null; node = camp; }
        else if (kind === 'adset') { as = addAdSet(res, camp, name); node = as; }
        else {
          if (!as) as = res.adSets.filter(a => a.parent === camp).slice(-1)[0] || addAdSet(res, camp, camp ? camp.name + ' - Ad set' : 'Ad set 1');
          node = addAd(res, as, name);
          node.placeholder = true;
          node.fromTable = true;
        }
        const extra = [];
        rows[0].forEach((h, ci) => {
          const f = head[ci];
          if (ci === lc || ci === nc || !r[ci]) return;
          if (f && !['campaignName', 'adSetName', 'adName', 'count', 'label', 'value', 'platform'].includes(f) && putField(res, node, f, r[ci], { label: h })) return;
          extra.push(r[ci]);
        });
        if (kind === 'ad') {
          const all = name + ' ' + extra.join(' ');
          const fm = parseFormat(name.replace(/[_-]+/g, ' ')) || parseFormat(extra.join(' '));
          if (fm && !node.f.format) node.f.format = fm;
          if (EXISTING_POST.test(all)) node.f.existingPost = true;
          extra.forEach(x => node.l.notes.push(x));
        }
      });
      if (counts.adset === 1 && as) stack.unshift({ level: 0, kind: 'adset', node: as, synthetic: true, anchor: true });
      if (counts.campaign === 1 && camp) stack.unshift({ level: 0, kind: 'campaign', node: camp, synthetic: true, anchor: true });
      pending = null;
      return true;
    }

    // Placement | Keep/Remove: which platforms and positions stay on
    const toggleOf = cell => {
      const t = norm(cell).toLowerCase();
      if (/^(?:remove[ds]?|off|no|exclude[ds]?|un-?check(?:ed)?|untick(?:ed)?|de-?select(?:ed)?|drop(?:ped)?|don'?t\s+use|not\s+used|disabled?|✗|✘|❌)(?![a-z])/.test(t)) return 'off';
      if (/^(?:keep|kept|on|yes|include[ds]?|selected|checked|ticked|use|used|active|enabled?|✓|✔|✅)(?![a-z])/.test(t)) return 'on';
      return null;
    };
    function placementTable(rows) {
      const body = rows.slice(1);
      if (body.length < 2) return false;
      const width = Math.max.apply(null, rows.map(r => r.length));
      let tc = -1;
      for (let ci = 1; ci < width; ci++) {
        const n = body.filter(r => toggleOf(r[ci] || '')).length;
        if (n >= 2 && n >= body.length * 0.6) { tc = ci; break; }
      }
      if (tc < 0) return false;
      const parsed = body.map(r => parsePlacementText(norm(r[0] || '').toLowerCase()));
      if (parsed.filter(p => p && p.mode === 'manual').length < body.length * 0.5) return false;
      const node = nodeFor('placements');
      const acc = node.f.placementRows || (node.f.placementRows = { whole: {}, pos: {}, off: {} });
      const uniq = a => Array.from(new Set(a));
      body.forEach((r, i) => {
        const p = parsed[i], st = toggleOf(r[tc] || '');
        if (!p || p.mode !== 'manual' || !st) return;
        const whole = !wordsIn(norm(r[0]).toLowerCase()).length;
        p.platforms.forEach(pl => {
          if (st === 'on') { if (whole) acc.whole[pl] = true; else acc.pos[pl] = uniq((acc.pos[pl] || []).concat(p.positions[pl])); }
          else if (whole) acc.off[pl] = '*';
          else if (acc.off[pl] !== '*') acc.off[pl] = uniq((acc.off[pl] || []).concat(p.positions[pl]));
        });
      });
      // platforms kept whole, else what the doc already set, else all of them
      const prev = node.f.placements && node.f.placements.mode === 'manual' ? node.f.placements.platforms : null;
      const base = Object.keys(acc.whole).length || Object.keys(acc.pos).length ? Object.keys(acc.whole) : (prev || ['facebook', 'instagram', 'messenger', 'audience_network']);
      const out = { mode: 'manual', platforms: [], positions: {} };
      ['facebook', 'instagram', 'messenger', 'audience_network'].forEach(pl => {
        let list = null;
        if ((acc.pos[pl] || []).length) list = acc.pos[pl].slice();
        else if (base.includes(pl) && acc.off[pl] !== '*') list = POSITIONS[pl].map(x => x[0]).filter(x => !(acc.off[pl] || []).includes(x));
        if (!list || !list.length) return;
        out.platforms.push(pl);
        out.positions[pl] = list;
      });
      if (out.platforms.length) node.f.placements = out;
      pending = null;
      return true;
    }

    // "Engagement objective | $10/day | United States | Facebook placements only"
    function pipeSummary(t) {
      const pieces = t.split(/\s+\|\s+/).map(norm).filter(Boolean);
      if (pieces.length < 2) return false;
      const hits = [];
      pieces.forEach(x => {
        if (/objective|awareness|traffic|engagement|\bleads?\b|\bsales\b|app\s+promotion/i.test(x) && parseObjective(x)) hits.push(['objective', x]);
        else if (findAmount(x) && /[$€£₹]|\/\s*(?:day|d|mo|month|week)|per\s+(?:day|month|week)|daily|monthly|budget|lifetime/i.test(x)) hits.push(['budget', x]);
        else if (/placements?|\bonly\b|feeds?|reels|stories/i.test(x) && parsePlacements(x)) hits.push(['placements', x]);
        else if (parseLocations(x).list.length && !/\d/.test(x)) hits.push(['locations', x]);
      });
      if (hits.length < 2) return false;
      hits.forEach(([f, x]) => putField(res, nodeFor(f), f, x));
      return true;
    }
    // Advice written as prose: "Why one ad set: ...", "Select Manual placements. ..."
    const isNoteLine = t => /^(?:why|note|notes|nb|tip|tips|important|reason|remember|rationale)\b/i.test(t) || /:$/.test(t)
      || (t.split(' ').length >= 8 && !/[!?]|\byou(?:r|'re)?\b/i.test(t) && !/\p{Extended_Pictographic}/u.test(t)
        && /\b(?:must|should|need\s+to|needs\s+to|make\s+sure|deliberate|otherwise|so\s+that|because|select|uncheck|turn\s+(?:on|off)|meta\s+(?:will|can|may)|the\s+algorithm|learning\s+phase)\b/i.test(t));

    function splitAdSetNames(cell) {
      return String(cell).split(/\s*(?:\n|;|,(?![^(]*\)))\s*/).map(cleanName).filter(x => x && !/^(?:n\/?a|none|-|tbd)$/i.test(x));
    }

    function adSetTable(rows, rowsKept, head) {
      const idx = f => head.indexOf(f);
      rowsKept.forEach(r => {
        const name = cleanName(r[idx('adSetName')] || '');
        if (!name) return;
        let camp = cur('campaign');
        if (idx('campaignName') >= 0 && r[idx('campaignName')]) camp = addCampaign(res, r[idx('campaignName')]);
        const a = addAdSet(res, camp, name);
        head.forEach((f, ci) => {
          const cell = r[ci];
          if (!cell || !f || ['adSetName', 'campaignName', 'count', 'platform', 'label', 'value'].includes(f)) return;
          const node = CAMPAIGN_FIELDS.has(f) ? (camp || res.account) : a;
          if (!putField(res, node, f, cell, { label: rows[0][ci] })) skip(rows[0][ci] + ': ' + cell, 'Could not read this value', 'value', { adSet: a });
        });
      });
    }

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (region[i] === 'skip') {
        if (b.t === 'h') popTo(b.level, false);
        continue;
      }
      if (b.t === 'h') {
        const text = stripOutline(b.text);
        const lk = labelKey(text);
        const taught = mem[lk];
        pending = null;
        if (taught === 'ignore') continue;
        const st = structural(text, true);
        if (st) {
          popTo(b.level, false);
          if (st.kind === 'campaign') openCampaign(st.name, b.level, false);
          else if (st.kind === 'adset') openAdSet(st.name, b.level, false);
          else openAd(st.name, b.level, false);
          continue;
        }
        // where this heading sits once deeper sections close
        const above = stack.filter(e => e.level < b.level);
        const upCamp = (above.filter(e => e.node && e.node.kind === 'campaign').slice(-1)[0] || {}).node || null;
        const upSet = (above.filter(e => e.node && e.node.kind === 'adset').slice(-1)[0] || {}).node || null;
        const inf = info(i, b.level);
        const plat = platformOf(text);
        const lab = labelOfLine(text);
        // a name from a campaign table: "Core Interest: Implant Seekers" is the ad set "Implant Seekers"
        const tableAdSet = upCamp && !upSet ? findAdSet(res, upCamp, text) : (!upCamp ? res.adSets.find(a => a.placeholder && (sim(a.name, text) >= 0.75 || (lab && sim(a.name, lab.value) >= 0.75))) : null);
        const tableCampaign = !upCamp ? findCampaign(res, text) : null;
        if (tableAdSet && !taught) {
          popTo(b.level, false);
          if (!upCamp && tableAdSet.parent) stack.push({ level: b.level - 0.5, kind: 'campaign', node: tableAdSet.parent });
          openAdSet(tableAdSet.name, b.level, false);
          continue;
        }
        if (tableCampaign && !taught && (inf.adSetHeads || inf.childTargeting || !inf.targeting)) { openCampaign(tableCampaign.name, b.level, false); continue; }
        const fld = (taught && !['other', 'campaign', 'adset', 'ad'].includes(taught) ? taught : null) || fieldOf(lab && lab.value ? lab.label : (lab ? lab.label : text));
        if (fld) {
          const targetingish = TARGETING_FIELDS.has(fld);
          // "Lookalike 1%" or "Interest: Runners" with its own ad text is an ad set, not a label
          if (targetingish && upCamp && !upSet && inf.copy && ((lab && lab.value) || /\d|%/.test(text))) { openAdSet(text, b.level, false); continue; }
          // "Retargeting" holding ad sets is a campaign
          if (targetingish && !upCamp && (inf.adSetHeads || inf.childTargeting) && isNameLike(text) && !CONTAINER_NAME.test(text)) { openCampaign(text, b.level, false); continue; }
          if (lab && lab.value) { popTo(b.level, true); handleLabelLine(text, b); continue; }
          popTo(b.level, true);
          if (fld === 'keywords') { stack.push({ level: b.level, kind: 'skip', name: text, lines: 0, google: true }); continue; }
          stack.push({ level: b.level, kind: 'role', role: { field: fld, plural: /s$|options?|variations?|versions?/i.test(text.replace(/\s*\([^)]*\)\s*$/, '')), label: text } });
          continue;
        }
        if (taught === 'other' || SKIP_SECTION.test(lk)) {
          popTo(b.level, true);
          stack.push({ level: b.level, kind: 'skip', name: text, lines: 0 });
          continue;
        }
        popTo(b.level, false);
        // generic heading: decide from where it sits and what it holds
        const inCamp = !!cur('campaign'), inSet = !!cur('adset');
        const container = !!plat || inf.campaignHeads || CONTAINER_NAME.test(text);
        if (!container && (inf.adSetHeads || inf.childTargeting) && !inCamp && isNameLike(text)) { openCampaign(text, b.level, false); continue; }
        if (!container && isNameLike(text) && inSet && inf.copy && !inf.targeting) { openAd(text, b.level, false); continue; }
        if (!container && isNameLike(text) && (inf.targeting || inf.copy) && (inCamp || (!res.campaigns.length && !inf.campaignHeads))) { openAdSet(text, b.level, false); continue; }
        stack.push({ level: b.level, kind: 'container', name: text });
        continue;
      }

      if (b.t === 'table') {
        const re = roleEntry();
        // a table inside a notes, metrics or checklist section is part of that section
        if (!pending && re && re.kind === 'skip') { re.lines++; if (re.lines === 1) skip(re.name, re.google ? 'Keywords are for Google Search. Meta does not use them.' : 'Notes or strategy section, not ad content', re.google ? 'google' : 'note'); continue; }
        if (pending && pending.field === 'skip') { pending.lines++; if (pending.lines === 1) skip(pending.label, 'Notes or strategy section, not ad content', 'note'); continue; }
        if (placementTable(b.rows)) continue;
        const role = pending || (re && re.kind === 'role' ? re.role : null);
        // a table right under a "Headlines" or "Interests" label is that list
        if (role && role.field !== 'skip' && role.field !== 'keywords' && b.rows.every(r => r.filter(Boolean).length <= 2) && b.rows[0] && !b.rows[0].some(c => colField(c) && colField(c) !== 'count' && colField(c) !== role.field)) {
          const hdr = b.rows[0].map(colField);
          const hasHeader = hdr.some(Boolean);
          const ci = Math.max(0, hdr.findIndex(f => f === role.field));
          b.rows.slice(hasHeader ? 1 : 0).forEach(r => { if (r[ci]) addRoleItem(role.field, r[ci], { t: 'li' }, null); });
          pending = null;
          continue;
        }
        pending = null;
        handleTable(b.rows, b);
        continue;
      }

      // paragraphs and list items
      const text = b.text;
      const t = norm(text);
      if (!t) continue;
      const re = roleEntry();
      if (!pending && re && re.kind === 'skip') {
        if (!(b.bold || b.t === 'p') || !(structural(t, false) || handleLabelLineCheck(t))) { re.lines++; if (re.lines === 1) skip(re.name, re.google ? 'Keywords are for Google Search. Meta does not use them.' : 'Notes or strategy section, not ad content', re.google ? 'google' : 'note'); continue; }
      }
      if (pending && pending.field === 'skip') {
        if (!(b.bold && (structural(t, false) || fieldOf(t.replace(/:$/, ''))))) { pending.lines++; if (pending.lines === 1) skip(pending.label, 'Notes or strategy section, not ad content', 'note'); continue; }
        pending = null;
      }
      if (pending && pending.field === 'keywords') {
        if (b.t === 'li' || !handleLabelLineCheck(t)) continue;
        pending = null;
      }
      // a structural line: "Ad Set 2: Lookalike 1%", "**Ad 1 – Testimonial**"
      const stLine = (b.t === 'p' || b.bold) ? structural(t, !!b.bold) : null;
      if (stLine && (b.bold || b.t === 'p') && !(pending && COPY_FIELDS.has(pending.field) && stLine.kind === 'ad' && !b.bold)) {
        const base = (() => { for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].synthetic && stack[k].kind !== 'role' && stack[k].kind !== 'skip') return stack[k].level; return 0; })();
        if (stLine.kind === 'campaign') openCampaign(stLine.name, base + 0.1, true);
        else if (stLine.kind === 'adset') openAdSet(stLine.name, base + 0.2, true);
        else openAd(stLine.name, base + 0.3, true);
        continue;
      }
      if (handleLabelLine(t, b)) continue;
      // a short name right before targeting labels starts an ad set, even inside a copy list: "Bargain Hunters" then "Interests: ..."
      if (b.t === 'p' && isNameLike(t) && !CONTAINER_NAME.test(t) && (cur('campaign') || !res.campaigns.length)) {
        const next = blocks[i + 1] || {};
        const nl = next.t === 'p' || next.t === 'li' ? labelOfLine(next.text) : null;
        const nf = nl ? fieldOf(nl.label) : (next.t === 'p' && next.bold ? fieldOf(next.text.replace(/:$/, '')) : null);
        if (nf && TARGETING_FIELDS.has(nf) && nf !== 'audience') {
          const base = (() => { for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].synthetic && stack[k].kind !== 'role' && stack[k].kind !== 'skip') return stack[k].level; return 0; })();
          openAdSet(t, base + 0.2, true);
          continue;
        }
      }
      // after "Headline: X", only bullets continue the list; a plain line is something else (emoji lines still continue primary text)
      if (pending && pending.inline && b.t === 'p' && !(pending.field === 'primary' && /^(?:[\p{Extended_Pictographic}\u2705\u2714\u2713\u2022]|\p{Regional_Indicator})/u.test(t))) pending = null;
      const role = pending || (re && re.kind === 'role' ? re.role : null);
      if (role && role.field && role.field !== 'skip') {
        if (role === pending || !pending) {
          const state = pending || re.roleState || (re.roleState = { field: role.field, plural: role.plural, label: role.label });
          if (!addRoleItem(role.field, text, b, state)) skip(t, 'Could not read this as ' + fieldName(role.field), 'value', nodeRef());
          continue;
        }
      }
      // A bold or short plain name followed by targeting or ad text: an ad set (or an ad inside an ad set)
      if ((b.bold || (b.t === 'p' && isNameLike(t) && t.split(' ').length <= 6)) && isNameLike(t) && !CONTAINER_NAME.test(t)) {
        const next = blocks.slice(i + 1, i + 3).find(x => x.t !== 'table') || {};
        const nl = labelOfLine(next.text || '');
        const nf = fieldOf(nl ? nl.label : (next.text || '').replace(/:$/, ''));
        const base = (() => { for (let k = stack.length - 1; k >= 0; k--) if (!stack[k].synthetic && stack[k].kind !== 'role' && stack[k].kind !== 'skip') return stack[k].level; return 0; })();
        if (nf && TARGETING_FIELDS.has(nf) && (cur('campaign') || !res.campaigns.length)) { openAdSet(t, base + 0.2, true); continue; }
        if (nf && COPY_FIELDS.has(nf) && cur('adset')) { openAd(t, base + 0.3, true); continue; }
        if (nf && COPY_FIELDS.has(nf) && cur('campaign')) { openAdSet(t, base + 0.2, true); continue; }
      }
      if (b.t === 'li' && !role) {
        // a bare list with no label: report it
        skip(t, 'List item outside a recognized section', 'line', nodeRef());
        continue;
      }
      if (findUrl(t) && /^\S+$/.test(t)) { putField(res, nodeFor('url'), 'url', t); continue; }
      if (/\s\|\s/.test(t) && pipeSummary(t)) continue;
      // the client name and doc title lines above the first section
      if (!stack.length && !blocks.slice(0, i).some(x => x.t === 'h') && t.split(' ').length <= 8 && !/[.!?]$/.test(t)) continue;
      if (isNoteLine(t)) { skip(t, 'Note or advice, not ad content', 'note', nodeRef()); continue; }
      skip(t, b.bold ? 'Bold line not recognized' : 'Line outside a recognized section', 'line', nodeRef());
    }

    function handleLabelLineCheck(t) {
      const lab = labelOfLine(t);
      return !!((lab && fieldOf(lab.label)) || fieldOf(t.replace(/:$/, '')));
    }

    return res;
  }

  const FIELD_NAMES = { primary: 'primary text', headline: 'a headline', description: 'a description', interests: 'interests', audiences: 'audiences', exclusions: 'exclusions', locations: 'a location', placements: 'placements', audience: 'audience details', cta: 'a call to action', url: 'a URL', age: 'an age range', gender: 'a gender', budget: 'a budget', objective: 'an objective' };
  const fieldName = f => FIELD_NAMES[f] || f;

  /* ---------- 6. Parse result -> model ---------- */

  function deriveName(title, sourceName) {
    const t = norm(title).replace(/\b(?:meta|facebook|instagram|fb|ig)\s+(?:ads?\s+)?(?:campaign\s+)?(?:plan|structure|strategy|build|setup|brief|doc(?:ument)?)\b/ig, '').replace(/\b(?:campaign\s+)?(?:plan|structure|strategy|build|setup)\b/ig, '').replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '').trim();
    if (t && t.length <= 60) return t + ' - Meta';
    const s = norm(String(sourceName || '').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '));
    return (s || 'Meta') + ' campaign';
  }

  function buildModel(res, sourceName) {
    const notes = res.notes.slice();
    const acct = res.account;
    const camps = res.campaigns.slice();
    // ad sets with no campaign go into one campaign named after the doc
    const orphanSets = res.adSets.filter(a => !a.parent);
    if (orphanSets.length || !camps.length) {
      if (orphanSets.length || res.ads.length || acct.l.primary.length || acct.l.headline.length || acct.f.objective) {
        const c = newNode('campaign', camps.length ? 'Other ad sets' : deriveName(res.title, sourceName));
        c.explicit = true;
        camps.push(c);
        orphanSets.forEach(a => { a.parent = c; });
      }
    }
    const campaigns = [], adSets = [], ads = [];
    const has = (n, f) => n && n.f[f] != null && n.f[f] !== '';
    const pick = (f, ...nodes) => { for (const n of nodes) if (has(n, f)) return n.f[f]; return null; };
    const listFrom = (f, ...nodes) => { for (const n of nodes) if (n && n.l[f].length) return n.l[f].slice(); return []; };

    camps.forEach(cn => {
      let sets = res.adSets.filter(a => a.parent === cn);
      if (!sets.length) {
        const a = newNode('adset', 'Ad set 1', cn);
        a.explicit = true;
        res.adSets.push(a);
        sets = [a];
      }
      const objective = pick('objective', cn, acct);
      const allowed = LOCATIONS_BY_OBJECTIVE[objective] || [];
      let convLoc = [pick('conversionLocation', cn, acct)].concat(sets.map(s => s.f.conversionLocation)).find(x => x && allowed.includes(x)) || null;
      if (!convLoc && DEFAULT_LOCATION[objective]) {
        convLoc = DEFAULT_LOCATION[objective];
        if (objective === 'LEADS') notes.push({ msg: (cn.name || 'A campaign') + ': the doc does not say where leads come in, so it is set to Website. Switch to Instant forms if the plan uses Meta lead forms.', level: 'info' });
      }
      const engagementType = convLoc === 'on_ad' ? (pick('engagementType', cn, acct) || sets.map(s => s.f.engagementType).find(Boolean) || 'interactions') : '';
      const messageApps = convLoc === 'messages' ? (pick('messageApps', cn, acct) || sets.map(s => s.f.messageApps).find(Boolean) || ['messenger', 'instagram']).slice() : [];
      const camp = {
        id: nid('c'), name: cn.name || 'Campaign ' + (campaigns.length + 1), objective, conversionLocation: convLoc, engagementType, messageApps,
        special: pick('specialCategory', cn, acct) || 'NONE',
        budget: null, budgetLevel: 'campaign',
        bidStrategy: pick('bidStrategy', cn, acct) || 'LOWEST_COST_WITHOUT_CAP', bidAmount: pick('bidAmount', cn, acct),
        startDate: pick('startDate', cn, acct) || '', endDate: pick('endDate', cn, acct) || '',
        event: pick('event', cn, acct) || '',
        leadFormId: pick('leadForm', cn) || ''
      };
      // a Page or pixel written under a campaign still belongs to the whole account
      ['page', 'pixel', 'leadForm'].forEach(f => { if (cn.f[f] && !acct.f[f] && f !== 'leadForm') acct.f[f] = cn.f[f]; });
      // budget level: ad set budgets win, unless the doc says CBO
      const setBudgets = sets.filter(s => s.f.budget);
      const type = pick('budgetType', cn, acct);
      let campBudget = cn.f.budget || null;
      if (!campBudget && acct.f.budget && camps.length === 1) campBudget = acct.f.budget;
      if (setBudgets.length && type !== 'campaign') {
        camp.budgetLevel = 'adset';
        if (campBudget && setBudgets.length < sets.length) {
          notes.push({ msg: camp.name + ': some ad sets have their own budget and some do not. Check the ad set budgets.', level: 'warn' });
        } else if (campBudget && !(campBudget.period === 'daily' && Math.abs(setBudgets.reduce((t, x) => t + (x.f.budget.daily || 0), 0) - campBudget.daily) < 0.01)) {
          // said only when the figures differ: "$10 a day, set at ad set level" next to a $10 ad set is the same budget
          notes.push({ msg: camp.name + ': used the ad set budgets. The campaign budget of ' + fmtNum(campBudget.amount) + ' in the doc was left out.', level: 'info' });
        }
      } else if (campBudget && type === 'adset' && sets.length) {
        camp.budgetLevel = 'adset';
        const each = campBudget.period === 'lifetime' ? { amount: round2(campBudget.amount / sets.length), basis: 'lifetime', period: 'lifetime', daily: null }
          : { amount: round2(campBudget.amount / sets.length), basis: campBudget.basis, period: 'daily', daily: round2(campBudget.daily / sets.length) };
        sets.forEach(s => { s.f.budget = s.f.budget || each; });
        notes.push({ msg: camp.name + ': the doc asks for ad set budgets, so the campaign budget is split evenly across ' + sets.length + ' ad sets.', level: 'info' });
      } else {
        camp.budgetLevel = 'campaign';
        camp.budget = campBudget ? budgetOut(campBudget) : null;
        if (setBudgets.length) notes.push({ msg: camp.name + ': the doc asks for a campaign budget, so the ad set budgets were left out.', level: 'info' });
      }
      if (campBudget && campBudget.basis === 'monthly' && camp.budgetLevel === 'campaign') notes.push({ msg: camp.name + ': monthly budget of ' + fmtNum(campBudget.amount) + ' set as ' + fmtNum(campBudget.daily) + ' a day (divided by 30.4).', level: 'info' });
      if (acct.f.budget && camps.length > 1 && !campaigns.length) notes.push({ msg: 'The doc gives a total budget of ' + fmtNum(acct.f.budget.amount) + ' across campaigns. Set each campaign\'s budget.', level: 'warn' });
      campaigns.push(camp);

      sets.forEach((sn, si) => {
        const loc = [];
        const ownLoc = sn.l.locations.length ? sn.l.locations : cn.l.locations;
        ownLoc.forEach(x => loc.push(Object.assign({}, x)));
        const audiences = listFrom('audiences', sn, cn);
        // "Website Visitors (30 day)" or "Lookalike 1%" with no audience listed: the name says what to add
        if (!audiences.length && /visitors|retarget|remarket|engagers|past\s+customers|customer\s+list|email\s+list|abandon|warm|look\s?alike|\blal\b|\blla\b|followers|video\s+viewers/i.test(sn.name)) audiences.push(sn.name);
        const as = {
          id: nid('s'), campaignId: camp.id, name: sn.name || 'Ad set ' + (si + 1),
          budget: camp.budgetLevel === 'adset' && sn.f.budget ? budgetOut(sn.f.budget) : null,
          startDate: sn.f.startDate || '', endDate: sn.f.endDate || '',
          ageMin: pick('ageMin', sn, cn), ageMax: pick('ageMax', sn, cn), gender: pick('gender', sn, cn) || '',
          locations: loc,
          interests: listFrom('interests', sn, cn, acct),
          audiences: audiences.length ? audiences : listFrom('audiences', acct),
          exclusions: listFrom('exclusions', sn, cn, acct),
          placements: pick('placements', sn, cn, acct) || { mode: 'advantage' },
          goal: pick('optimization', sn, cn, acct) || '',
          event: pick('event', sn) || '',
          bidStrategy: sn.f.bidStrategy || '', bidAmount: sn.f.bidAmount || null,
          notes: sn.l.notes.slice(),
          // settings the import file cannot carry, from the account, campaign, ad set and its ads
          settings: [acct, cn, sn].concat(res.ads.filter(x => x.parent === sn)).reduce((out, n) => {
            (n.l.settings || []).forEach(x => { if (!out.some(o => key(o.label) === key(x.label))) out.push(Object.assign({}, x)); });
            return out;
          }, [])
        };
        if (camp.budgetLevel === 'adset' && !as.budget && sn.f.budget) as.budget = budgetOut(sn.f.budget);
        if (as.budget && sn.f.budget && sn.f.budget.basis === 'monthly') notes.push({ msg: as.name + ': monthly budget of ' + fmtNum(sn.f.budget.amount) + ' set as ' + fmtNum(sn.f.budget.daily) + ' a day.', level: 'info' });
        adSets.push(as);

        // ads: the doc's own ads, else one ad per primary text (headlines and descriptions are paired in order)
        const own = res.ads.filter(a => a.parent === sn);
        const P = listFrom('primary', sn, cn, acct), H = listFrom('headline', sn, cn, acct), D = listFrom('description', sn, cn, acct);
        const adBase = n => ({
          cta: pick('cta', n, sn, cn, acct) || '', url: pick('url', n, sn, cn) || '', displayLink: pick('displayLink', n, sn, cn, acct) || '',
          urlTags: pick('urlTags', n, sn, cn) || '', format: pick('format', n, sn, cn) || '', media: pick('media', n, sn) || '',
          imageHash: pick('imageHash', n) || '', videoId: pick('videoId', n) || '',
          // "Video01_ExistingPost": the name alone says the ad runs an existing post
          existingPost: !!pick('existingPost', n, sn, cn, acct) || !!(n && (EXISTING_POST.test(n.name || '') || n.f.postId)), postId: pick('postId', n) || '', notes: n ? n.l.notes.slice() : []
        });
        if (own.length) {
          own.forEach((an, k) => {
            // the ad's own name ("Video01", "Reel_Testimonial") says more than a format written for the whole ad set
            const fmt = pick('format', an) || parseFormat(String(an.name || '').replace(/[_-]+/g, ' ')) || pick('format', sn, cn) || '';
            ads.push(Object.assign({ id: nid('a'), adSetId: as.id, name: an.name || 'Ad ' + (k + 1) }, adBase(an), {
              format: fmt,
              primary: an.l.primary[0] || P[k % (P.length || 1)] || '',
              headline: an.l.headline[0] || H[k % (H.length || 1)] || '',
              description: an.l.description[0] || D[k % (D.length || 1)] || ''
            }));
            // extra lines written under one ad become more ads of the same creative
            const extra = Math.max(an.l.primary.length, an.l.headline.length) - 1;
            for (let e = 1; e <= extra; e++) {
              ads.push(Object.assign({ id: nid('a'), adSetId: as.id, name: (an.name || 'Ad ' + (k + 1)) + ' - V' + (e + 1) }, adBase(an), {
                format: fmt,
                primary: an.l.primary[e % an.l.primary.length] || an.l.primary[0] || '',
                headline: an.l.headline[e % (an.l.headline.length || 1)] || an.l.headline[0] || H[0] || '',
                description: an.l.description[e % (an.l.description.length || 1)] || an.l.description[0] || D[0] || ''
              }));
            }
          });
        } else {
          const n = Math.max(P.length, H.length, 1);
          for (let k = 0; k < n; k++) {
            ads.push(Object.assign({ id: nid('a'), adSetId: as.id, name: 'Ad ' + (k + 1) }, adBase(null), {
              primary: P.length ? P[k % P.length] : '', headline: H.length ? H[k % H.length] : '', description: D.length ? D[k % D.length] : ''
            }));
          }
        }
      });
    });

    // account-level values the page shows as defaults
    const detected = {};
    if (acct.f.url) detected.url = acct.f.url;
    if (acct.f.page) detected.pageId = acct.f.page;
    if (acct.f.pixel) detected.pixelId = acct.f.pixel;
    if (acct.f.leadForm) detected.leadFormId = acct.f.leadForm;
    if (acct.f.urlTags) detected.urlTags = acct.f.urlTags;
    if (acct.f.phone) detected.phone = acct.f.phone;
    if (acct.f.appId) detected.appId = acct.f.appId;
    if (acct.f.appStoreUrl) detected.appStoreUrl = acct.f.appStoreUrl;
    if (acct.f.cta) detected.cta = acct.f.cta;
    if (acct.l.locations.length) detected.locations = acct.l.locations;
    if (acct.f.ageMin) { detected.ageMin = acct.f.ageMin; detected.ageMax = acct.f.ageMax; }
    if (acct.f.gender) detected.gender = acct.f.gender;
    if (!detected.url) {
      const u = res.campaigns.map(c => c.f.url).find(Boolean);
      if (u) detected.url = u;
    }
    if (res.placeholders && res.placeholders.length) notes.push({ msg: 'The doc leaves blanks to fill in: ' + res.placeholders.map(x => x.label.replace(/:\s*$/, '') + ': ' + x.value).join('; ') + '. Add them here or in Ads Manager.', level: 'warn' });
    if (acct.f.languages || res.campaigns.some(c => c.f.languages) || res.adSets.some(a => a.f.languages)) notes.push({ msg: 'Language targeting from the doc is left out. Meta advises it only when the audience speaks a language that is uncommon where they live.', level: 'info' });

    return {
      name: sourceName || '', title: res.title,
      campaigns, adSets, ads, detected,
      notes, skipped: res.skipped.map(s => Object.assign({}, s, { adSetId: s.at && s.at.adSet ? (adSets.find(a => a.name === s.at.adSet.name) || {}).id || null : null }))
    };
  }
  const budgetOut = b => ({ amount: b.period === 'lifetime' ? b.amount : b.daily, period: b.period, basis: b.basis, source: b.amount });
  const fmtNum = n => (Math.round(n * 100) / 100).toLocaleString('en-US');

  function parseBlocksToModel(blocks, name, opts) { return buildModel(parseBlocks(blocks, opts), name); }
  function parseHTML(html, name, ParserCtor, opts) { return parseBlocksToModel(htmlToBlocks(html, ParserCtor), name, opts); }
  function parseText(txt, name, opts) { return parseBlocksToModel(textToBlocks(txt), name, opts); }
  function blocksToText(blocks) {
    return blocks.map(b => b.t === 'h' ? '#'.repeat(b.level) + ' ' + b.text
      : b.t === 'li' ? '- ' + b.text
        : b.t === 'table' ? b.rows.map(r => '| ' + r.map(c => String(c).replace(/\n/g, ' / ')).join(' | ') + ' |').join('\n')
          : (b.bold ? '**' + b.text + '**' : b.text)).join('\n');
  }

  /* ---------- 7. Checks ---------- */

  const LIMITS = { primary: 125, headline: 40, description: 30 };
  const isUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && /\./.test(x.hostname); } catch (e) { return false; } };
  // The button an ad gets when it does not name one: message, call and app ads have their own
  function defaultCta(c, S) {
    const loc = c && c.conversionLocation;
    if (loc === 'messages') return (c.messageApps || []).length === 1 && c.messageApps[0] === 'whatsapp' ? 'WHATSAPP_MESSAGE' : 'MESSAGE_PAGE';
    if (loc === 'calls') return 'CALL_NOW';
    if (loc === 'app') return 'INSTALL_MOBILE_APP';
    return (S && S.cta) || 'LEARN_MORE';
  }
  const phoneOf = (c, S) => String((c && c.phone) || (S && S.phone) || '').replace(/[^\d+]/g, '');
  const adEff = (ad, S, c) => ({
    url: c && c.conversionLocation === 'app' ? (ad.url || (S && S.appStoreUrl) || '') : (ad.url || S.url || ''),
    cta: ad.cta || defaultCta(c, S),
    urlTags: ad.urlTags || S.urlTags || ''
  });
  const setEff = (as, S) => ({
    locations: as.locations.length ? as.locations : (S.locations || []),
    ageMin: as.ageMin != null && as.ageMin !== '' ? +as.ageMin : (S.ageMin != null && S.ageMin !== '' ? +S.ageMin : 18),
    ageMax: as.ageMax != null && as.ageMax !== '' ? +as.ageMax : (S.ageMax != null && S.ageMax !== '' ? +S.ageMax : 65),
    gender: as.gender || S.gender || 'all'
  });
  function goalFor(camp, as) {
    const list = goalsFor(camp);
    if (as && as.goal && list.includes(as.goal)) return as.goal;
    return list[0] || '';
  }
  const eventFor = (camp, as) => (as && as.event) || camp.event || (camp.objective === 'SALES' ? 'PURCHASE' : camp.objective === 'LEADS' ? 'LEAD' : '');
  // website conversions need the pixel; app events use the app instead
  const needsPixel = (camp, as) => ['OFFSITE_CONVERSIONS', 'VALUE'].includes(goalFor(camp, as)) && camp.conversionLocation !== 'app';
  const needsUrl = (camp, as) => camp.conversionLocation === 'website' || (!camp.conversionLocation && ['TRAFFIC', 'LEADS', 'SALES'].includes(camp.objective));
  // an ad goes in the import file unless it runs an existing post the doc gave no post ID for
  const inFile = ad => !ad.existingPost || !!postIdOf(ad.postId);
  // destination_type for the ad set, from the conversion location
  function destinationFor(c, a) {
    switch (c.conversionLocation) {
      case 'website': return 'WEBSITE';
      case 'app': return 'APP';
      case 'calls': return 'PHONE_CALL';
      case 'form': return 'ON_AD';
      case 'ig_live': return 'INSTAGRAM_LIVE';
      case 'profile': return goalFor(c, a) === 'VISIT_INSTAGRAM_PROFILE' ? 'INSTAGRAM_PROFILE' : 'FACEBOOK_PAGE';
      case 'on_ad': return { video_views: 'ON_VIDEO', event_responses: 'ON_EVENT', reminders: 'ON_AD' }[c.engagementType] || 'ON_POST';
      case 'messages': {
        const apps = ['instagram', 'messenger', 'whatsapp'].filter(x => (c.messageApps || []).includes(x));
        if (apps.length === 1) return { messenger: 'MESSENGER', instagram: 'INSTAGRAM_DIRECT', whatsapp: 'WHATSAPP' }[apps[0]];
        if (apps.length === 3) return 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP';
        if (apps.length === 2) return { 'instagram,messenger': 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER', 'instagram,whatsapp': 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP', 'messenger,whatsapp': 'MESSAGING_MESSENGER_WHATSAPP' }[apps.join(',')];
        return 'MESSENGER';
      }
      default: return '';
    }
  }
  const BID_LABEL = k => (BID_STRATEGIES.find(b => b[0] === k) || [, k])[1];
  const digits = v => /^\d{5,20}$/.test(String(v || '').replace(/^(?:o|tp|v):/, ''));

  function validate(model, S, today) {
    const errors = [], warnings = [];
    const err = (msg, ref) => errors.push(Object.assign({ msg }, ref || {}));
    const warn = (msg, ref) => warnings.push(Object.assign({ msg }, ref || {}));
    const withAds = S.scope !== 'structure';
    if (!model.campaigns.length) err('No campaigns. Load a doc or add a campaign.');
    // existing-post ads without a post ID are made in Ads Manager, so they need no Page ID, copy or media here
    const fileAds = model.ads.filter(inFile);
    if (withAds && fileAds.length) {
      if (!S.pageId) err('Add your Facebook Page ID under Account defaults. Every ad runs from a Page.', { field: 'pageId' });
      else if (!digits(S.pageId)) err('The Page ID should be the number from your Page\'s About section or Business settings.', { field: 'pageId' });
    }
    if (S.pixelId && !digits(S.pixelId)) err('The pixel ID should be a number (Events Manager, Data sources).', { field: 'pixelId' });
    if (S.leadFormId && !digits(S.leadFormId)) err('The lead form ID should be a number (Page, Instant forms library).', { field: 'leadFormId' });
    const seenC = {};
    model.campaigns.forEach(c => {
      const ref = { campaignId: c.id };
      const sets = model.adSets.filter(a => a.campaignId === c.id);
      const k = key(c.name);
      if (!norm(c.name)) err('A campaign has no name.', ref);
      else if (PLACEHOLDER.test(c.name)) warn(c.name + ': the name still has a placeholder (' + c.name.match(/\[[^\]]+\]/g).join(', ') + '). Replace it before import.', Object.assign({ field: 'name' }, ref));
      else if (seenC[k]) err('Two campaigns are named "' + c.name + '". Ads Manager matches rows by name, so give each a different name.', ref);
      seenC[k] = true;
      if (!c.objective) err(c.name + ': pick an objective.', Object.assign({ field: 'objective' }, ref));
      const loc = c.conversionLocation;
      if (c.objective && c.objective !== 'AWARENESS' && !(LOCATIONS_BY_OBJECTIVE[c.objective] || []).includes(loc)) err(c.name + ': pick a conversion location.', Object.assign({ field: 'conversionLocation' }, ref));
      if (loc === 'messages' && !(c.messageApps || []).length) err(c.name + ': pick at least one message app (Messenger, Instagram or WhatsApp).', Object.assign({ field: 'messageApps' }, ref));
      if (loc === 'messages' && (c.messageApps || []).includes('whatsapp')) warn(c.name + ': WhatsApp ads need a WhatsApp number connected to the Page.', Object.assign({ kind: 'manual' }, ref));
      if (loc === 'calls' && !phoneOf(c, S)) err(c.name + ': call ads need a phone number. Add it here or under Account defaults.', Object.assign({ field: 'phone' }, ref));
      else if (loc === 'calls' && !/^\+?\d{7,15}$/.test(phoneOf(c, S))) err(c.name + ': the phone number should have 7 to 15 digits, with the country code.', Object.assign({ field: 'phone' }, ref));
      if (loc === 'app' && !S.appStoreUrl) err(c.name + ': app ads need the App Store or Google Play link of the app. Add it under Account defaults.', Object.assign({ field: 'appStoreUrl' }, ref));
      else if (loc === 'app' && !isUrl(S.appStoreUrl)) err(c.name + ': the app store link is not a valid URL.', Object.assign({ field: 'appStoreUrl' }, ref));
      if (loc === 'app' && !S.appId) warn(c.name + ': no app ID. Ads Manager may ask you to pick the app after import.', ref);
      if (loc === 'on_ad' && ['event_responses', 'reminders'].includes(c.engagementType)) warn(c.name + ': ' + (c.engagementType === 'event_responses' ? 'event response ads promote a Facebook event' : 'reminder ads promote an upcoming event or live') + '. Pick it in Ads Manager after import.', Object.assign({ kind: 'manual' }, ref));
      if (loc === 'ig_live') warn(c.name + ': Instagram live video ads run on a scheduled live. Pick it in Ads Manager after import.', Object.assign({ kind: 'manual' }, ref));
      if (c.bidStrategy && c.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') warn(c.name + ': the import file leaves bid strategy at Highest volume, because Ads Manager rejects that column on import. Set ' + BID_LABEL(c.bidStrategy) + (c.bidAmount ? ' at ' + c.bidAmount : '') + ' after import.', Object.assign({ kind: 'manual' }, ref));
      if (!sets.length) err(c.name + ': no ad sets.', ref);
      if (c.budgetLevel === 'campaign') {
        if (!c.budget || !(+c.budget.amount > 0)) err(c.name + ': add a campaign budget, or switch to ad set budgets.', Object.assign({ field: 'budget' }, ref));
        else if (c.budget.period === 'daily' && +c.budget.amount < 1) warn(c.name + ': a daily budget under 1 is below what Meta accepts in most currencies.', ref);
        if (c.budget && c.budget.period === 'lifetime' && !c.endDate) err(c.name + ': a lifetime budget needs an end date.', Object.assign({ field: 'endDate' }, ref));
        if (c.budget && c.budget.basis === 'unlabeled') warn(c.name + ': the doc gives the budget without saying daily, monthly or lifetime. It is set as daily.', ref);
      }
      if (c.startDate && today && c.startDate < today) warn(c.name + ': the start date ' + c.startDate + ' has passed. Ads Manager will start it on import.', ref);
      if (c.endDate && c.startDate && c.endDate <= c.startDate) err(c.name + ': the end date is before the start date.', ref);
      const seenS = {};
      sets.forEach(a => {
        const r = { campaignId: c.id, adSetId: a.id };
        const nm = c.name + ' > ' + a.name;
        const e = setEff(a, S);
        const sk = key(a.name);
        if (!norm(a.name)) err(c.name + ': an ad set has no name.', r);
        else if (PLACEHOLDER.test(a.name)) warn(nm + ': the name still has a placeholder. Replace it before import.', r);
        else if (seenS[sk]) err(c.name + ': two ad sets are named "' + a.name + '".', r);
        seenS[sk] = true;
        if (c.budgetLevel === 'adset') {
          if (!a.budget || !(+a.budget.amount > 0)) err(nm + ': add an ad set budget.', Object.assign({ field: 'budget' }, r));
          else if (a.budget.period === 'lifetime' && !(a.endDate || c.endDate)) err(nm + ': a lifetime budget needs an end date.', r);
          else if (a.budget.period === 'daily' && +a.budget.amount < 1) warn(nm + ': a daily budget under 1 is below what Meta accepts in most currencies.', r);
        }
        if (!e.locations.length) err(nm + ': no location. Add one here or under Account defaults.', Object.assign({ field: 'locations' }, r));
        const countries = Array.from(new Set(e.locations.map(locCountry).filter(Boolean)));
        const sub = e.locations.filter(l => l.type !== 'country');
        if (sub.length && countries.length > 1) err(nm + ': cities or regions in more than one country. Ads Manager imports cities for one country per ad set, so split it.', r);
        if (sub.some(l => !l.country)) warn(nm + ': ' + sub.filter(l => !l.country).map(l => '"' + l.name + '"').join(', ') + ' could not be matched to a country. Write it as "City, State" or "City, Country".', r);
        if (sub.some(l => l.type === 'city')) warn(nm + ': Ads Manager matches cities by name. Check this ad set\'s locations after import.', Object.assign({ kind: 'cities' }, r));
        if (e.ageMin < 13 || e.ageMax > 65 || e.ageMin > e.ageMax) err(nm + ': age must run from 13 to 65, lowest first.', Object.assign({ field: 'age' }, r));
        else if (e.ageMin < 18) warn(nm + ': ages under 18 are restricted in many countries.', r);
        if (c.special && c.special !== 'NONE') {
          if (e.ageMin !== 18 || e.ageMax !== 65) err(nm + ': special ad categories must target ages 18 to 65+.', Object.assign({ field: 'age' }, r));
          if (e.gender !== 'all') err(nm + ': special ad categories cannot target by gender.', r);
          if (a.interests.length) warn(nm + ': special ad categories limit detailed targeting. Some interests may not be available.', r);
          if (sub.some(l => l.radius && ((l.unit === 'mi' && l.radius < 15) || (l.unit === 'km' && l.radius < 25)))) err(nm + ': special ad categories need a radius of at least 15 miles (25 km).', r);
        }
        if (needsPixel(c, a) && !S.pixelId) err(nm + ': conversion ad sets need the pixel (dataset) ID. Add it under Account defaults.', Object.assign({ field: 'pixelId' }, r));
        if (c.conversionLocation === 'form' && withAds && !(c.leadFormId || S.leadFormId)) err(nm + ': instant form ads need a lead form ID. Add it under Account defaults, or set the conversion location to Website.', Object.assign({ field: 'leadFormId' }, r));
        if (a.interests.length || a.audiences.length || a.exclusions.length) {
          const parts = [];
          if (a.interests.length) parts.push(a.interests.length + ' interest' + (a.interests.length > 1 ? 's' : ''));
          if (a.audiences.length) parts.push(a.audiences.length + ' custom or lookalike audience' + (a.audiences.length > 1 ? 's' : ''));
          if (a.exclusions.length) parts.push(a.exclusions.length + ' exclusion' + (a.exclusions.length > 1 ? 's' : ''));
          warn(nm + ': add ' + parts.join(', ') + ' in Ads Manager after import. The import file needs Meta\'s audience IDs, so they are on the after-import list.', Object.assign({ kind: 'manual' }, r));
        }
        if (a.audiences.length && S.status === 'ACTIVE') warn(nm + ': this ad set imports as active before its audience is added. Import paused instead.', r);
        if (a.placements.mode === 'manual' && !a.placements.platforms.length) err(nm + ': manual placements with no platform. Pick one or use Advantage+ placements.', r);
        if (!withAds) return;
        const ads = model.ads.filter(x => x.adSetId === a.id);
        if (!ads.length) err(nm + ': no ads.', r);
        const seenA = {};
        ads.forEach(ad => {
          const ar = { campaignId: c.id, adSetId: a.id, adId: ad.id };
          const an = nm + ' > ' + (ad.name || 'ad');
          const x = adEff(ad, S, c);
          if (!norm(ad.name)) err(nm + ': an ad has no name.', ar);
          else if (seenA[key(ad.name)]) warn(nm + ': two ads are named "' + ad.name + '".', ar);
          seenA[key(ad.name)] = true;
          if (ad.existingPost) {
            if (!norm(ad.postId)) { warn(an + ': uses an existing Page post. Add its post ID to put it in the import file, or create this ad in Ads Manager after import (it is on the after-import list).', Object.assign({ kind: 'manual', field: 'postId' }, ar)); return; }
            if (!postIdOf(ad.postId)) { err(an + ': the post ID should be the post\'s number, for example 122115687656432835 (the Story ID column of an Ads Manager export, without "s:").', Object.assign({ field: 'postId' }, ar)); return; }
            if (PLACEHOLDER.test(ad.name)) warn(an + ': the name still has a placeholder. Replace it before import.', ar);
            if (!['image', 'video'].includes(ad.format)) warn(an + ': set the format to Single image or Video to match the post, so the file can name its creative type.', Object.assign({ field: 'fmt' }, ar));
            return;
          }
          if (!norm(ad.primary)) err(an + ': add primary text.', Object.assign({ field: 'primary' }, ar));
          if (!norm(ad.headline) && !['on_ad', 'ig_live'].includes(loc)) warn(an + ': no headline.', Object.assign({ field: 'headline' }, ar));
          if (loc === 'on_ad' && c.engagementType === 'video_views' && ad.format !== 'video' && !ad.videoId) warn(an + ': video views campaigns need a video ad. Set the format to Video.', Object.assign({ field: 'fmt' }, ar));
          if (needsUrl(c, a) && !x.url) err(an + ': add a website URL (here or under Account defaults).', Object.assign({ field: 'url' }, ar));
          if (x.url && !isUrl(x.url) && (needsUrl(c, a) || loc === 'app' || ad.url)) err(an + ': "' + x.url + '" is not a valid URL.', Object.assign({ field: 'url' }, ar));
          if (x.urlTags && !/^[^?\s]+=[^\s]*$/.test(x.urlTags)) err(an + ': URL parameters should look like utm_source=facebook&utm_medium=paid.', Object.assign({ field: 'urlTags' }, ar));
          if (textLen(ad.primary) > LIMITS.primary) warn(an + ': primary text is ' + textLen(ad.primary) + ' characters. Feed shows about 125 before "See more".', Object.assign({ kind: 'length' }, ar));
          if (textLen(ad.headline) > LIMITS.headline) warn(an + ': headline is ' + textLen(ad.headline) + ' characters. Meta suggests 40 or fewer.', Object.assign({ kind: 'length' }, ar));
          if (textLen(ad.description) > LIMITS.description) warn(an + ': description is ' + textLen(ad.description) + ' characters. Meta suggests 30 or fewer.', Object.assign({ kind: 'length' }, ar));
          if (textLen(ad.headline) > 255) err(an + ': the headline is over 255 characters.', ar);
          if (ad.imageHash && !/^[a-f0-9]{32}$/i.test(ad.imageHash)) err(an + ': an image hash is 32 letters and digits (Ads Manager, Media library).', ar);
          if (ad.videoId && !digits(ad.videoId)) err(an + ': the video ID should be a number.', ar);
          if (!ad.imageHash && !ad.videoId) warn(an + ': no image or video. Add it to the ad in Ads Manager after import, or paste its image hash or video ID here.', Object.assign({ kind: 'media' }, ar));
          if (ad.format === 'carousel') warn(an + ': carousel cards are not in the import file. It imports as a single image ad; build the cards in Ads Manager.', ar);
        });
      });
    });
    if (S.status === 'ACTIVE' && warnings.some(w => w.kind === 'manual' || w.kind === 'media')) warn('Status is set to Active while ads still need audiences or creatives. Paused is safer until the after-import list is done.');
    return { errors, warnings };
  }

  /* ---------- 8. Export ---------- */

  // [key, Ads Manager column header, other spellings seen in exports]
  const COLUMNS = [
    ['campaignName', 'Campaign Name'],
    ['campaignStatus', 'Campaign Status'],
    ['special', 'Special Ad Categories', ['special ad category']],
    ['specialCountry', 'Special Ad Category Country', ['special ad category countries']],
    ['objective', 'Campaign Objective', ['objective']],
    ['buyingType', 'Buying Type'],
    ['campaignDaily', 'Campaign Daily Budget'],
    ['campaignLifetime', 'Campaign Lifetime Budget'],
    ['campaignBid', 'Campaign Bid Strategy'],
    ['campaignStart', 'Campaign Start Time'],
    ['campaignStop', 'Campaign Stop Time'],
    ['adSetName', 'Ad Set Name'],
    ['adSetStatus', 'Ad Set Run Status', ['ad set status']],
    ['adSetStart', 'Ad Set Time Start', ['ad set start time']],
    ['adSetStop', 'Ad Set Time Stop', ['ad set stop time', 'ad set end time']],
    ['adSetDaily', 'Ad Set Daily Budget'],
    ['adSetLifetime', 'Ad Set Lifetime Budget'],
    ['adSetBid', 'Ad Set Bid Strategy'],
    ['bidAmount', 'Bid Amount', ['ad set bid amount']],
    ['goal', 'Optimization Goal'],
    ['pixel', 'Optimized Conversion Tracking Pixels', ['conversion tracking pixels', 'tracking pixels']],
    ['event', 'Optimized Event', ['conversion event']],
    ['billing', 'Billing Event'],
    ['destination', 'Destination Type', ['conversion location']],
    ['appId', 'Application ID', ['app id']],
    ['storeUrl', 'Object Store URL', ['app store url']],
    ['countries', 'Countries'],
    ['regions', 'Regions'],
    ['cities', 'Cities'],
    ['gender', 'Gender', ['genders']],
    ['ageMin', 'Age Min'],
    ['ageMax', 'Age Max'],
    ['platforms', 'Publisher Platforms'],
    ['fbPositions', 'Facebook Positions'],
    ['igPositions', 'Instagram Positions'],
    ['msPositions', 'Messenger Positions'],
    ['anPositions', 'Audience Network Positions'],
    ['storyId', 'Story ID', ['post id']],
    ['adName', 'Ad Name'],
    ['adStatus', 'Ad Status'],
    ['creativeType', 'Creative Type'],
    ['pageId', 'Link Object ID', ['page id', 'facebook page id']],
    ['title', 'Title', ['headline']],
    ['body', 'Body', ['primary text']],
    ['linkDescription', 'Link Description', ['description']],
    ['displayLink', 'Display Link'],
    ['link', 'Link', ['website url']],
    ['cta', 'Call to Action', ['call to action type']],
    ['urlTags', 'URL Tags'],
    ['imageHash', 'Image Hash'],
    ['videoId', 'Video ID'],
    ['leadForm', 'Lead Form ID', ['lead form']]
  ];
  const hdrKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  // A blank template exported from Ads Manager: its header row decides the columns and their order
  function mapTemplate(headers) {
    const hs = (headers || []).map(h => norm(h));
    const index = {};
    COLUMNS.forEach(([k, h, alt]) => {
      const keys = [h].concat(alt || []).map(hdrKey);
      const i = hs.findIndex(x => keys.includes(hdrKey(x)));
      if (i >= 0) index[k] = i;
    });
    return { headers: hs, index, matched: Object.keys(index).length };
  }

  const money = n => (Math.round(+n * 100) / 100).toFixed(2);
  const usDate = d => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? m[2] + '/' + m[3] + '/' + m[1] : ''; };
  const prefixed = (p, v) => { const s = String(v || '').trim(); if (!s) return ''; return s.indexOf(p + ':') === 0 ? s : p + ':' + s.replace(/^[a-z]+:/, ''); };

  function exportTable(model, S, template) {
    const withAds = S.scope !== 'structure';
    const status = S.status === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
    const rows = [];
    model.campaigns.forEach(c => {
      const cRow = {
        campaignName: c.name, campaignStatus: status,
        special: c.special && c.special !== 'NONE' ? c.special : 'None',
        specialCountry: '',
        objective: (OBJECTIVES.find(o => o[0] === c.objective) || [])[2] || '',
        buyingType: 'AUCTION',
        campaignDaily: c.budgetLevel === 'campaign' && c.budget && c.budget.period === 'daily' ? money(c.budget.amount) : '',
        campaignLifetime: c.budgetLevel === 'campaign' && c.budget && c.budget.period === 'lifetime' ? money(c.budget.amount) : '',
        // left blank: Ads Manager rejects this column on import, and blank means Highest volume
        campaignBid: '',
        campaignStart: usDate(c.startDate), campaignStop: usDate(c.endDate)
      };
      const sets = model.adSets.filter(a => a.campaignId === c.id);
      if (c.special && c.special !== 'NONE') {
        const cs = Array.from(new Set(sets.flatMap(a => setEff(a, S).locations.map(locCountry)).filter(Boolean)));
        cRow.specialCountry = cs.join(', ');
      }
      sets.forEach(a => {
        const e = setEff(a, S);
        const goal = goalFor(c, a);
        const countries = Array.from(new Set(e.locations.map(locCountry).filter(Boolean)));
        const regions = e.locations.filter(l => l.type === 'region');
        const cities = e.locations.filter(l => l.type === 'city');
        const pl = a.placements && a.placements.mode === 'manual' ? a.placements : null;
        const sRow = Object.assign({}, cRow, {
          adSetName: a.name, adSetStatus: status,
          adSetStart: usDate(a.startDate || (c.budgetLevel === 'adset' ? c.startDate : '')), adSetStop: usDate(a.endDate || (c.budgetLevel === 'adset' ? c.endDate : '')),
          adSetDaily: c.budgetLevel === 'adset' && a.budget && a.budget.period === 'daily' ? money(a.budget.amount) : '',
          adSetLifetime: c.budgetLevel === 'adset' && a.budget && a.budget.period === 'lifetime' ? money(a.budget.amount) : '',
          adSetBid: '', bidAmount: '',
          goal,
          pixel: needsPixel(c, a) && S.pixelId ? prefixed('tp', S.pixelId) : '',
          event: needsPixel(c, a) ? eventFor(c, a) : '',
          billing: 'IMPRESSIONS',
          destination: destinationFor(c, a),
          appId: c.conversionLocation === 'app' ? S.appId || '' : '',
          storeUrl: c.conversionLocation === 'app' ? S.appStoreUrl || '' : '',
          countries: countries.join(', '),
          regions: regions.map(l => l.name).join(', '),
          cities: cities.map(l => l.name + (l.region ? ', ' + l.region : (l.country && l.country !== 'US' ? ', ' + countryName(l.country) : ''))).join('; '),
          gender: e.gender === 'men' ? 'Men' : e.gender === 'women' ? 'Women' : '',
          ageMin: String(e.ageMin), ageMax: String(e.ageMax),
          platforms: pl ? pl.platforms.join(', ') : '',
          fbPositions: pl && pl.positions.facebook ? pl.positions.facebook.join(', ') : '',
          igPositions: pl && pl.positions.instagram ? pl.positions.instagram.join(', ') : '',
          msPositions: pl && pl.positions.messenger ? pl.positions.messenger.join(', ') : '',
          anPositions: pl && pl.positions.audience_network ? pl.positions.audience_network.join(', ') : ''
        });
        // existing-post ads without a post ID are made in Ads Manager: the ad set row still goes in
        const ads = withAds ? model.ads.filter(x => x.adSetId === a.id && inFile(x)) : [];
        if (!ads.length) { rows.push(sRow); return; }
        ads.forEach(ad => {
          if (ad.existingPost) {
            // the post brings its own text, media and link; Meta's export writes these columns for it
            rows.push(Object.assign({}, sRow, {
              adName: ad.name, adStatus: status,
              creativeType: ad.format === 'video' ? 'Video Page Post Ad' : ad.format === 'image' ? 'Photo Page Post Ad' : '',
              pageId: prefixed('o', S.pageId),
              storyId: 's:' + postIdOf(ad.postId)
            }));
            return;
          }
          const x = adEff(ad, S, c);
          const loc = c.conversionLocation;
          rows.push(Object.assign({}, sRow, {
            adName: ad.name, adStatus: status,
            // a video ad without its video ID is rejected as "Missing video"; it goes in as a link ad and the video is added after import
            creativeType: ad.videoId ? 'Video Page Post Ad' : 'Link Page Post Ad',
            pageId: prefixed('o', S.pageId),
            title: norm(ad.headline), body: normBlock(ad.primary), linkDescription: norm(ad.description),
            displayLink: ad.displayLink || '',
            link: needsUrl(c, a) || loc === 'app' ? x.url : loc === 'calls' && phoneOf(c, S) ? 'tel:' + phoneOf(c, S) : (!['form', 'messages'].includes(loc) && ad.url) ? ad.url : '',
            cta: x.cta,
            urlTags: x.urlTags,
            imageHash: ad.imageHash || '', videoId: ad.videoId ? prefixed('v', ad.videoId) : '',
            leadForm: loc === 'form' ? (c.leadFormId || S.leadFormId || '') : ''
          }));
        });
      });
    });
    if (template && template.headers && template.headers.length) {
      return {
        headers: template.headers.slice(),
        rows: rows.map(r => template.headers.map((h, i) => { const k = Object.keys(template.index).find(kk => template.index[kk] === i); return k && r[k] != null ? String(r[k]) : ''; })),
        missing: COLUMNS.filter(([k]) => template.index[k] == null && rows.some(r => r[k])).map(c => c[1])
      };
    }
    // only the columns this file uses, in Ads Manager order
    const used = COLUMNS.filter(([k]) => rows.some(r => r[k]));
    return { headers: used.map(c => c[1]), rows: rows.map(r => used.map(([k]) => r[k] != null ? String(r[k]) : '')), missing: [] };
  }
  const csvCell = v => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const toCSV = t => [t.headers].concat(t.rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  // Tab-separated for pasting into a spreadsheet; line breaks inside a cell are kept by quoting
  const tsvCell = v => /[\t\r\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  const toTSV = t => [t.headers].concat(t.rows).map(r => r.map(tsvCell).join('\t')).join('\n') + '\n';

  // The after-import list: what the file cannot carry
  function checklist(model, S) {
    const out = [];
    model.campaigns.forEach(c => {
      model.adSets.filter(a => a.campaignId === c.id).forEach(a => {
        const items = [];
        if (a.interests.length) items.push({ kind: 'interests', label: 'Detailed targeting', values: a.interests.slice() });
        if (a.audiences.length) items.push({ kind: 'audiences', label: 'Custom and lookalike audiences', values: a.audiences.slice() });
        if (a.exclusions.length) items.push({ kind: 'exclusions', label: 'Exclude', values: a.exclusions.slice() });
        const e = setEff(a, S);
        // Ads Manager may not match city names on import, which leaves the whole country: check every one
        const cities = e.locations.filter(l => l.type === 'city');
        if (cities.length) items.push({ kind: 'cities', label: 'Check cities', values: cities.map(l => locLabel(l)) });
        if (S.scope !== 'structure') {
          const ads = model.ads.filter(x => x.adSetId === a.id);
          const posts = ads.filter(x => x.existingPost && !inFile(x));
          if (posts.length) items.push({ kind: 'posts', label: 'Create these ads from existing Page posts (Ad setup: Use existing post)', values: posts.map(x => x.name + (x.format ? ' (' + x.format + ')' : '') + ((x.notes || []).length || x.media ? ': ' + norm((x.notes || []).concat(x.media ? [x.media] : []).join('. ').replace(/\.\s*\./g, '.')).slice(0, 200) : '')) });
          const noMedia = ads.filter(x => !x.existingPost && !x.imageHash && !x.videoId);
          // video ads without a video ID import as link ads, so they are listed here too
          if (noMedia.length) items.push({ kind: 'media', label: 'Add creative', values: noMedia.map(x => x.name + (x.format ? ' (' + x.format + ')' : '') + (x.media ? ': ' + norm(x.media).slice(0, 120) : '')) });
        }
        if (c.bidStrategy && c.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') items.push({ kind: 'bid', label: 'Bid strategy', values: [BID_LABEL(c.bidStrategy) + (c.bidAmount ? ': ' + c.bidAmount : '') + ' on the ' + (c.budgetLevel === 'campaign' ? 'campaign' : 'ad set')] });
        if (c.conversionLocation === 'on_ad' && c.engagementType === 'event_responses') items.push({ kind: 'event', label: 'Pick the event', values: ['Choose the Facebook event each ad promotes'] });
        if (c.conversionLocation === 'on_ad' && c.engagementType === 'reminders') items.push({ kind: 'event', label: 'Pick the event', values: ['Choose the upcoming event or live for reminders'] });
        if (c.conversionLocation === 'ig_live') items.push({ kind: 'event', label: 'Pick the live', values: ['Choose the scheduled Instagram live video'] });
        if (c.conversionLocation === 'messages' && (c.messageApps || []).includes('whatsapp')) items.push({ kind: 'whatsapp', label: 'WhatsApp', values: ['Check the WhatsApp number connected to the Page'] });
        if ((a.settings || []).length) items.push({ kind: 'settings', label: 'Settings from the doc to set by hand', values: a.settings.map(x => x.label + ': ' + norm(x.value).slice(0, 160)) });
        if (items.length) out.push({ campaign: c.name, adSet: a.name, adSetId: a.id, items });
      });
    });
    return out;
  }
  function checklistText(list, model) {
    const lines = ['After import: ' + (model.title || model.name || 'Meta campaigns'), ''];
    list.forEach(g => {
      lines.push(g.campaign + ' > ' + g.adSet);
      g.items.forEach(it => { lines.push('  ' + it.label + ':'); it.values.forEach(v => lines.push('    - ' + v)); });
      lines.push('');
    });
    return lines.join('\n');
  }

  const api = {
    norm, normBlock, key, labelKey, sim, textLen, nid, cleanCopy, findUrl,
    htmlToBlocks, textToBlocks, csvToRows, rowsToBlocks, blocksToText,
    fieldOf, platformOf, parseBudget, parseDate, parseSchedule, parseObjective, parseConversionLocation, parseEngagementType, parseMessageApps, parseEvent, parseGoal,
    parseBidStrategy, parseSpecial, parseCta, parseFormat, parseAge, parseGender, parsePlacements, placementsText, parseLocations, parseAudience,
    splitList, locLabel, locCountry, countryName, findCountry, COUNTRIES,
    parseBlocks, buildModel, parseBlocksToModel, parseHTML, parseText, newResult, newNode, putField, deriveName,
    OBJECTIVES, objectiveLabel, EVENTS, GOALS, goalsFor, goalLabel, LOCATIONS, LOCATIONS_BY_OBJECTIVE, DEFAULT_LOCATION, locationLabel, ENGAGEMENT_TYPES, MESSAGE_APPS, BID_STRATEGIES, SPECIAL, CTAS, ctaLabel, POSITIONS, PLATFORM_LABEL, LIMITS,
    goalFor, eventFor, needsPixel, needsUrl, destinationFor, defaultCta, setEff, adEff, isUrl, postIdOf, inFile,
    validate, COLUMNS, mapTemplate, exportTable, toCSV, toTSV, checklist, checklistText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MBEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
