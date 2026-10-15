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
const TERMS_DAYS = parseInt(process.env.INVOICE_TERMS_DAYS || '15', 10);

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
  return {
    amount,
    description: b.description || 'Website maintenance / development',
    detail: b.detail || null,
    poNumber: b.poNumber || null,
    billTo: b.billTo || null,
    terms: Number(b.termsDays || TERMS_DAYS)
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
function build(client, month, opts) {
  const bill = billingFor(client);
  if (!bill) throw new Error(`${client.name} has no monthly amount set in clients.json.`);

  const existing = getInvoice(client.id, month);
  if (existing && !(opts && opts.rebuild)) return { invoice: existing, created: false };

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
    dueOn: addDays(issued, bill.terms),
    termsDays: bill.terms,
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
  listMonth, listAll, setStatus, knownMonths, peekNumber,
  FROM, FIRST_NUMBER
};
