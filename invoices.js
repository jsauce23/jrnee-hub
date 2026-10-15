// Invoicing — JRNEE Technologies LLC.
//
// One invoice per client per month. The number is allocated once and then stays
// with that client/month forever, so hitting "generate" twice never burns a
// second number or sends a client two invoices for the same bill.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INV_DIR = path.join(DATA_DIR, 'invoices');
const COUNTER = path.join(INV_DIR, '_counter.json');

const FIRST_NUMBER = parseInt(process.env.INVOICE_START || '25305', 10);
// Unset by default: the standing rule is "end of the month after the one billed",
// not a fixed number of days. Set this only to force day-count terms everywhere.
const TERMS_DAYS = process.env.INVOICE_TERMS_DAYS != null && process.env.INVOICE_TERMS_DAYS !== ''
  ? parseInt(process.env.INVOICE_TERMS_DAYS, 10)
  : null;

/* ---------------- who we are ---------------- */
const FROM = {
  legal:  process.env.BILL_FROM_NAME  || 'JRNEE Technologies LLC',
  brand:  'JRNEE.ai',
  email:  process.env.BILL_FROM_EMAIL || 'hello@jrnee.ai',
  site:   'jrnee.ai',
  line1:  process.env.BILL_FROM_LINE1 || 'San Antonio, TX',
  phone:  process.env.BILL_FROM_PHONE || '',
  payTo:  process.env.BILL_PAY_TO     || 'JRNEE Technologies LLC',
  payNote: process.env.BILL_PAY_NOTE  || 'Check, ACH or card. Reply to this invoice for payment details.'
};

/* ---------------- dates and money ---------------- */
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const pad = n => String(n).padStart(2, '0');

/** "2026-10" for right now, in US Central, which is where the business is. */
function currentMonth() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function monthParts(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error('Pick a valid month.');
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    y, m,
    label: `${MONTHS[m - 1]} ${y}`,
    short: `${MONTHS[m - 1].slice(0, 3)} ${y}`,
    first: `${y}-${pad(m)}-01`,
    last:  `${y}-${pad(m)}-${pad(last)}`
  };
}

const prettyDate = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

/**
 * The last day of the month AFTER the one being billed — bill 2026-10 and this
 * gives 2026-11-30. Rolls the year over on its own, so billing December lands
 * on January 31 of the next year.
 */
function endOfFollowingMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(Date.UTC(y, m + 1, 0));   // day 0 of month+2 = last day of month+1
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const money = n => Number(n || 0).toLocaleString('en-US',
  { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

/* ---------------- billing setup per client ---------------- */
/**
 * A client is billable when clients.json gives it a `billing` block:
 *   "billing": { "monthly": 4000, "description": "Website maintenance / development" }
 * Anything without one is simply skipped — no invoice, no error.
 */
function billingFor(c) {
  const b = c.billing;
  if (!b) return null;
  const amount = Number(b.monthly != null ? b.monthly : b.amount);
  if (!amount || amount <= 0) return null;
  // Two ways a due date gets set:
  //
  //   eofm  (the standing rule) — the end of the month AFTER the one being
  //         billed. Bill October, they have until November 30.
  //   days  — a plain number of days from the issue date. Set `termsDays` on
  //         the client to use it; 0 means due the day it's issued, which is
  //         the 1st of the month billed, for anyone who pays up front.
  //
  // `terms` overrides the wording printed under the due date.
  const hasDays = b.termsDays != null || TERMS_DAYS != null;
  const days = b.termsDays != null ? Number(b.termsDays) : TERMS_DAYS;
  const mode = hasDays ? 'days' : 'eofm';
  const auto = mode === 'eofm'
    ? 'End of following month'
    : (days <= 0 ? 'Due on receipt' : `Net ${days}`);

  return {
    amount,
    description: b.description || 'Website maintenance / development',
    detail: b.detail || null,
    poNumber: b.poNumber || null,
    billTo: b.billTo || null,
    termsMode: mode,
    terms: hasDays ? days : null,
    termsLabel: b.terms || auto
  };
}

const billableClients = clients => clients.filter(c => billingFor(c));

/* ---------------- storage ---------------- */
const safe = s => String(s || '').replace(/[^\w-]/g, '');
const ensure = () => fs.mkdirSync(INV_DIR, { recursive: true });
const fileFor = (clientId, month) => path.join(INV_DIR, `${safe(clientId)}--${safe(month)}.json`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/** Allocates the next number. Only ever called when an invoice genuinely needs one. */
function takeNumber() {
  ensure();
  const c = readJson(COUNTER, null);
  const next = (c && Number(c.next)) || FIRST_NUMBER;
  writeJson(COUNTER, { next: next + 1, updatedAt: new Date().toISOString() });
  return next;
}

/** What the counter would hand out next, without consuming it. */
function peekNumber() {
  const c = readJson(COUNTER, null);
  return (c && Number(c.next)) || FIRST_NUMBER;
}

function getInvoice(clientId, month) {
  return readJson(fileFor(clientId, month), null);
}

function saveInvoice(inv) {
  ensure();
  inv.savedAt = new Date().toISOString();
  writeJson(fileFor(inv.clientId, inv.month), inv);
  return inv;
}

function deleteInvoice(clientId, month) {
  const f = fileFor(clientId, month);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

/* ---------------- building one ---------------- */
const dueDateFor = (month, issued, bill) =>
  bill.termsMode === 'days' ? addDays(issued, bill.terms) : endOfFollowingMonth(month);

function build(client, month, opts) {
  const bill = billingFor(client);
  if (!bill) throw new Error(`${client.name} has no monthly amount set in clients.json.`);

  const existing = getInvoice(client.id, month);
  if (existing && !(opts && opts.rebuild)) {
    // Terms are a standing business decision, so if they've changed since this
    // invoice was generated, bring it up to date. The number, issue date and
    // paid status are its identity — those stay.
    const due = dueDateFor(month, existing.issuedOn, bill);
    if (existing.dueOn !== due || existing.termsLabel !== bill.termsLabel) {
      existing.termsMode = bill.termsMode;
      existing.termsDays = bill.terms;
      existing.termsLabel = bill.termsLabel;
      existing.dueOn = due;
      saveInvoice(existing);
    }
    return { invoice: existing, created: false };
  }

  const mp = monthParts(month);
  // Issued on the first of the month being billed, unless that's still ahead of us.
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const issued = mp.first > todayIso ? mp.first : (existing ? existing.issuedOn : mp.first);

  const number = existing ? existing.number : takeNumber();

  const lines = [{
    description: bill.description,
    detail: bill.detail || `${mp.label} — ${client.domain || client.name}`,
    period: mp.label,
    qty: 1,
    rate: bill.amount,
    amount: bill.amount
  }];
  const subtotal = lines.reduce((t, l) => t + l.amount, 0);

  const inv = {
    id: `${client.id}--${month}`,
    number,
    clientId: client.id,
    month,
    monthLabel: mp.label,
    periodStart: mp.first,
    periodEnd: mp.last,
    issuedOn: issued,
    dueOn: dueDateFor(month, issued, bill),
    termsMode: bill.termsMode,
    termsDays: bill.terms,
    termsLabel: bill.termsLabel,
    status: existing ? existing.status : 'open',
    from: { ...FROM },
    billTo: {
      name: bill.billTo || client.legal || client.name,
      domain: client.domain || '',
      initials: client.initials || client.name.slice(0, 2).toUpperCase()
    },
    poNumber: bill.poNumber,
    lines,
    subtotal,
    total: subtotal,
    currency: 'USD',
    createdAt: existing ? existing.createdAt : new Date().toISOString()
  };

  saveInvoice(inv);
  return { invoice: inv, created: !existing };
}

/** Every billable client for a month, creating what doesn't exist yet. */
function buildAll(clients, month, opts) {
  const out = { month, created: [], existing: [], skipped: [] };
  billableClients(clients).forEach(c => {
    try {
      const r = build(c, month, opts);
      (r.created ? out.created : out.existing).push(r.invoice);
    } catch (e) {
      out.skipped.push({ client: c.name, reason: e.message });
    }
  });
  clients.filter(c => !billingFor(c)).forEach(c =>
    out.skipped.push({ client: c.name, reason: 'No monthly amount set' }));
  return out;
}

/* ---------------- listing ---------------- */
function listMonth(clients, month) {
  return billableClients(clients).map(c => {
    const inv = getInvoice(c.id, month);
    const bill = billingFor(c);
    return {
      clientId: c.id,
      clientName: c.name,
      legal: c.legal || c.name,
      initials: c.initials || c.name.slice(0, 2).toUpperCase(),
      domain: c.domain || '',
      amount: bill.amount,
      description: bill.description,
      exists: !!inv,
      number: inv ? inv.number : null,
      status: inv ? inv.status : null,
      total: inv ? inv.total : bill.amount,
      issuedOn: inv ? inv.issuedOn : null,
      dueOn: inv ? inv.dueOn : null
    };
  });
}

/** Everything ever generated, newest month first — the running ledger. */
function listAll() {
  if (!fs.existsSync(INV_DIR)) return [];
  return fs.readdirSync(INV_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'))
    .map(f => readJson(path.join(INV_DIR, f), null))
    .filter(Boolean)
    .sort((a, b) => (b.month || '').localeCompare(a.month || '') || b.number - a.number);
}

/* ---------------- editing what's on it ---------------- */
const cents = n => Math.round(Number(n || 0) * 100) / 100;

/**
 * Replaces the line items with whatever was typed in the hub — "what they paid
 * for" and "how much" — and re-totals. The number, issue date, due date and
 * paid status all stay exactly as they were.
 *
 * Marks the invoice `custom` so it's obvious later that it isn't just the
 * standing monthly amount.
 */
function setLines(clientId, month, raw) {
  const inv = getInvoice(clientId, month);
  if (!inv) return null;

  const lines = (Array.isArray(raw) ? raw : [])
    .map(l => {
      const description = String(l.description || '').trim();
      if (!description) return null;
      const qty = Math.max(0, Number(l.qty) || 0) || 1;
      // A rate typed as "1,200" or "$1,200.00" should still land as 1200.
      const rate = cents(String(l.rate == null ? '' : l.rate).replace(/[^0-9.\-]/g, ''));
      return {
        description,
        detail: String(l.detail || '').trim() || null,
        qty,
        rate,
        amount: cents(qty * rate)
      };
    })
    .filter(Boolean);

  if (!lines.length) throw new Error('An invoice needs at least one item with a description.');

  inv.lines = lines;
  inv.subtotal = cents(lines.reduce((t, l) => t + l.amount, 0));
  inv.total = inv.subtotal;
  inv.custom = true;
  return saveInvoice(inv);
}

function setStatus(clientId, month, status) {
  const inv = getInvoice(clientId, month);
  if (!inv) return null;
  inv.status = status === 'paid' ? 'paid' : 'open';
  inv.paidOn = status === 'paid' ? new Date().toISOString().slice(0, 10) : null;
  return saveInvoice(inv);
}

/** Months that have at least one invoice, plus the current one. */
function knownMonths() {
  const set = new Set(listAll().map(i => i.month));
  set.add(currentMonth());
  return [...set].sort().reverse();
}

module.exports = {
  currentMonth, monthParts, prettyDate, money, MONTHS,
  billingFor, billableClients,
  build, buildAll, getInvoice, saveInvoice, deleteInvoice,
  listMonth, listAll, setLines, setStatus, knownMonths, peekNumber,
  FROM, FIRST_NUMBER
};
