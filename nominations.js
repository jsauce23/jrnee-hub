// Giveaway nominations from jrnee.ai/giveaway/.
//
// Same shape and the same safety rules as leads.js: the marketing site is a
// static site with no back end, so the form posts here. One JSON file per
// nomination under DATA_DIR/nominations/, written to a temp file and renamed,
// so a crash mid-write can never leave half a nomination behind.
//
// These are deliberately kept apart from leads. A nomination is not a sales
// lead and must never show up on the Leads screen or in a client report.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const NOM_DIR = path.join(DATA_DIR, 'nominations');

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
// Keeps line breaks. The reason someone writes is the whole point of this
// form and it is unreadable collapsed onto one line.
const lines = (s, max) => String(s == null ? '' : s)
  .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

const handle = s => clean(s, 60).replace(/^@+/, '').replace(/^.*instagram\.com\//i, '').replace(/\/+$/, '');

function normalise(d) {
  return {
    // who is nominating
    name:     clean(d.name, 120),
    email:    clean(d.email, 160).toLowerCase(),
    phone:    clean(d.phone || d.tel, 40),
    ig:       handle(d.ig || d.instagram),
    // who they are nominating
    family:   clean(d.family || d.nominee, 160),
    area:     clean(d.area || d.city, 120),
    relation: clean(d.relation, 120),
    reason:   lines(d.reason || d.why || d.details, 4000),
    form:     clean(d.form || 'giveaway-nomination', 60),
    page:     clean(d.page || '', 300)
  };
}

// Enough to actually contact a winner and to judge the nomination.
function problemWith(n) {
  if (!n.name) return 'Please add your name.';
  if (!n.email) return 'Please add your email address so we can reach you.';
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(n.email)) return "That email address doesn't look right.";
  if (!n.family) return 'Please tell us who you are nominating.';
  if (!n.reason) return 'Please tell us why they should win.';
  if (n.reason.length < 40) return 'Tell us a little more about them, a couple of sentences at least.';
  return null;
}

function save(nom, meta) {
  fs.mkdirSync(NOM_DIR, { recursive: true });
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const rec = { id, when: now.toISOString(), status: 'new', ...nom,
                ip: meta.ip || '', ua: clean(meta.ua, 300), ref: clean(meta.ref, 300) };
  const file = path.join(NOM_DIR, id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
  return rec;
}

function list(limit = 500) {
  if (!fs.existsSync(NOM_DIR)) return [];
  return fs.readdirSync(NOM_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse().slice(0, limit)
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(NOM_DIR, f), 'utf8')); }
                catch (e) { return null; } })
    .filter(Boolean);
}

// new -> shortlisted -> winner, and back. Only one winner at a time: setting
// one demotes whoever held it, so the screen can never show two.
const STATUSES = ['new', 'shortlist', 'winner', 'passed'];

function setStatus(id, status) {
  if (!STATUSES.includes(status)) return null;
  const file = path.join(NOM_DIR, path.basename(id) + '.json');
  if (!fs.existsSync(file)) return null;
  if (status === 'winner') {
    list(1000).filter(n => n.status === 'winner' && n.id !== path.basename(id))
              .forEach(n => write(n.id, { ...n, status: 'shortlist' }));
  }
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.status = status;
  write(rec.id, rec);
  return rec;
}

function write(id, rec) {
  const file = path.join(NOM_DIR, path.basename(id) + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

const countNew = () => list(1000).filter(n => n.status === 'new').length;
const total = () => list(1000).length;

module.exports = { normalise, problemWith, save, list, setStatus, countNew, total, NOM_DIR };
