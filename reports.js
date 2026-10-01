// Reports — period maths, live data for any date range, the narrative rules, and storage.
// Nothing here invents a number: every sentence is built from figures pulled at the time.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REPORT_DIR = path.join(DATA_DIR, 'reports');

/* ---------------- dates ---------------- */
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const today = () => new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pretty = s => { const d = new Date(s + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const prettyShort = s => { const d = new Date(s + 'T00:00:00Z'); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0,3)}`; };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5) + 1;

/**
 * Work out the dates for a period and the matching one before it.
 * Kinds: last-month · this-month · last-30 · last-90 · custom (start,end)
 */
const ISO = /^\d{4}-\d{2}-\d{2}$/;
function resolvePeriod(kind, customStart, customEnd) {
  const t = today();
  const yesterday = ymd(addDays(t, -1));
  let start, end, label, span, meta = {};

  if (kind === 'custom') {
    if (!ISO.test(customStart || '') || !ISO.test(customEnd || ''))
      throw new Error('Pick both a start and an end date for a custom range.');
    if (customStart > customEnd) { const sw = customStart; customStart = customEnd; customEnd = sw; }
  }

  if (kind === 'custom') {
    start = customStart; end = customEnd > yesterday ? yesterday : customEnd;
    const len = daysBetween(start, end);
    const endsYesterday = end === yesterday;
    label = endsYesterday ? `The last ${len} days` : `${prettyShort(start)} – ${prettyShort(end)}`;
    span = `${pretty(start)} to ${pretty(end)}`;
    meta = { kind:'range',
      phrase: endsYesterday ? `over the last ${len} days` : `between ${prettyShort(start)} and ${prettyShort(end)}`,
      prevPhrase: endsYesterday ? `in the ${len} days before that` : 'in the stretch before it',
      vs: endsYesterday ? `the ${len} days before` : 'the stretch before',
      nextLabel: 'next' };
  } else if (kind === 'this-month') {
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
    start = ymd(first); end = yesterday;
    label = `${MONTHS[t.getUTCMonth()]}, month to date`;
    span = `${pretty(start)} to ${pretty(end)}`;
    meta = { kind:'partial', phrase:'so far this month', prevPhrase:'over the same days last month',
             vs:'the same days last month', nextLabel:'the rest of the month' };
  } else if (kind === 'last-30' || kind === 'last-90') {
    const n = kind === 'last-30' ? 30 : 90;
    end = yesterday; start = ymd(addDays(t, -n));
    label = `The last ${n} days`;
    span = `${pretty(start)} to ${pretty(end)}`;
    meta = { kind:'range', phrase:`over the last ${n} days`, prevPhrase:`in the ${n} days before`,
             vs:`the ${n} days before`, nextLabel:'next' };
  } else { // last-month, the default
    const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
    start = ymd(first); end = ymd(last);
    const prevM = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
    label = `${MONTHS[first.getUTCMonth()]} ${first.getUTCFullYear()}`;
    span = `${pretty(start)} to ${pretty(end)}`;
    meta = { kind:'month', phrase:'this month', prevPhrase:`in ${MONTHS[prevM.getUTCMonth()]}`,
             vs:MONTHS[prevM.getUTCMonth()], nextLabel:'next month' };
  }

  const len = daysBetween(start, end);
  const prevEnd = ymd(addDays(new Date(start + 'T00:00:00Z'), -1));
  const prevStart = ymd(addDays(new Date(prevEnd + 'T00:00:00Z'), -(len - 1)));
  return { id:kind, start, end, prevStart, prevEnd, days:len, label, span, ...meta };
}

/* ---------------- live data for a period ---------------- */
async function gatherNumbers(client, period, io) {
  const out = { connected:{ analytics:false, search:false, leads:false }, notes:{} };
  const jobs = [];

  if (io.gaId) jobs.push((async () => {
    const M = ['activeUsers','sessions','screenPageViews','averageSessionDuration','engagementRate'];
    const totals = async (s, e) => {
      const j = await io.ga({ dateRanges:[{startDate:s, endDate:e}], metrics:M.map(name=>({name})) });
      const v = j.rows?.[0]?.metricValues || {};
      const o = {}; M.forEach((k,i)=> o[k] = Number(v[i]?.value || 0)); return o;
    };
    const series = async (s, e) => {
      const j = await io.ga({ dateRanges:[{startDate:s,endDate:e}], dimensions:[{name:'date'}],
        metrics:[{name:'activeUsers'}], limit:400, orderBys:[{dimension:{dimensionName:'date'}}] });
      return (j.rows || []).map(r => ({ date:r.dimensionValues[0].value, v:Number(r.metricValues[0].value) }));
    };
    const [tc, tp, sc, sp, ch, pg, dv] = await Promise.all([
      totals(period.start, period.end), totals(period.prevStart, period.prevEnd),
      series(period.start, period.end), series(period.prevStart, period.prevEnd),
      io.ga({ dateRanges:[{startDate:period.start,endDate:period.end}], dimensions:[{name:'sessionDefaultChannelGroup'}],
        metrics:[{name:'sessions'}], orderBys:[{metric:{metricName:'sessions'},desc:true}], limit:8 }),
      io.ga({ dateRanges:[{startDate:period.start,endDate:period.end}], dimensions:[{name:'pagePath'}],
        metrics:[{name:'screenPageViews'},{name:'activeUsers'},{name:'userEngagementDuration'}],
        orderBys:[{metric:{metricName:'screenPageViews'},desc:true}], limit:8 }),
      io.ga({ dateRanges:[{startDate:period.start,endDate:period.end}], dimensions:[{name:'deviceCategory'}],
        metrics:[{name:'sessions'}], orderBys:[{metric:{metricName:'sessions'},desc:true}] })
    ]);
    let key = null, keyPrev = null;
    try {
      const a = await io.ga({ dateRanges:[{startDate:period.start,endDate:period.end}], metrics:[{name:'keyEvents'}] });
      const b = await io.ga({ dateRanges:[{startDate:period.prevStart,endDate:period.prevEnd}], metrics:[{name:'keyEvents'}] });
      key = Number(a.rows?.[0]?.metricValues?.[0]?.value || 0);
      keyPrev = Number(b.rows?.[0]?.metricValues?.[0]?.value || 0);
    } catch (e) { /* older properties don't have key events */ }
    out.connected.analytics = true;
    out.visitors = { cur:Math.round(tc.activeUsers), prev:Math.round(tp.activeUsers) };
    out.visits   = { cur:Math.round(tc.sessions),    prev:Math.round(tp.sessions) };
    out.pageviews= { cur:Math.round(tc.screenPageViews), prev:Math.round(tp.screenPageViews) };
    out.visitLen = { cur:Math.round(tc.averageSessionDuration), prev:Math.round(tp.averageSessionDuration) };
    out.keyEvents= key === null ? null : { cur:key, prev:keyPrev };
    out.series   = sc;
    out.seriesPrev = sp;
    out.devices  = (dv.rows||[]).map(r=>({ name:r.dimensionValues[0].value, sessions:Number(r.metricValues[0].value) }));
    out.channels = (ch.rows||[]).map(r=>({ name:r.dimensionValues[0].value, sessions:Number(r.metricValues[0].value) }));
    out.pages    = (pg.rows||[]).map(r=>{ const u=Number(r.metricValues[1].value), e=Number(r.metricValues[2].value);
      return { path:r.dimensionValues[0].value, views:Number(r.metricValues[0].value), avgTime:u?e/u:0 }; });
  })().catch(e => out.notes.analytics = e.message));

  if (io.gscSite) jobs.push((async () => {
    const lagEnd = ymd(addDays(today(), -3));
    const end = period.end > lagEnd ? lagEnd : period.end;
    const q = (s, e, dims, n=25) => io.gsc({ startDate:s, endDate:e, dimensions:dims, rowLimit:n });
    const [tc, tp, qc, qp] = await Promise.all([
      q(period.start, end, [], 1), q(period.prevStart, period.prevEnd, [], 1),
      q(period.start, end, ['query'], 60), q(period.prevStart, period.prevEnd, ['query'], 60)
    ]);
    const tot = j => { const x = j.rows?.[0] || {}; return { clicks:x.clicks||0, impressions:x.impressions||0, ctr:x.ctr||0, position:x.position||0 }; };
    out.connected.search = true;
    out.searchThrough = end;
    const a = tot(tc), b = tot(tp);
    out.clicks = { cur:Math.round(a.clicks), prev:Math.round(b.clicks) };
    out.impressions = { cur:Math.round(a.impressions), prev:Math.round(b.impressions) };
    out.position = { cur:+a.position.toFixed(1), prev:+b.position.toFixed(1) };
    out.queries = (qc.rows||[]).map(r=>({ q:r.keys[0], clicks:r.clicks, impressions:r.impressions, position:r.position }));
    out.queriesPrev = (qp.rows||[]).map(r=>({ q:r.keys[0], clicks:r.clicks, impressions:r.impressions, position:r.position }));
  })().catch(e => out.notes.search = e.message));

  if (io.netlifySite) jobs.push(io.leads(period)
    .then(v => { out.connected.leads = true; out.leads = v.count; out.leadItems = v.items; })
    .catch(e => out.notes.leads = e.message));

  await Promise.all(jobs);
  return out;
}

/* ---------------- sorting the work into themes ---------------- */
const THEMES = [
  { b:'Made it easier to get in touch', c:'var(--blue)',
    k:['form','call','quote','cta','button','contact','book','phone','chat','enquir','inquir','lead'] },
  { b:'Helped Google find you', c:'var(--cyan)',
    k:['google','seo','index','keyword','meta','sitemap','schema','business profile','review','blog','content','location','wrote','publish','search','rank','title tag','alt text'] },
  { b:'Made the site faster', c:'var(--violet)',
    k:['speed','load','compress','image','photo','performance','cache','faster','optimis','optimiz','core web'] },
  { b:'Design and content updates', c:'var(--green)', k:['design','copy','page','layout','photo','brand','colour','color','font','menu','navigation','rewrote','redesign'] },
  { b:'Other work', c:'var(--amber)', k:[] }
];
function tidy(line) {
  let l = line
    .replace(/^\s*(we|i)\s+/i, '')                         // "We added…" -> "Added…"
    .replace(/^\s*(just|also|then|finally)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;,]+$/, '')
    .trim();
  if (!l) return '';
  return l.charAt(0).toUpperCase() + l.slice(1);
}
function groupWork(text) {
  const lines = String(text || '').split('\n')
    .map(l => l.replace(/^\s*[-*•\d.)]+\s*/, '').replace(/^\s*\w{3,9}\s+\d{1,2}\s*[:–—-]\s*/, '').trim())
    .map(tidy)
    .filter(Boolean);
  const groups = THEMES.map(t => ({ b:t.b, c:t.c, items:[] }));
  lines.forEach(l => {
    const low = l.toLowerCase();
    let i = THEMES.findIndex(t => t.k.length && t.k.some(k => low.includes(k)));
    if (i < 0) i = THEMES.length - 1;
    groups[i].items.push(l);
  });
  return groups.filter(g => g.items.length);
}

/* ---------------- the narrative, built from the numbers ---------------- */
const pct = (c, p) => (p ? Math.round((c - p) / p * 100) : null);
const mmss = s => s >= 60 ? `${Math.floor(s/60)}m ${String(Math.round(s%60)).padStart(2,'0')}s` : `${Math.round(s)}s`;

function analyseKeywords(n) {
  if (!n.queries) return null;
  const prevBy = Object.fromEntries((n.queriesPrev || []).map(q => [q.q, q]));
  const rows = n.queries.map(q => {
    const b = prevBy[q.q];
    return { ...q, before: b ? b.position : null, move: b ? +(b.position - q.position).toFixed(1) : null, isNew: !b };
  });
  return {
    top: rows.slice().sort((a,b)=> b.clicks - a.clicks || a.position - b.position).slice(0, 12),
    risers: rows.filter(r => r.move !== null && r.move >= 1 && r.impressions >= 20)
               .sort((a,b)=> b.move - a.move).slice(0, 6),
    fresh: rows.filter(r => r.isNew && r.impressions >= 20)
               .sort((a,b)=> b.impressions - a.impressions).slice(0, 6),
    pageOne: rows.filter(r => r.position <= 10).length,
    pageOnePrev: (n.queriesPrev || []).filter(r => r.position <= 10).length,
    total: rows.length,
    totalPrev: (n.queriesPrev || []).length
  };
}

function buildNarrative(n, period) {
  const moved = [], room = [], suggested = [];
  const kw = analyseKeywords(n);
  const highlights = [];
  const lead = n.leads || n.keyEvents;
  const leadWord = n.leads ? 'got in touch through the website' : 'completed an action on the site';

  // headline + opening
  let headline, summary;
  const lp = lead ? pct(lead.cur, lead.prev) : null;
  const vp = n.visitors ? pct(n.visitors.cur, n.visitors.prev) : null;
  if (lead && lp !== null && lp > 0) {
    headline = `More people got in touch ${period.phrase} than ${period.prevPhrase}.`;
  } else if (vp !== null && vp > 0) {
    headline = `More people found you ${period.phrase} than ${period.prevPhrase}.`;
  } else if (n.clicks && n.clicks.cur > n.clicks.prev) {
    headline = `More people reached you through Google ${period.phrase}.`;
  } else {
    headline = `Here's how your website has done ${period.phrase}.`;
  }
  const bits = [];
  if (lead) bits.push(`${lead.cur} people ${leadWord} ${period.phrase}` + (lead.prev ? `, ${lp >= 0 ? 'up' : 'down'} from ${lead.prev} ${period.prevPhrase}` : ''));
  if (n.visitors) bits.push(`${n.visitors.cur.toLocaleString()} people visited`);
  if (n.clicks) bits.push(`${n.clicks.cur.toLocaleString()} of them arrived from a Google search`);
  summary = bits.join('. ') + '.';

  // three quick wins at the top, each one true or it doesn't appear
  const hp = (c,p) => (p ? Math.round((c-p)/p*100) : null);
  if (lead && lead.prev && lead.cur > lead.prev)
    highlights.push({ icon:'up', big:`+${hp(lead.cur,lead.prev)}%`, label:'more enquiries than last period' });
  if (n.visitors && n.visitors.prev && n.visitors.cur > n.visitors.prev)
    highlights.push({ icon:'up', big:`+${hp(n.visitors.cur,n.visitors.prev)}%`, label:'more people visiting the site' });
  if (kw && kw.pageOne > kw.pageOnePrev)
    highlights.push({ icon:'search', big:`${kw.pageOne}`, label:`searches on page one, up from ${kw.pageOnePrev}` });
  if (kw && kw.fresh.length)
    highlights.push({ icon:'search', big:`${kw.fresh.length}`, label:'searches you now show up for that you didn\'t before' });
  if (n.clicks && n.clicks.prev && n.clicks.cur > n.clicks.prev)
    highlights.push({ icon:'up', big:`+${hp(n.clicks.cur,n.clicks.prev)}%`, label:'more clicks from Google' });
  if (n.visitLen && n.visitLen.prev && n.visitLen.cur > n.visitLen.prev)
    highlights.push({ icon:'up', big:mmss(n.visitLen.cur), label:`average visit, up from ${mmss(n.visitLen.prev)}` });

  // biggest faller, used to explain a drop rather than just report one
  let faller = null;
  if (n.queries && n.queriesPrev) {
    const nowBy = Object.fromEntries(n.queries.map(q => [q.q, q]));
    faller = n.queriesPrev
      .map(q => ({ ...q, after: nowBy[q.q] ? nowBy[q.q].position : null, lostClicks: q.clicks - (nowBy[q.q]?.clicks || 0) }))
      .filter(q => q.lostClicks >= 3 && (q.after === null || q.after - q.position >= 1.5))
      .sort((a, b) => b.lostClicks - a.lostClicks)[0] || null;
  }

  // what moved — only things the data actually shows
  if (n.queries && n.queriesPrev) {
    const prevBy = Object.fromEntries(n.queriesPrev.map(q => [q.q, q]));
    const risen = n.queries
      .map(q => ({ ...q, before: prevBy[q.q]?.position }))
      .filter(q => q.before && q.before - q.position >= 2 && q.impressions >= 40)
      .sort((a, b) => (b.before - b.position) - (a.before - a.position))[0];
    if (risen) moved.push({ icon:'search',
      title:`“${risen.q}” ${risen.position <= 10 && risen.before > 10 ? 'reached the first page' : 'moved up in Google'}`,
      body:`Position ${risen.before.toFixed(0)} to position ${risen.position.toFixed(0)}, and it brought ${Math.round(risen.clicks)} click${Math.round(risen.clicks)===1?'':'s'}.` });
  }
  if (lead && lead.prev && lead.cur > lead.prev) moved.push({ icon:'up',
    title:'More enquiries than the period before',
    body:`${lead.cur}, up from ${lead.prev}.` });
  if (n.clicks && n.clicks.prev && n.clicks.cur > n.clicks.prev) moved.push({ icon:'search',
    title:'More clicks from Google',
    body:`${n.clicks.cur.toLocaleString()}, up from ${n.clicks.prev.toLocaleString()} ${period.prevPhrase}.` });
  if (n.visitLen && n.visitLen.prev && n.visitLen.cur > n.visitLen.prev * 1.1) moved.push({ icon:'up',
    title:'Visitors are staying longer',
    body:`The average visit went from ${mmss(n.visitLen.prev)} to ${mmss(n.visitLen.cur)}.` });
  if (n.position && n.position.prev && n.position.prev - n.position.cur >= 0.5) moved.push({ icon:'up',
    title:'You rank higher on average',
    body:`Average position ${n.position.prev} to ${n.position.cur} across every search you appear in.` });
  // and the things that went the wrong way
  if (lead && lead.prev && lead.cur < lead.prev) {
    const visUp = n.visitors && n.visitors.prev && n.visitors.cur >= n.visitors.prev;
    moved.push({ icon:'down', down:true,
      title:'Fewer enquiries than the period before',
      body:`${lead.cur}, down from ${lead.prev}.`,
      why: visUp
        ? `Traffic didn't drop — ${n.visitors.cur.toLocaleString()} people still visited, up from ${n.visitors.prev.toLocaleString()}. So this is about what happens once they land, not about getting them there.`
        : (n.visitors && n.visitors.prev
            ? `Visits fell too, from ${n.visitors.prev.toLocaleString()} to ${n.visitors.cur.toLocaleString()}, so fewer people reached the site in the first place.`
            : `We can't see the cause from traffic alone yet.`),
      fix: visUp
        ? `We'll go through the path from landing to enquiry — where the form sits, how many fields it asks for, and how obvious the phone number is on a mobile.`
        : `We'll put the effort into traffic: the searches that already bring enquiries, and the pages that rank just below the first page.` });
  }
  if (n.clicks && n.clicks.prev && n.clicks.cur < n.clicks.prev * 0.9) {
    const impDown = n.impressions && n.impressions.prev && n.impressions.cur < n.impressions.prev * 0.95;
    const posWorse = n.position && n.position.prev && n.position.cur - n.position.prev >= 0.5;
    let why, fix;
    if (faller) {
      why = `Most of the difference is one search: “${faller.q}” brought ${Math.round(faller.clicks)} clicks ${period.prevPhrase} and `
          + (faller.after === null ? `doesn't appear at all now.` : `has slipped to position ${faller.after.toFixed(1)}.`);
      fix = `We'll work on the page behind “${faller.q}” — refreshing the content, tightening the title, and pointing internal links at it to win that position back.`;
    } else if (impDown) {
      why = `Google showed the site ${n.impressions.cur.toLocaleString()} times, down from ${n.impressions.prev.toLocaleString()}. Fewer appearances, not a drop in how many people clicked when they saw you — often seasonal demand.`;
      fix = `We'll widen the net: more pages aimed at the searches that already convert, so there are more chances to appear.`;
    } else if (posWorse) {
      why = `Your average position went from ${n.position.prev} to ${n.position.cur}. Slipping even a place or two costs a disproportionate share of clicks.`;
      fix = `We'll find which pages lost ground and strengthen them — content depth first, then internal links.`;
    } else {
      why = `Appearances held up, so people saw the site and chose something else in the results.`;
      fix = `We'll rewrite the titles and descriptions on the pages losing clicks so they match what people are actually searching for.`;
    }
    moved.push({ icon:'down', down:true, title:'Fewer clicks from Google',
      body:`${n.clicks.cur.toLocaleString()}, down from ${n.clicks.prev.toLocaleString()} ${period.prevPhrase}.`, why, fix });
  }

  // where we see room — real, findable problems
  if (n.queries) {
    const pageTwo = n.queries.filter(q => q.position > 10 && q.position <= 20 && q.impressions >= 100)
      .sort((a, b) => b.impressions - a.impressions)[0];
    if (pageTwo) {
      room.push({ title:`“${pageTwo.q}” is stuck on page two`,
        body:`You show up at position ${pageTwo.position.toFixed(1)} and were seen ${Math.round(pageTwo.impressions).toLocaleString()} times, but almost nobody scrolls past the first page.`,
        fix:`We'll build a page written specifically around this search and link to it from the pages Google already trusts.` });
      suggested.push(`Build out a page targeting “${pageTwo.q}”`);
    }
    const lowCtr = n.queries.filter(q => q.position <= 10 && q.impressions >= 200 && q.ctr < 0.02)
      .sort((a, b) => b.impressions - a.impressions)[0];
    if (lowCtr) {
      room.push({ title:`People see “${lowCtr.q}” but don't click`,
        body:`You're at position ${lowCtr.position.toFixed(1)} and were shown ${Math.round(lowCtr.impressions).toLocaleString()} times, yet almost nobody clicked.`,
        fix:`We'll rewrite the title and description for that page so it answers the search more directly.` });
      suggested.push(`Rewrite the page title and description for “${lowCtr.q}”`);
    }
  }
  if (n.pages) {
    const skim = n.pages.filter(p => p.views >= 50 && p.avgTime < 20)
      .sort((a, b) => b.views - a.views)[0];
    if (skim) room.push({ title:`${skim.path} gets traffic but people leave quickly`,
      body:`${Math.round(skim.views).toLocaleString()} views, with an average of ${mmss(skim.avgTime)} on the page.`,
      fix:`We'll look at what that page asks people to do and make the next step obvious.` });
  }
  if (!n.connected.search) room.push({ title:'Search Console isn\'t connected yet',
    body:'Without it we can\'t see which searches bring people to the site.',
    fix:'We\'ll connect it so next period\'s report includes the full search breakdown.' });

  if (!suggested.length) suggested.push('Keep publishing and building out the pages that are ranking');

  return { headline, summary, moved, room, suggested, highlights: highlights.slice(0, 3), keywords: kw };
}

/* ---------------- storage ---------------- */
function ensureDirs() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}
const safeId = s => String(s || '').replace(/[^\w-]/g, '');
const dirFor = c => path.join(REPORT_DIR, safeId(c));
const fileFor = (c, id) => path.join(dirFor(c), safeId(id) + '.json');

function listReports(clientId, publishedOnly) {
  ensureDirs();
  const dir = dirFor(clientId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { return null; } })
    .filter(r => r && (!publishedOnly || r.status === 'published'))
    .sort((a, b) => (b.period?.end || '').localeCompare(a.period?.end || '') || (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(r => ({ id:r.id, clientId:r.clientId, status:r.status, title:r.period?.label, span:r.period?.span,
                 createdAt:r.createdAt, publishedAt:r.publishedAt, headline:r.content?.headline }));
}
function getReport(clientId, id) {
  const f = fileFor(clientId, id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function saveReport(rep) {
  ensureDirs();
  fs.mkdirSync(dirFor(rep.clientId), { recursive: true });
  const tmp = fileFor(rep.clientId, rep.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rep, null, 2));
  fs.renameSync(tmp, fileFor(rep.clientId, rep.id));
  return rep;
}
function deleteReport(clientId, id) {
  const f = fileFor(clientId, id);
  if (fs.existsSync(f)) { fs.unlinkSync(f); return true; }
  return false;
}
const newId = () => new Date().toISOString().slice(0,10).replace(/-/g,'') + '-' + Math.random().toString(36).slice(2,7);

module.exports = { resolvePeriod, gatherNumbers, groupWork, buildNarrative, analyseKeywords,
  listReports, getReport, saveReport, deleteReport, newId, DATA_DIR, pct, mmss };
