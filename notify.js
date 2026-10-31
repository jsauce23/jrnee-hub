// Telling Joel a lead came in. Two independent channels, because a lead that
// nobody hears about is the same as no lead at all:
//
//   1. Web push to the installed hub app  — free, no account
//   2. SMS through Twilio                 — the backstop
//
// Neither is allowed to throw into the request that saved the lead. The lead
// is already on disk by the time any of this runs; a failed notification gets
// logged loudly and nothing else.
//
// Env:
//   VAPID_PUBLIC / VAPID_PRIVATE   base64url keys — `node notify.js keys` prints a pair
//   VAPID_SUBJECT                  mailto: or https: contact, defaults to the site
//   TWILIO_SID / TWILIO_TOKEN      Twilio credentials
//   TWILIO_FROM                    the Twilio number, E.164, e.g. +12105550100
//   ALERT_SMS_TO                   where to text, E.164, e.g. +12107904017

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SUB_DIR = path.join(DATA_DIR, 'push');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://jrnee.ai';

const b64u = b => Buffer.from(b).toString('base64url');

/* ---------------- subscriptions on disk ---------------- */
const subId = sub => crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 24);

function saveSub(sub) {
  fs.mkdirSync(SUB_DIR, { recursive: true });
  const file = path.join(SUB_DIR, subId(sub) + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(sub, null, 2));
  fs.renameSync(file + '.tmp', file);
  return subId(sub);
}
function listSubs() {
  if (!fs.existsSync(SUB_DIR)) return [];
  return fs.readdirSync(SUB_DIR).filter(f => f.endsWith('.json')).map(f => {
    try { return { id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(SUB_DIR, f), 'utf8')) }; }
    catch (e) { return null; }
  }).filter(Boolean);
}
function dropSub(id) {
  const f = path.join(SUB_DIR, path.basename(id) + '.json');
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/* ---------------- VAPID ---------------- */
// Node signs ECDSA as DER; JWS wants raw r||s.
function derToJose(der) {
  let o = 0;
  if (der[o++] !== 0x30) throw new Error('bad DER');
  if (der[o] & 0x80) o += 1 + (der[o] & 0x7f); else o += 1;
  const read = () => {
    if (der[o++] !== 0x02) throw new Error('bad DER int');
    let len = der[o++];
    let v = der.slice(o, o + len); o += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    return Buffer.concat([Buffer.alloc(32 - v.length, 0), v]);
  };
  return Buffer.concat([read(), read()]);
}

function privateKeyObject(rawPrivB64u, rawPubB64u) {
  // Wrap the raw 32-byte scalar in a PKCS#8 structure so crypto can use it.
  const d = Buffer.from(rawPrivB64u, 'base64url');
  const q = Buffer.from(rawPubB64u, 'base64url');
  const der = Buffer.concat([
    Buffer.from('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420', 'hex'),
    d,
    Buffer.from('a144034200', 'hex'),
    q
  ]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT
  }));
  const signing = header + '.' + body;
  const der = crypto.sign('sha256', Buffer.from(signing), {
    key: privateKeyObject(VAPID_PRIVATE, VAPID_PUBLIC),
    dsaEncoding: 'der'
  });
  return 'vapid t=' + signing + '.' + b64u(derToJose(der)) + ', k=' + VAPID_PUBLIC;
}

/* ---------------- send ---------------- */
// Deliberately payload-free. Encrypting a push body is aes128gcm + HKDF and is
// easy to get subtly wrong; an empty push still wakes the service worker, which
// then fetches the real lead and builds the notification itself.
async function pushAll() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: 'no VAPID keys set' };
  const subs = listSubs();
  let sent = 0, gone = 0;
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: {
          TTL: '86400',
          Urgency: 'high',
          Authorization: vapidHeader(s.endpoint),
          'Content-Length': '0'
        }
      });
      if (r.status === 404 || r.status === 410) { dropSub(s.id); gone++; continue; }
      if (r.ok || r.status === 201) sent++;
      else console.error('PUSH failed', r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('PUSH error', e.message); }
  }
  return { sent, gone, total: subs.length };
}

async function sms(text) {
  const { TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, ALERT_SMS_TO } = process.env;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !ALERT_SMS_TO) {
    return { sent: 0, skipped: 'Twilio not configured' };
  }
  const body = new URLSearchParams({ To: ALERT_SMS_TO, From: TWILIO_FROM, Body: text.slice(0, 600) });
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!r.ok) throw new Error('Twilio ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200));
  return { sent: 1 };
}

function leadText(lead) {
  const who = lead.name || 'Someone';
  const co = lead.company ? ' (' + lead.company + ')' : '';
  const how = [lead.phone, lead.email].filter(Boolean).join(' · ');
  const what = lead.topic || (lead.details || '').slice(0, 80);
  return `New JRNEE lead — ${who}${co}\n${how}${what ? '\n' + what : ''}\nreports.jrnee.ai`;
}

// Fire-and-forget. Called after the lead is already saved.
function announce(lead) {
  const results = {};
  Promise.allSettled([
    pushAll().then(r => results.push = r),
    sms(leadText(lead)).then(r => results.sms = r)
  ]).then(rs => {
    rs.forEach(r => { if (r.status === 'rejected') console.error('NOTIFY failed:', r.reason && r.reason.message); });
    console.log('NOTIFY', lead.id, JSON.stringify(results));
  });
}

/* ---------------- key generation ---------------- */
function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).slice(-65);          // uncompressed point
  const prv = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(36, 36 + 32); // raw scalar
  return { publicKey: b64u(pub), privateKey: b64u(prv) };
}

if (require.main === module && process.argv[2] === 'keys') {
  const k = generateKeys();
  console.log('VAPID_PUBLIC=' + k.publicKey);
  console.log('VAPID_PRIVATE=' + k.privateKey);
}

module.exports = { saveSub, listSubs, dropSub, pushAll, sms, announce, leadText,
                   generateKeys, vapidHeader, publicKey: () => VAPID_PUBLIC };
