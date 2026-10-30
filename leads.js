// Lead capture for jrnee.ai's own forms.
//
// The marketing site is a static site on Render, so there is no back end in
// front of it to catch a form post. Submissions come here instead, to the hub,
// which is a real server with a disk.
//
// Stored one JSON file per lead under DATA_DIR/leads/, same pattern as
// reports.js and ask.js: write to a temp file, then rename, so a crash
// mid-write can't leave a half-written lead behind.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LEAD_DIR = path.join(DATA_DIR, 'leads');

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

// What the consult form sends, plus the field names other forms tend to use.
function normalise(d) {
  const topic = clean(d.need || d.subject || d.topic || d.service || d.reason, 160);
  const body  = clean(d.details || d.message || d.comments || d.notes, 4000);
  return {
    name:    clean(d.name || [d.first_name, d.last_name].filter(Boolean).join(' '), 120),
    email:   clean(d.email, 160).toLowerCase(),
    phone:   clean(d.phone || d.telephone || d.tel || d.mobile, 40),
    company: clean(d.company || d.business, 160),
    topic, details: body,
    form:    clean(d.form || d['form-name'] || 'consult', 60),
    page:    clean(d.page || '', 300)
  };
}

// Enough to be worth calling back: a way to reach them, and a name.
function problemWith(lead) {
  if (!lead.name) return 'Please add your name.';
  if (!lead.email && !lead.phone) return 'Please add an email address or a phone number.';
  if (lead.email && !/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(lead.email)) return "That email address doesn't look right.";
  return null;
}

function save(lead, meta) {
  fs.mkdirSync(LEAD_DIR, { recursive: true });
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const rec = { id, when: now.toISOString(), status: 'new', ...lead,
                ip: meta.ip || '', ua: clean(meta.ua, 300), ref: clean(meta.ref, 300) };
  const file = path.join(LEAD_DIR, id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
  return rec;
}

function list(limit = 200) {
  if (!fs.existsSync(LEAD_DIR)) return [];
  return fs.readdirSync(LEAD_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse().slice(0, limit)
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(LEAD_DIR, f), 'utf8')); }
                catch (e) { return null; } })
    .filter(Boolean);
}

function setStatus(id, status) {
  const file = path.join(LEAD_DIR, path.basename(id) + '.json');
  if (!fs.existsSync(file)) return null;
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.status = status === 'done' ? 'done' : 'new';
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
  return rec;
}

const countNew = () => list(500).filter(l => l.status !== 'done').length;

module.exports = { normalise, problemWith, save, list, setStatus, countNew, LEAD_DIR };
