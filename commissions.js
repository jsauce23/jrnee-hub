// Commission tracking for JRNEE's sales reps.
//
// A rep books an appointment and puts it on the board. If it closes, JRNEE
// marks it closed, and from that moment the rep is owed an upfront amount
// plus a monthly amount for as long as that business stays on the books.
//
// Commission is a flat figure per deal, not a share of what the client pays,
// so no client rate is ever stored here and a rep can never see one.
//
// Stored one JSON file per deal under DATA_DIR/deals/, the same pattern as
// leads.js: write to a temp file, then rename, so a crash mid-write cannot
// leave a half-written deal behind.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEAL_DIR = path.join(DATA_DIR, 'deals');

// What a rep earns when nothing more specific is set on them in reps.json.
const DEFAULT_RATES = { upfront: 1000, monthly: 500 };

const STAGES = ['booked', 'closed', 'lost'];

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const lines = (s, max) => String(s == null ? '' : s)
  .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// Accepts "2026-11-04" or "2026-11-04T15:00". Anything unparseable becomes ''
// rather than today, because a wrong date here is worse than a missing one.
function when(v) {
  const s = clean(v, 40);
  if (!s) return '';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00' : s);
  return isNaN(d) ? '' : d.toISOString();
}

function rates(rep) {
  const r = (rep && rep.rates) || {};
  const n = (v, d) => (Number.isFinite(+v) && +v >= 0 ? Math.round(+v) : d);
  return { upfront: n(r.upfront, DEFAULT_RATES.upfront), monthly: n(r.monthly, DEFAULT_RATES.monthly) };
}

/* ---------------- the records ---------------- */

function normalise(d) {
  return {
    business: clean(d.business || d.company, 160),
    contact:  clean(d.contact || d.name, 120),
    phone:    clean(d.phone, 40),
    email:    clean(d.email, 160).toLowerCase(),
    apptAt:   when(d.apptAt || d.appointment),
    notes:    lines(d.notes, 2000)
  };
}

// Enough to be worth putting on the board: who it is and when you're seeing them.
function problemWith(deal) {
  if (!deal.business) return 'Which business is it?';
  if (!deal.apptAt) return 'Add the date of the appointment.';
  return null;
}

function fileFor(id) {
  return path.join(DEAL_DIR, path.basename(String(id)) + '.json');
}

function writeRec(rec) {
  fs.mkdirSync(DEAL_DIR, { recursive: true });
  const file = fileFor(rec.id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
  return rec;
}

function create(repId, deal) {
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  return writeRec({
    id, repId: clean(repId, 40),
    ...deal,
    stage: 'booked',
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    closedAt: null, endedAt: null, lostReason: ''
  });
}

function get(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function list(repId) {
  if (!fs.existsSync(DEAL_DIR)) return [];
  const all = fs.readdirSync(DEAL_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DEAL_DIR, f), 'utf8')); }
                catch (e) { return null; } })
    .filter(Boolean);
  return repId ? all.filter(d => d.repId === repId) : all;
}

// A rep may correct the details of an appointment they have not had yet.
// Once it is closed the record is part of what they are owed, so it locks.
function edit(id, deal) {
  const rec = get(id);
  if (!rec) return null;
  if (rec.stage !== 'booked') return { locked: true };
  return writeRec({ ...rec, ...deal, updatedAt: new Date().toISOString() });
}

// Only JRNEE moves a deal's stage.
function setStage(id, stage, opts = {}) {
  const rec = get(id);
  if (!rec) return null;
  if (!STAGES.includes(stage)) return null;
  const now = new Date().toISOString();
  const next = { ...rec, stage, updatedAt: now };

  if (stage === 'closed') {
    // Re-closing an already closed deal must not reset the clock on it.
    next.closedAt = when(opts.closedAt) || rec.closedAt || now;
    next.endedAt = null;
    next.lostReason = '';
  } else if (stage === 'lost') {
    next.lostReason = clean(opts.reason, 200);
    next.closedAt = null; next.endedAt = null;
  } else {
    next.closedAt = null; next.endedAt = null; next.lostReason = '';
  }
  return writeRec(next);
}

// A closed client coming off the books: the recurring stops on that date, and
// everything earned up to it stays earned.
function setEnded(id, endedAt) {
  const rec = get(id);
  if (!rec || rec.stage !== 'closed') return null;
  return writeRec({ ...rec, endedAt: endedAt === null ? null : (when(endedAt) || new Date().toISOString()),
                    updatedAt: new Date().toISOString() });
}

function remove(id) {
  const file = fileFor(id);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/* ---------------- what it adds up to ---------------- */

// Whole months between two instants. The first monthly payment falls due one
// month after the close, so a deal closed on the 4th pays again on the 4th.
// Short months clamp: close on the 31st, pay on the 28th/30th.
function wholeMonths(from, to) {
  const a = new Date(from), b = new Date(to);
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  let n = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  const anniversary = new Date(Date.UTC(
    a.getUTCFullYear(), a.getUTCMonth() + n,
    Math.min(a.getUTCDate(), daysInMonth(a.getUTCFullYear(), a.getUTCMonth() + n)),
    a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds()
  ));
  if (anniversary > b) n -= 1;
  return Math.max(0, n);
}
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function nextPaymentAt(closedAt, paid) {
  const a = new Date(closedAt);
  if (isNaN(a)) return null;
  const n = paid + 1;
  return new Date(Date.UTC(
    a.getUTCFullYear(), a.getUTCMonth() + n,
    Math.min(a.getUTCDate(), daysInMonth(a.getUTCFullYear(), a.getUTCMonth() + n)),
    a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds()
  )).toISOString();
}

// Everything a single deal has earned, as of `now`.
function earnings(deal, rate, now = new Date()) {
  if (deal.stage !== 'closed' || !deal.closedAt) {
    return { upfront: 0, monthsPaid: 0, recurring: 0, total: 0, active: false, nextAt: null };
  }
  const until = deal.endedAt ? new Date(deal.endedAt) : now;
  const monthsPaid = wholeMonths(deal.closedAt, until < now ? until : now);
  const active = !deal.endedAt;
  return {
    upfront: rate.upfront,
    monthsPaid,
    recurring: monthsPaid * rate.monthly,
    total: rate.upfront + monthsPaid * rate.monthly,
    active,
    nextAt: active ? nextPaymentAt(deal.closedAt, monthsPaid) : null
  };
}

// One rep's board and their numbers.
function summary(rep, deals, now = new Date()) {
  const rate = rates(rep);
  const rows = deals.map(d => ({ ...d, earned: earnings(d, rate, now) }));
  const closed = rows.filter(d => d.stage === 'closed');
  const onBooks = closed.filter(d => d.earned.active);
  return {
    rate,
    deals: rows,
    counts: {
      booked: rows.filter(d => d.stage === 'booked').length,
      closed: closed.length,
      lost:   rows.filter(d => d.stage === 'lost').length,
      onBooks: onBooks.length
    },
    totals: {
      earned:  rows.reduce((n, d) => n + d.earned.total, 0),
      upfront: rows.reduce((n, d) => n + d.earned.upfront, 0),
      recurring: rows.reduce((n, d) => n + d.earned.recurring, 0),
      monthly: onBooks.length * rate.monthly       // what next month looks like
    }
  };
}

module.exports = {
  normalise, problemWith, create, get, list, edit, setStage, setEnded, remove,
  earnings, summary, rates, wholeMonths, nextPaymentAt,
  DEFAULT_RATES, STAGES, DEAL_DIR
};
