// Ask JRNEE — questions a client asks while reading their report.
//
// Today the answers are computed from the report's own figures. Nothing is invented:
// if the data can't answer it, it says so and sends the question to Joel.
// When ANTHROPIC_API_KEY is set, free-form questions go to the model instead, with the
// same guardrails and the same transcript trail.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ASK_DIR = path.join(DATA_DIR, 'asks');

const nf = x => Math.round(Number(x) || 0).toLocaleString('en-US');
const pcChange = (c, p) => (p ? Math.round((c - p) / p * 100) : null);
const mmss = s => s >= 60 ? `${Math.floor(s/60)}m ${String(Math.round(s%60)).padStart(2,'0')}s` : `${Math.round(s)}s`;
const has = (q, words) => words.some(w => q.includes(w));

/* ---------------- what the client is really asking ---------------- */
const MONEY = ['invoice','billing','bill ','charge','how much do','what do i pay','paying you','retainer',
  'contract','cancel','refund','price','pricing','worth it','value for money','money\'s worth','moneys worth',
  'getting my money','cost me','fees','fee '];
const POINTED = ['two months','second month','still down','again this month','not working','no results',
  'waste','disappointed','frustrat','why am i paying','what am i paying','nothing is happening',
  'nothing has changed','going backwards','worse than','losing money','thinking of cancel'];
const LEGAL = ['legal advice','sue','lawsuit','liable','liability','contract law','is it legal'];

function classify(question) {
  const q = ' ' + String(question || '').toLowerCase().trim() + ' ';
  return {
    overall: has(q, ['how are things','how is it going','how are we doing','how we doing','overall',
      'right now','how is everything','how are my numbers','are our numbers','are my numbers','numbers up',
      'numbers down','how did we do','how are we looking','looking good','doing well','any good news',
      'summary','in general','big picture','bottom line','how is the site','how is my site',
      'what should i','should i be worried','is this good','is that good','is this normal']),
    money:   has(q, MONEY),
    pointed: has(q, POINTED),
    legal:   has(q, LEGAL),
    traffic: has(q, ['traffic','visitor','visits','drop','dropped','fell','decline','down','up ']),
    social:  has(q, ['social','facebook','instagram','tiktok','linkedin','youtube','twitter','posts','posting']),
    search:  has(q, ['rank','ranking','google','keyword','search','position','page one','page 1','seo','spanish','english','language']),
    leads:   has(q, ['lead','call','calls','enquir','inquir','form','phone','contact','booking']),
    pages:   has(q, ['page','homepage','home page','blog','gallery','pricing','which pages']),
    devices: has(q, ['mobile','phone version','desktop','tablet','device']),
    work:    has(q, ['what did you','what have you','what you did','changes you','worked on','you do this month']),
    next:    has(q, ['next month','next','plan','going to do','coming up','what now']),
    sources: has(q, ['where do','where are','come from','coming from','source','channel','referral','direct']),
  };
}


/* Every answer ends with where things stand, not with an apology.
   The plan is work that's already mapped out — not a correction being rushed through. */
function asPlan(fix) {
  // "We'll build a page around X" -> "building a page around X"
  let t = String(fix || '').replace(/^we'll\s+/i, '').replace(/^we\s+/i, '').replace(/\.$/, '');
  t = t.split(/\s+and\s+(?:link|point|then)\b/i)[0].split(' — ')[0].trim();
  const verb = t.split(' ')[0].toLowerCase();
  const ing = { build:'building', rewrite:'rewriting', write:'writing', look:'looking at', go:'going',
    connect:'connecting', keep:'keeping', set:'setting', publish:'publishing', request:'requesting',
    widen:'widening', find:'finding', refresh:'refreshing', work:'working on', add:'adding',
    review:'reviewing', fix:'tightening up' }[verb];
  if (ing) t = ing + t.slice(verb.length);
  return t;
}
function closer(rep, topic, mood) {
  const c = rep.content || {};
  const room = (c.room || []).filter(r => r.fix);
  const match = topic ? room.find(r => (r.title || '').toLowerCase().includes(topic)) : null;
  const fromMoved = (c.moved || []).find(m => m.down && m.fix);
  const chosen = match || room[0] || (fromMoved ? { fix: fromMoved.fix, title: fromMoved.title } : null);

  let plan = null;
  if (chosen) {
    let fix = chosen.fix;
    const q = (chosen.title || '').match(/[“"']([^”"']+)[”"']/);
    if (q && /this search|that search|this page|that page/i.test(fix))
      fix = fix.replace(/this search|that search/i, `“${q[1]}”`).replace(/this page|that page/i, `the page behind “${q[1]}”`);
    plan = asPlan(fix);
  } else if ((c.next || []).length) {
    plan = asPlan(c.next[0]);
  }

  if (mood === 'good') {
    return plan
      ? `Joel and the team are carrying on with the plan from here — ${plan} is the next piece.`
      : `Joel and the team are carrying on with the plan from here.`;
  }
  // anything that moved the wrong way
  return plan
    ? `We're keeping a close eye on it — this gets looked at every week, not just at month end, and ${plan} is already part of the plan either way. If it turns into something that needs a change of direction, Joel will say so before you have to ask.`
    : `We're keeping a close eye on it — this gets looked at every week, not just at month end. If it turns into something that needs a change of direction, Joel will say so before you have to ask.`;
}

/* "How are things looking?" — the question everyone asks first.
   Lead with what's working, give the honest movement without alarm, then the plan. */
function overallAnswer(rep) {
  const n = rep.numbers || {}, c = rep.content || {}, p = rep.period || {};
  const lead = n.leads || n.keyEvents;
  const pc = (a, b) => (b ? Math.round((a - b) / b * 100) : null);
  const vs = p.vs || (p.prevPhrase || 'the period before').replace(/^in\s+/i, '');
  const up = [], down = [];

  const note = (label, cur, prv) => {
    if (cur == null || prv == null || !prv) return;
    const d = pc(cur, prv);
    if (d > 0) up.push(`${label} are up ${d}% at ${nf(cur)}`);
    else if (d < 0) down.push({ label, text:`${label} are at ${nf(cur)}, ${Math.abs(d)}% off ${nf(prv)}` });
  };
  if (lead) note('enquiries', lead.cur, lead.prev);
  if (n.visitors) note('visits', n.visitors.cur, n.visitors.prev);
  if (n.clicks) note('clicks from Google', n.clicks.cur, n.clicks.prev);

  // standing positives, true regardless of direction
  const steady = [];
  if (c.keywords && c.keywords.pageOne)
    steady.push(`you're on page one of Google for ${c.keywords.pageOne} search${c.keywords.pageOne === 1 ? '' : 'es'}`
      + (c.keywords.pageOnePrev != null ? `, against ${c.keywords.pageOnePrev} ${vs === 'the period before' ? 'before' : 'in ' + vs}` : ''));
  if (lead && n.visitors && n.visitors.cur && lead.cur)
    steady.push(`the site is turning about one in every ${Math.round(n.visitors.cur / lead.cur)} visitors into an enquiry`);
  if (!up.length && !down.length && n.visitors)
    steady.push(`${nf(n.visitors.cur)} people visited in this period`);

  if (!up.length && !down.length && !steady.length) {
    return { text:
      `The figures for this period are still coming through — the accounts behind this report were connected recently, so there isn't a full stretch to compare against yet. `
      + `Joel and the team are watching it, and the picture will be complete in the next report.`,
      routed: false, flagged: false };
  }

  const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
  const bits = [];

  if (up.length) bits.push(`${cap(up.slice(0, 2).join(', and '))} on ${vs}.`);
  else if (steady.length) bits.push(`${cap(steady.shift())}.`);

  if (down.length) {
    bits.push(`${up.length || bits.length ? 'The one to keep an eye on' : 'Worth flagging'}: ${down[0].text}.`);
    bits.push(`Movement like that month to month is normal — traffic shifts with the season, with what competitors are doing, and with how Google weights results that week. One period on its own isn't a trend.`);
  }

  steady.slice(0, 1).forEach(sline => bits.push(`${cap(sline)}.`));
  bits.push(closer(rep, down.length ? 'search' : null, down.length ? 'fix' : 'good'));
  return { text: bits.join(' '), routed: false, flagged: false };
}

/* ---------------- answers, built only from this report ---------------- */
function answerFromData(question, rep) {
  const n = rep.numbers || {}, c = rep.content || {}, p = rep.period || {};
  const k = classify(question);
  const lead = n.leads || n.keyEvents;
  const prevPhrase = p.prevPhrase || 'the period before';

  // things we never answer
  if (k.legal) return { text:
    `That one needs a proper answer from Joel rather than from me — I only look at the website figures, and I'm not the right place for anything legal. I've passed your question on.`,
    routed: true, flagged: true, reason: 'legal' };

  if (k.money) return { text:
    `That's a question for Joel rather than for me — I can explain what the numbers show, but anything about billing, scope or what's included should come from him directly. I've sent him your question and he'll come back to you.`,
    routed: true, flagged: true, reason: 'billing' };

  // channels and social come first — they look like traffic questions but aren't
  if ((k.social || k.sources) && n.channels && n.channels.length) {
    const tot = n.channels.reduce((a, x) => a + x.sessions, 0) || 1;
    const find = name => n.channels.find(x => x.name === name);
    const share = ch => Math.round((ch ? ch.sessions : 0) / tot * 100);
    const bits = [];
    if (k.social) {
      const soc = n.channels.filter(x => /social/i.test(x.name));
      const socTotal = soc.reduce((a, x) => a + x.sessions, 0);
      const org = find('Organic Search'), dir = find('Direct');
      bits.push(socTotal
        ? `Social brought ${nf(socTotal)} of your ${nf(tot)} visits this period, about ${Math.round(socTotal/tot*100)}%.`
        : `Social isn't showing up as a source of visits this period.`);
      bits.push(`That's normal for this kind of business, and not a problem on its own — social is where people check you out once they've heard your name, while search is where people looking to buy actually find you.`);
      if (org) bits.push(`Search is doing the heavy lifting at ${share(org)}%${dir ? `, with ${share(dir)}% coming direct` : ''}, and that's the traffic that compounds rather than disappearing when you stop posting.`);
      bits.push(`If you'd like social to pull more weight it's a different piece of work — worth raising with Joel so it gets planned properly rather than bolted on.`);
      return { text: bits.join(' '), routed: false, flagged: !!k.pointed };
    }
    const list = n.channels.slice(0, 3).map(x => `${x.name} ${share(x)}%`).join(', ');
    bits.push(`This period it broke down as ${list}.`);
    bits.push(`Search traffic is the part that compounds — it keeps arriving without being paid for. Direct means people who already knew your name.`);
    bits.push(closer(rep, 'search', 'good'));
    return { text: bits.join(' '), routed: false, flagged: !!k.pointed };
  }

  if (k.overall) { const a = overallAnswer(rep); return { ...a, flagged: !!k.pointed }; }

  // traffic
  if (k.traffic && n.visitors) {
    const ch = pcChange(n.visitors.cur, n.visitors.prev);
    const bits = [`${nf(n.visitors.cur)} people visited in this period` +
      (n.visitors.prev ? `, against ${nf(n.visitors.prev)} ${prevPhrase}${ch !== null ? ` — ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}%` : ''}.` : '.')];
    if (n.clicks && n.clicks.prev) {
      const cc = pcChange(n.clicks.cur, n.clicks.prev);
      bits.push(`Clicks from Google went ${cc >= 0 ? 'up' : 'down'} ${Math.abs(cc)}%, from ${nf(n.clicks.prev)} to ${nf(n.clicks.cur)}.`);
    }
    const down = (c.moved || []).find(m => m.down);
    if (down && down.why) bits.push(down.why);
    else if (ch !== null && ch < 0 && n.impressions && n.impressions.prev) {
      const ic = pcChange(n.impressions.cur, n.impressions.prev);
      bits.push(ic <= -5
        ? `Google also showed the site less often — ${nf(n.impressions.cur)} times against ${nf(n.impressions.prev)} — so fewer people were even in a position to click.`
        : ic >= 5
          ? `Google actually showed the site more often, ${nf(n.impressions.cur)} times against ${nf(n.impressions.prev)}, so you were appearing plenty — people just picked a different result.`
          : `Google showed the site about as often as before, so this is people choosing a different result rather than you appearing less.`);
    }
    if (ch !== null && ch < 0 && !down) {
      const impMove = (n.impressions && n.impressions.prev) ? pcChange(n.impressions.cur, n.impressions.prev) : null;
      const lean = impMove === null ? `Without search data connected I can't tell you which of those it was.`
        : impMove <= -5 ? `The figures lean towards the first two — you were shown less often, which usually means demand or competition rather than anything on the site.`
        : `The figures lean towards the last one — you were shown just as often, so it's about which result people chose.`;
      bits.push(`Usually it's one of three things: fewer people searching at this time of year, a competitor climbing above you, or a page slipping a few places. ${lean}`);
    }
    if (ch !== null && ch < 0) bits.push(`For what it's worth, a single quieter period is normal — traffic moves with the season, with competitors, and with how Google weights a given week.`);
    if (k.pointed) bits.push(`You're pointing at something longer than one period, which is fair — I've flagged it so Joel looks across the whole run and comes back to you directly.`);
    bits.push(closer(rep, 'search', (ch !== null && ch < 0) ? 'fix' : 'good'));
    return { text: bits.join(' '), routed: false, flagged: !!k.pointed };
  }

  // search and rankings
  if (k.search) {
    const kw = c.keywords;
    if (!kw) return { text:
      `Search Console isn't connected for this site yet, so I can't see which searches you show up for. Joel can connect it and that section will appear in the next report.`,
      routed: true, flagged: false, reason: 'not_connected' };

    const q = String(question).toLowerCase();
    if (q.includes('spanish') || q.includes('language')) {
      const SPANISH = /[áéíóúñ¿¡]|\b(de|para|cerca|piscina|precio|casa|servicio|los|las|en el|mejor|como)\b/i;
      const es = (kw.top || []).filter(r => SPANISH.test(r.q));
      if (!es.length) return { text:
        `Looking at the searches you appear for this period, I don't see a Spanish-language pattern — the ones bringing clicks are in English. If you're seeing something different on your side, tell Joel and he'll check it properly.`,
        routed: false, flagged: false };
      const share = Math.round(es.length / kw.top.length * 100);
      return { text:
        `About ${share}% of your top searches this period look Spanish-language, including “${es[0].q}”. That usually means those pages match what Spanish-speaking searchers are typing, and nobody else locally is competing for it. Whether you want more of that traffic is a business call — worth raising with Joel, because it changes what we'd write next.`,
        routed: false, flagged: false };
    }

    const bits = [`You appear for ${kw.total} searches at the moment, and ${kw.pageOne} of them are on page one` +
      (kw.pageOnePrev != null ? `, against ${kw.pageOnePrev} ${prevPhrase}.` : '.')];
    if (kw.risers && kw.risers.length) {
      const r = kw.risers[0];
      bits.push(`The biggest climb was “${r.q}”, from position ${r.before.toFixed(0)} to ${r.position.toFixed(0)}.`);
    }
    if (kw.top && kw.top.length) {
      const t = kw.top[0];
      bits.push(`Your strongest is “${t.q}” at position ${t.position.toFixed(1)}, bringing ${nf(t.clicks)} clicks.`);
    }
    bits.push(`Rankings move in weeks rather than days, so recent work tends to show up a report or two later.`);
    bits.push(closer(rep, 'page'));
    return { text: bits.join(' '), routed: false, flagged: !!k.pointed };
  }

  // leads — including the honest limit on attribution
  if (k.leads) {
    const q = String(question).toLowerCase();
    const wantsWhichPage = q.includes('which page') || q.includes('what page') || q.includes('pages produce')
      || q.includes('pages actually') || q.includes('come from');

    if (wantsWhichPage) {
      const top = (n.pages || [])[0];
      return { text:
        `Honest answer: I can't tie an individual enquiry back to the page someone was on when they sent it. The form records the message, not the page it came from. ` +
        (top ? `What I can tell you is where people spend their time — ${top.path} had ${nf(top.views)} views this period. ` : '') +
        `Joel and the team can switch on tracking that records the page behind each enquiry, and then this becomes a straight answer every month rather than an educated guess.`,
        routed: false, flagged: false };
    }
    if (!lead) return { text:
      `Enquiry tracking isn't connected for this site yet, so I can't give you a number. Joel can hook it up and it'll be in the next report.`,
      routed: true, flagged: false, reason: 'not_connected' };

    const ch = pcChange(lead.cur, lead.prev);
    const bits = [`${nf(lead.cur)} ${lead.cur === 1 ? 'enquiry' : 'enquiries'} came through the website in this period` +
      (lead.prev ? `, against ${nf(lead.prev)} ${prevPhrase}${ch !== null ? ` — ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch)}%` : ''}.` : '.')];
    if (n.visitors && n.visitors.cur && lead.cur) {
      bits.push(`That's roughly one enquiry for every ${Math.round(n.visitors.cur / lead.cur)} people who visited.`);
    }
    if (n.leadItems && n.leadItems.length) {
      const withPhone = n.leadItems.filter(l => l.phone).length;
      if (withPhone) bits.push(`${withPhone} of the ones listed left a phone number, and calling back the same day tends to matter more than anything else on the page.`);
    }
    if (ch !== null && ch < 0) bits.push(`Enquiry counts bounce around more than traffic does, especially on smaller numbers — a couple either way isn't a pattern. When they dip while visits hold up it usually points at what happens once people land; when visits dip too, it's a traffic question instead.`);
    if (k.pointed) bits.push(`I've flagged this so Joel picks it up with you directly.`);
    bits.push(closer(rep, 'enquir', (ch !== null && ch < 0) ? 'fix' : 'good'));
    return { text: bits.join(' '), routed: false, flagged: !!k.pointed };
  }

  // where traffic comes from
  if (k.sources && n.channels && n.channels.length) {
    const tot = n.channels.reduce((a, x) => a + x.sessions, 0) || 1;
    const list = n.channels.slice(0, 3)
      .map(x => `${x.name} ${Math.round(x.sessions / tot * 100)}%`).join(', ');
    return { text:
      `This period it broke down as ${list}. Search traffic is the part that compounds — it keeps arriving without being paid for. Direct means people who already knew your name. ${closer(rep, 'search')}`,
      routed: false, flagged: !!k.pointed };
  }

  // devices
  if (k.devices && n.devices && n.devices.length) {
    const tot = n.devices.reduce((a, d) => a + d.sessions, 0) || 1;
    const mob = n.devices.find(d => d.name === 'mobile');
    const share = mob ? Math.round(mob.sessions / tot * 100) : 0;
    return { text:
      `${n.devices.map(d => `${d.name} ${Math.round(d.sessions / tot * 100)}%`).join(', ')}. ` +
      (share >= 60
        ? `With most people on a phone, the mobile version is effectively the website — it's where we check things first after any change.`
        : `It's a genuine mix, so both versions have to hold up.`),
      routed: false, flagged: false };
  }

  // pages
  if (k.pages && n.pages && n.pages.length) {
    const t = n.pages[0];
    const quick = n.pages.find(x => x.views >= 30 && x.avgTime < 20);
    return { text:
      `Your most visited page was ${t.path} with ${nf(t.views)} views, averaging ${mmss(t.avgTime)} on the page. ` +
      (quick ? `${quick.path} is worth a look — ${nf(quick.views)} views but people left after ${mmss(quick.avgTime)}, which usually means the page isn't answering what they arrived for, or isn't making the next step obvious. ` : '') + closer(rep, 'page'),
      routed: false, flagged: false };
  }

  // what we did / what's next
  if (k.work && (c.groups || []).length) {
    const items = c.groups.flatMap(g => g.items);
    return { text:
      `In this period: ${items.slice(0, 4).join('; ')}${items.length > 4 ? `, plus ${items.length - 4} other${items.length - 4 === 1 ? '' : 's'}` : ''}. ` +
      `Some of that shows up in the figures straight away; anything aimed at Google takes longer to land.`,
      routed: false, flagged: false };
  }
  if (k.next && (c.next || []).length) {
    return { text: `Next up: ${c.next.join('; ')}. If there's something you'd rather we prioritised, tell Joel and we'll move it up.`,
      routed: false, flagged: false };
  }

  // nothing matched by name — answer with the overall picture rather than sending them away
  const anyData = n.visitors || n.leads || n.keyEvents || n.clicks || (n.pages || []).length;
  if (anyData) {
    const a = overallAnswer(rep);
    return { text: `I'll give you what the figures do show. ${a.text} If you meant something more specific, ask it straight out — or Joel can pick it up with you directly.`,
      routed: false, flagged: !!k.pointed };
  }
  return { text:
    `There aren't any figures flowing into this report yet, so I'd only be guessing. Joel and the team are getting the accounts connected — once they are, this is exactly the kind of question I can answer properly.`,
    routed: true, flagged: !!k.pointed, reason: 'no_data' };
}


/* ---------------- the model, when a key is set ---------------- */
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ASK_MODEL || 'claude-sonnet-5';
const hasModel = () => !!API_KEY;

const SYSTEM = `You are "Ask JRNEE", answering questions a small business owner asks while reading
the monthly website report JRNEE Technologies prepared for them. Joel and his team built and run
their website. You are the knowledgeable person on that team who happens to be free to talk.

VOICE
- Talk like an expert who likes explaining things. Warm, direct, unhurried. Use contractions.
- Three to five sentences. Enough to actually answer, short enough to read mid-scroll.
- No jargon unless you explain it in the same breath. No bullet points, no headings, no sign-off.
- Don't hedge everything into mush. If the data points somewhere, say so.

POSTURE WHEN SOMETHING IS DOWN
Lead with something that is genuinely going well before you get to the dip — there is almost always
one. State the dip plainly, then steady it: month-to-month movement is normal, it moves with the
season, with competitors, and with how Google weights results that week, and one period is not a
trend. Say that the team watches it weekly rather than waiting for the report, so a real trend gets
caught early. Then the plan. The reader should finish calm and clear that someone is ahead of it.
Never spin a decline into good news, and never pretend a number is something it isn't — the
reassurance has to be true or it costs more than it gains.

BROAD QUESTIONS
"How are things looking?", "are our numbers up?", "is this good?" — these are the most common
questions and they always get a real answer. Summarise the movement in the headline figures
against the period before, add one thing that stands out, and finish with what's being worked on.
Never send a broad question away; there is always something in the DATA block to say.

SHAPE OF A GOOD ANSWER
1. The number, straight away.
2. The honest reason. If the data shows the cause, name it. If it doesn't, say what usually
   explains this and which of those the figures point towards — label it as likely, not certain.
3. What's being done about it. Always finish here.

ALWAYS END WITH WHERE THINGS STAND
Close with posture, not an apology. When something has moved the wrong way, the line is that it's
being watched closely — looked at weekly, not just at month end — that a plan is already mapped out,
and that Joel will say if it ever needs a change of direction. Do NOT promise immediate corrective
work, and never phrase the plan as a repair for a mistake: the work was already planned, and it
stands whether this period was up or down. When things are going well, close with the next piece of
the plan. Never leave someone with a problem and no next step, and never say "there's nothing we can do".

HONESTY
- Only use figures from the DATA block. Never invent a number, a date, or a comparison.
- You may reason about likely causes using what you know about how websites and search work,
  as long as you flag it as likely rather than certain. Seasonal demand, a competitor moving,
  a page losing ground, a slow week — these are fair to raise when the figures fit.
- If the data genuinely can't answer it, say that plainly, then say what Joel will check.

ABOUT JRNEE
- Never criticise JRNEE, Joel, or the team. Never suggest the work was wrong, late or lacking.
- Never hide a cause that is visible in the figures either. If a change coincides with a drop,
  state it neutrally as a thing that happened, and go straight to what's being done.
- Never claim JRNEE's work caused an improvement. Describe what changed and let them join the dots.

NEVER
- Never promise or predict results. Not "this will improve", not "you'll see more leads next month".
  Describe the work, not the outcome.
- Never give legal advice, or comment on anything legal. Some clients are law firms.
- Never discuss pricing, billing, invoices, contracts, scope, or value for money. Joel answers those.
- Never criticise the client or blame them for a number.`;

function compactContext(rep) {
  const n = rep.numbers || {}, c = rep.content || {}, p = rep.period || {};
  const slim = (arr, f, lim = 12) => (arr || []).slice(0, lim).map(f);
  return {
    period: { label:p.label, covers:p.span, comparedWith:p.vs, days:p.days },
    client: { name: rep.client && rep.client.name, website: rep.client && rep.client.domain },
    thisPeriodVsBefore: {
      enquiries: n.leads || n.keyEvents || null,
      visitors: n.visitors || null, visits: n.visits || null,
      clicksFromGoogle: n.clicks || null, timesShownOnGoogle: n.impressions || null,
      averagePosition: n.position || null, averageVisitSeconds: n.visitLen || null
    },
    trafficSources: slim(n.channels, x => ({ source:x.name, visits:x.sessions }), 8),
    devices: slim(n.devices, x => ({ device:x.name, visits:x.sessions }), 5),
    topPages: slim(n.pages, x => ({ page:x.path, views:x.views, avgSecondsOnPage: Math.round(x.avgTime) }), 8),
    searches: {
      onPageOneNow: c.keywords && c.keywords.pageOne, onPageOneBefore: c.keywords && c.keywords.pageOnePrev,
      totalSearchesAppearingFor: c.keywords && c.keywords.total,
      top: slim(c.keywords && c.keywords.top, x => ({ search:x.q, clicks:x.clicks, timesShown:x.impressions,
        position:+x.position.toFixed(1), positionBefore: x.before ? +x.before.toFixed(1) : null, isNew: !!x.isNew })),
      climbed: slim(c.keywords && c.keywords.risers, x => ({ search:x.q, from:+x.before.toFixed(1), to:+x.position.toFixed(1) }), 6)
    },
    enquiryDetails: slim(n.leadItems, x => ({ when:x.when, form:x.form, hasPhone: !!x.phone, hasEmail: !!x.email }), 20),
    whatWeDidThisPeriod: (c.groups || []).map(g => ({ theme:g.b, items:g.items })),
    whatMoved: (c.moved || []).map(m => ({ title:m.title, detail:m.body, wentDown: !!m.down, why:m.why || null, plan:m.fix || null })),
    whereWeSeeRoom: (c.room || []).map(r => ({ issue:r.title, detail:r.body, plan:r.fix || null })),
    whatWereDoingNext: c.next || [],
    notConnected: Object.keys((n.notes) || {})
  };
}

async function answerWithModel(question, rep, history) {
  const messages = [];
  (history || []).slice(-6).forEach(h => {
    if (h.question) messages.push({ role:'user', content: h.question });
    if (h.answer) messages.push({ role:'assistant', content: h.answer });
  });
  messages.push({ role:'user', content:
    `DATA (everything in their report for this period):\n${JSON.stringify(compactContext(rep))}\n\nTheir question: ${question}` });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 500, system: SYSTEM, messages })
  });
  if (!r.ok) throw new Error('model ' + r.status);
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('empty');
  return text;
}

/* A quiet safety valve. The client never sees a limit — if it trips, they get the
   data-driven answer instead, which is still a real answer. */
const recent = new Map();
function withinBudget(clientId) {
  const now = Date.now(), hour = 3600e3;
  const list = (recent.get(clientId) || []).filter(t => now - t < hour);
  list.push(now); recent.set(clientId, list);
  return list.length <= 60;
}

/** The one entry point the server uses. */
async function answer(question, rep, history, clientId) {
  const k = classify(question);
  // money and legal never reach the model
  if (k.legal || k.money) return { ...answerFromData(question, rep), engine:'rules' };

  if (hasModel() && withinBudget(clientId)) {
    try {
      const text = await answerWithModel(question, rep, history);
      return { text, routed:false, flagged: !!k.pointed, engine:'model' };
    } catch (e) { /* fall through to the figures */ }
  }
  return { ...answerFromData(question, rep), engine:'rules' };
}

/* ---------------- suggested questions, per section ---------------- */
function suggestions(section, rep) {
  const n = rep.numbers || {}, c = rep.content || {}, p = rep.period || {};
  const lead = n.leads || n.keyEvents;
  const dir = (cur, prev) => (prev && cur < prev) ? 'drop' : 'change';
  const S = {
    overall: [
      'How are things looking overall right now?',
      'What should I be paying attention to this month?',
      'What are you working on for me at the moment?'
    ],
    glance: [
      n.visitors && n.visitors.prev ? `Why did visits ${dir(n.visitors.cur, n.visitors.prev)} compared with ${p.prevPhrase || 'last period'}?` : 'What do these four numbers actually mean?',
      lead ? 'Is this a good number of enquiries for a business like mine?' : 'How do you count an enquiry?',
      'Which of these numbers should I care about most?'
    ],
    chart: [
      'Why are some days so much busier than others?',
      'Is this going in the right direction?',
      'What caused the quietest day?'
    ],
    sources: [
      'Where is most of my traffic coming from?',
      'Should I worry that so much comes from one place?',
      'How do I get more people finding me on Google?'
    ],
    devices: [
      'Does it matter that most people are on a phone?',
      'Is my site good on mobile?',
      'What do you check on the mobile version?'
    ],
    search: [
      'Why are most of my ranking pages in Spanish?',
      'How long until I reach page one for the searches that matter?',
      'Which search brings me the most business?'
    ],
    pages: [
      'Which pages actually produce calls?',
      'Why do people leave some pages so quickly?',
      'Should I add more pages?'
    ],
    leads: [
      'Which pages actually produce calls?',
      'How quickly should I be replying to these?',
      'Why were there fewer enquiries this period?'
    ],
    work: [
      'What difference will this work make?',
      'When will I see the results of this?',
      'What was the most important thing you did?'
    ],
    moved: [
      'Why did that drop?',
      'Is this normal month to month?',
      'What would make the biggest difference next?'
    ],
    room: [
      'How long will these take to fix?',
      'Which of these matters most?',
      'What do you need from me for this?'
    ]
  };
  return S[section] || ['What does this section mean?', 'Is this good or bad?', 'What happens next?'];
}

/* ---------------- transcripts ---------------- */
const safe = s => String(s || '').replace(/[^\w-]/g, '');
const threadFile = (clientId, reportId) => path.join(ASK_DIR, safe(clientId), safe(reportId) + '.json');

function appendAsk(clientId, reportId, entry, reportTitle) {
  fs.mkdirSync(path.join(ASK_DIR, safe(clientId)), { recursive: true });
  const f = threadFile(clientId, reportId);
  let thread = { clientId, reportId, entries: [] };
  if (fs.existsSync(f)) { try { thread = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {} }
  thread.entries.push(entry);
  if (reportTitle) thread.reportTitle = reportTitle;
  thread.updatedAt = entry.at;
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(thread, null, 2));
  fs.renameSync(tmp, f);
  return thread;
}
function getThread(clientId, reportId) {
  const f = threadFile(clientId, reportId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function markSeen(clientId, reportId) {
  const t = getThread(clientId, reportId);
  if (!t) return null;
  t.entries.forEach(e => e.seen = true);
  fs.writeFileSync(threadFile(clientId, reportId), JSON.stringify(t, null, 2));
  return t;
}
/** Every conversation, newest first, with counts for the dashboard. */
function listThreads() {
  if (!fs.existsSync(ASK_DIR)) return [];
  const out = [];
  fs.readdirSync(ASK_DIR).forEach(cid => {
    const dir = path.join(ASK_DIR, cid);
    if (!fs.statSync(dir).isDirectory()) return;
    fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const qs = t.entries.filter(e => e.question);
        out.push({
          clientId: t.clientId, reportId: t.reportId, reportTitle: t.reportTitle || '',
          count: qs.length,
          unseen: qs.filter(e => !e.seen).length,
          flagged: qs.filter(e => e.flagged).length,
          routed: qs.filter(e => e.routed).length,
          updatedAt: t.updatedAt, last: qs.length ? qs[qs.length - 1].question : ''
        });
      } catch (e) {}
    });
  });
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

module.exports = { classify, answer, answerFromData, hasModel, suggestions, appendAsk, getThread, markSeen, listThreads };
