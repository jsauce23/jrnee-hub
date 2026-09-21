// JRNEE Website Hub — private back office.
// Runs as a Render Web Service. No npm packages needed.
//
// Environment variables (set in Render → Environment):
//   ADMIN_PASSWORD          your JRNEE password — opens the full client list
//   CLIENT_PASSWORDS        one password per client, e.g.  marco:Marco1234, nextclient:TheirPass
//   SESSION_SECRET          any long random string (keeps you logged in across restarts)
//   GOOGLE_SERVICE_ACCOUNT  the whole Google service-account JSON key, pasted in
//   NETLIFY_TOKEN           a Netlify personal access token (for form leads)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || '';
const SESSION_HOURS = 12;

const CLIENTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients.json'), 'utf8'));
const APP = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
const LOGIN = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
const SA = loadServiceAccount();
const CLIENT_PW = loadClientPasswords();

function loadClientPasswords() {
  const raw = (process.env.CLIENT_PASSWORDS || '').trim();
  const map = {};
  if (!raw) return map;
  if (raw.startsWith('{')) {
    try { Object.assign(map, JSON.parse(raw)); } catch (e) { console.error('CLIENT_PASSWORDS is not valid JSON'); }
  } else {
    raw.split(/[\n,]+/).forEach(pair => {
      const i = pair.indexOf(':');
      if (i > 0) { const id = pair.slice(0, i).trim(), pw = pair.slice(i + 1).trim(); if (id && pw) map[id] = pw; }
    });
  }
  Object.keys(map).forEach(id => { if (!CLIENTS.some(c => c.id === id)) console.error(`CLIENT_PASSWORDS has "${id}" but clients.json has no client with that id`); });
  return map;
}

function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(txt);
    if (j.private_key) j.private_key = j.private_key.replace(/\\n/g, '\n');
    if (!j.client_email || !j.private_key) throw new Error('missing fields');
    return j;
  } catch (e) {
    console.error('GOOGLE_SERVICE_ACCOUNT could not be read — paste the full JSON key file contents.');
    return null;
  }
}

/* ---------------- sessions ---------------- */
const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
// session = expiry . role . random . signature   (role is "admin" or "c:<clientId>")
function makeSession(role) {
  const v = String(Date.now() + SESSION_HOURS * 3600e3) + '.' + role + '.' + crypto.randomBytes(8).toString('hex');
  return v + '.' + sign(v);
}
function sessionRole(tok) {
  if (!tok) return null;
  const i = tok.lastIndexOf('.');
  if (i < 0) return null;
  const v = tok.slice(0, i), s = tok.slice(i + 1), good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  const [exp, role] = v.split('.');
  if (!(Number(exp) > Date.now())) return null;
  if (role === 'admin') return role;
  if (role && role.startsWith('c:')) {
    const id = role.slice(2);
    if (CLIENTS.some(c => c.id === id) && CLIENT_PW[id]) return role;   // password removed = locked out
  }
  return null;
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
const sha = x => crypto.createHash('sha256').update(String(x)).digest();
function roleForPassword(p) {
  const h = sha(p);
  let role = null;
  if (ADMIN_PASSWORD && crypto.timingSafeEqual(h, sha(ADMIN_PASSWORD))) role = 'admin';
  // check every client, even after a match, so response time doesn't reveal anything
  for (const [id, pw] of Object.entries(CLIENT_PW)) {
    if (!/^[\w-]+$/.test(id) || !CLIENTS.some(c => c.id === id)) continue;
    if (crypto.timingSafeEqual(h, sha(pw)) && !role) role = 'c:' + id;
  }
  return role;
}

/* login throttling: 10 wrong tries per 15 minutes per address */
const tries = new Map();
function attempts(ip) {
  const now = Date.now();
  const r = tries.get(ip) || { n: 0, t: now };
  if (now - r.t > 15 * 60e3) { r.n = 0; r.t = now; }
  tries.set(ip, r);
  if (tries.size > 5000) tries.clear();
  return r;
}

/* ---------------- Google auth (service account, signed JWT) ---------------- */
let gTok = null, gExp = 0;
const b64u = s => Buffer.from(s).toString('base64url');
async function readJson(r) { const t = await r.text(); try { return JSON.parse(t); } catch (e) { return { error: { message: 'Unexpected response (' + r.status + ')' } }; } }
async function googleToken() {
  try { return await googleTokenInner(); } catch (e) { throw new Error(/fetch failed/i.test(e.message) ? 'Could not reach Google. Try again in a minute.' : e.message); }
}
async function googleTokenInner() {
  if (!SA) throw new Error('Google is not connected on the server yet.');
  if (gTok && Date.now() < gExp - 60e3) return gTok;
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({
    iss: SA.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(head + '.' + claim);
  const sig = signer.sign(SA.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig })
  });
  const j = await readJson(r);
  if (!r.ok) throw new Error('Google sign-in failed: ' + (j.error_description || (j.error && (j.error.message || j.error)) || r.status));
  gTok = j.access_token;
  gExp = Date.now() + j.expires_in * 1000;
  return gTok;
}

/* ---------------- Google Analytics 4 ---------------- */
async function ga(prop, body) {
  const t = await googleToken();
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await readJson(r);
  if (!r.ok) throw new Error(friendlyGoogleError(j, 'Google Analytics'));
  return j;
}
function ranges(n) {
  return {
    cur: { startDate: `${n}daysAgo`, endDate: 'yesterday' },
    prev: { startDate: `${2 * n}daysAgo`, endDate: `${n + 1}daysAgo` }
  };
}
const num = x => Number(x || 0);

async function gaReport(prop, n) {
  const { cur, prev } = ranges(n);
  const M = ['activeUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate'];
  const totals = async dr => {
    const j = await ga(prop, { dateRanges: [dr], metrics: M.map(name => ({ name })) });
    const v = j.rows?.[0]?.metricValues || [];
    const o = {}; M.forEach((k, i) => o[k] = num(v[i]?.value)); return o;
  };
  const series = async dr => {
    const j = await ga(prop, { dateRanges: [dr], dimensions: [{ name: 'nthDay' }], metrics: [{ name: 'activeUsers' }], limit: 1000 });
    const a = new Array(n).fill(0);
    (j.rows || []).forEach(r => { const i = parseInt(r.dimensionValues[0].value, 10); if (i >= 0 && i < n) a[i] = num(r.metricValues[0].value); });
    return a;
  };
  const keyEvents = async dr => {
    try {
      const j = await ga(prop, { dateRanges: [dr], metrics: [{ name: 'keyEvents' }] });
      return num(j.rows?.[0]?.metricValues?.[0]?.value);
    } catch (e) { return null; }
  };
  const [tc, tp, sc, sp, kc, kp, ch, pg, dv] = await Promise.all([
    totals(cur), totals(prev), series(cur), series(prev), keyEvents(cur), keyEvents(prev),
    ga(prop, { dateRanges: [cur], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
    ga(prop, { dateRanges: [cur], dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'userEngagementDuration' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 10 }),
    ga(prop, { dateRanges: [cur], dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] })
  ]);
  return {
    totals: { cur: tc, prev: tp },
    series: { cur: sc, prev: sp },
    keyEvents: { cur: kc, prev: kp },
    channels: (ch.rows || []).map(r => ({ name: r.dimensionValues[0].value, sessions: num(r.metricValues[0].value) })),
    pages: (pg.rows || []).map(r => {
      const users = num(r.metricValues[1].value), eng = num(r.metricValues[2].value);
      return { path: r.dimensionValues[0].value, views: num(r.metricValues[0].value), avgTime: users ? eng / users : 0 };
    }),
    devices: (dv.rows || []).map(r => ({ name: r.dimensionValues[0].value, sessions: num(r.metricValues[0].value) }))
  };
}

/* ---------------- Search Console ---------------- */
async function gsc(site, body) {
  const t = await googleToken();
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await readJson(r);
  if (!r.ok) throw new Error(friendlyGoogleError(j, 'Search Console'));
  return j;
}
const ymd = d => d.toISOString().slice(0, 10);
function daysAgo(k) { const d = new Date(); d.setUTCDate(d.getUTCDate() - k); return ymd(d); }

async function gscReport(site, n) {
  const lag = 3; // Search Console data trails real time by 2–3 days
  const cur = { startDate: daysAgo(lag + n - 1), endDate: daysAgo(lag) };
  const prev = { startDate: daysAgo(lag + 2 * n - 1), endDate: daysAgo(lag + n) };
  const totals = async r => {
    const j = await gsc(site, { ...r, rowLimit: 1 });
    const x = j.rows?.[0] || {};
    return { clicks: x.clicks || 0, impressions: x.impressions || 0, ctr: x.ctr || 0, position: x.position || 0 };
  };
  const [tc, tp, q, p] = await Promise.all([
    totals(cur), totals(prev),
    gsc(site, { ...cur, dimensions: ['query'], rowLimit: 10 }),
    gsc(site, { ...cur, dimensions: ['page'], rowLimit: 8 })
  ]);
  return {
    range: cur,
    totals: { cur: tc, prev: tp },
    queries: (q.rows || []).map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    pages: (p.rows || []).map(r => ({ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }))
  };
}

function friendlyGoogleError(j, product) {
  const m = (j.error && j.error.message) || '';
  if (/permission|PERMISSION_DENIED|User does not have/i.test(m))
    return `${product} hasn't given the hub access yet. Add the hub's service-account email as a viewer on this site.`;
  if (/not found|NOT_FOUND/i.test(m)) return `${product} can't find that property. Check the ID in clients.json.`;
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(m)) return `The ${product} API is switched off in Google Cloud. Enable it and try again.`;
  return `${product}: ${m || 'request failed'}`;
}

/* ---------------- Netlify form leads ---------------- */
async function netlifyLeads(siteId, n) {
  if (!NETLIFY_TOKEN) throw new Error('Netlify is not connected on the server yet.');
  const since = Date.now() - 2 * n * 864e5;
  let all = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/submissions?per_page=100&page=${page}`,
      { headers: { Authorization: 'Bearer ' + NETLIFY_TOKEN } });
    if (r.status === 401) throw new Error('The Netlify token was rejected. Create a new one and update NETLIFY_TOKEN.');
    if (r.status === 404) throw new Error("Netlify can't find that site. Check the site ID in clients.json.");
    if (!r.ok) throw new Error('Netlify request failed (' + r.status + ').');
    const a = await r.json();
    all = all.concat(a);
    if (a.length < 100 || new Date(a[a.length - 1].created_at).getTime() < since) break;
  }
  const cutoff = Date.now() - n * 864e5;
  const t = s => new Date(s.created_at).getTime();
  const cur = all.filter(s => t(s) >= cutoff);
  const prev = all.filter(s => t(s) < cutoff && t(s) >= since);
  return {
    count: { cur: cur.length, prev: prev.length },
    leads: cur.slice(0, 50).map(s => {
      const d = s.data || {};
      return {
        id: s.id,
        when: s.created_at,
        form: s.form_name || '',
        name: d.name || [d.first_name, d.last_name].filter(Boolean).join(' ') || s.name || '',
        email: d.email || s.email || '',
        phone: d.phone || d.telephone || d.tel || '',
        message: d.message || d.comments || d.details || s.summary || ''
      };
    })
  };
}

/* ---------------- report assembly + cache ---------------- */
const publicClient = c => ({ id: c.id, name: c.name, legal: c.legal || c.name, domain: c.domain || '', initials: c.initials || c.name.slice(0, 2).toUpperCase(), status: c.status || '' });
const gaId = c => String(c.ga4PropertyId || '').replace(/\D/g, '');

async function buildReport(c, n) {
  const out = { client: publicClient(c), days: n, generated: new Date().toISOString(), ga: null, gsc: null, leads: null, errors: {} };
  const jobs = [];
  if (gaId(c)) jobs.push(gaReport(gaId(c), n).then(v => out.ga = v, e => out.errors.ga = e.message)); else out.errors.ga = 'not_connected';
  if (c.gscSiteUrl) jobs.push(gscReport(c.gscSiteUrl, n).then(v => out.gsc = v, e => out.errors.gsc = e.message)); else out.errors.gsc = 'not_connected';
  if (c.netlifySiteId) jobs.push(netlifyLeads(c.netlifySiteId, n).then(v => out.leads = v, e => out.errors.leads = e.message)); else out.errors.leads = 'not_connected';
  await Promise.all(jobs);
  return out;
}

async function summary(c, n = 28) {
  const o = { visitors: null, prevVisitors: null, leads: null, prevLeads: null, problems: [],
    connected: { ga: !!gaId(c), gsc: !!c.gscSiteUrl, netlify: !!c.netlifySiteId } };
  const jobs = [];
  if (gaId(c)) jobs.push((async () => {
    const { cur, prev } = ranges(n);
    const q = dr => ga(gaId(c), { dateRanges: [dr], metrics: [{ name: 'activeUsers' }] }).then(j => num(j.rows?.[0]?.metricValues?.[0]?.value));
    [o.visitors, o.prevVisitors] = await Promise.all([q(cur), q(prev)]);
  })().catch(e => o.problems.push(e.message)));
  if (c.netlifySiteId) jobs.push(netlifyLeads(c.netlifySiteId, n)
    .then(v => { o.leads = v.count.cur; o.prevLeads = v.count.prev; })
    .catch(e => o.problems.push(e.message)));
  await Promise.all(jobs);
  return o;
}

const cache = new Map();
const TTL = 10 * 60e3;
async function cached(key, fn, fresh) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.t < TTL) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

/* ---------------- http ---------------- */
function headers(res) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
}
const send = (res, code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const html = (res, code, body) => send(res, code, 'text/html; charset=utf-8', body);
const json = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > limit) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}
const loginPage = msg => LOGIN.replace('<!--MSG-->', msg ? `<p class="err">${msg}</p>` : '');

http.createServer(async (req, res) => {
  headers(res);
  const u = new URL(req.url, 'http://local');
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  try {
    if (u.pathname === '/health') return send(res, 200, 'text/plain', 'ok');

    if (u.pathname === '/login' && req.method === 'POST') {
      const a = attempts(ip);
      if (a.n >= 10) return html(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'));
      const b = new URLSearchParams(await readBody(req));
      const role = roleForPassword(b.get('password') || '');
      if (role) {
        tries.delete(ip);
        res.writeHead(303, {
          'Set-Cookie': `jh=${makeSession(role)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`,
          Location: '/'
        });
        return res.end();
      }
      a.n++;
      await sleep(700);
      return html(res, 401, loginPage('That password isn&rsquo;t right.'));
    }

    if (u.pathname === '/logout') {
      res.writeHead(303, { 'Set-Cookie': 'jh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0', Location: '/' });
      return res.end();
    }

    const role = sessionRole(cookies(req).jh);
    if (!role) {
      if (u.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      return html(res, 200, loginPage(ADMIN_PASSWORD ? '' : 'ADMIN_PASSWORD is not set on the server yet.'));
    }
    const isAdmin = role === 'admin';
    const ownId = isAdmin ? null : role.slice(2);

    if (u.pathname === '/' || u.pathname === '/index.html') {
      const own = ownId && CLIENTS.find(c => c.id === ownId);
      const hub = isAdmin ? { role: 'admin' } : { role: 'client', id: ownId, name: own ? own.name : '' };
      return html(res, 200, APP.replace('__HUB__', JSON.stringify(hub).replace(/</g, '\u003c')));
    }

    if (u.pathname === '/api/clients') {
      if (!isAdmin) return json(res, 403, { error: 'Not allowed.' });
      const fresh = u.searchParams.has('refresh');
      const list = await Promise.all(CLIENTS.map(c => cached('s:' + c.id, () => summary(c), fresh)));
      return json(res, 200, {
        clients: CLIENTS.map((c, i) => ({ ...publicClient(c), ...list[i] })),
        config: { google: !!SA, netlify: !!NETLIFY_TOKEN, serviceAccount: SA ? SA.client_email : null }
      });
    }

    if (u.pathname === '/api/report') {
      let id = u.searchParams.get('c');
      if (!isAdmin) {
        if (id && id !== ownId) return json(res, 403, { error: 'Not allowed.' });   // a client can only ever see their own report
        id = ownId;
      }
      const c = CLIENTS.find(x => x.id === id);
      if (!c) return json(res, 404, { error: 'That client isn’t in clients.json.' });
      let n = parseInt(u.searchParams.get('days'), 10);
      if (![7, 28, 90].includes(n)) n = 28;
      const r = await cached(`r:${c.id}:${n}`, () => buildReport(c, n), u.searchParams.has('refresh'));
      return json(res, 200, r);
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, () => console.log('JRNEE Hub listening on ' + PORT));
