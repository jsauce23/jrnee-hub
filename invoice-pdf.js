// Draws an invoice as a real PDF. No dependencies — nothing to install on Render.
//
// Always exactly one page: the layout is fixed, and the line-item table is
// capped so it can never push the totals or footer onto a second sheet.

/* ---------------- standard Helvetica metrics (units per 1000) ---------------- */
const W_REG = {32:278,33:278,34:355,35:556,36:556,37:889,38:667,39:191,40:333,41:333,42:389,43:584,
  44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,52:556,53:556,54:556,55:556,56:556,57:556,
  58:278,59:278,60:584,61:584,62:584,63:556,64:1015,65:667,66:667,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:500,75:667,76:556,77:833,78:722,79:778,80:667,81:778,82:722,83:667,84:611,85:722,
  86:667,87:944,88:667,89:667,90:611,91:278,92:278,93:278,94:469,95:556,96:333,97:556,98:556,99:500,
  100:556,101:556,102:278,103:556,104:556,105:222,106:222,107:500,108:222,109:833,110:556,111:556,
  112:556,113:556,114:333,115:500,116:278,117:556,118:500,119:722,120:500,121:500,122:500,123:334,
  124:260,125:334,126:584,151:1000,215:584,183:350,169:737};
const W_BOLD = {32:278,33:333,34:474,35:556,36:556,37:889,38:722,39:238,40:333,41:333,42:389,43:584,
  44:278,45:333,46:278,47:278,48:556,49:556,50:556,51:556,52:556,53:556,54:556,55:556,56:556,57:556,
  58:333,59:333,60:584,61:584,62:584,63:611,64:975,65:722,66:722,67:722,68:722,69:667,70:611,71:778,
  72:722,73:278,74:556,75:722,76:611,77:833,78:722,79:778,80:667,81:778,82:722,83:667,84:611,85:722,
  86:667,87:944,88:667,89:667,90:611,91:333,92:278,93:333,94:584,95:556,96:333,97:556,98:611,99:556,
  100:611,101:556,102:333,103:611,104:611,105:278,106:278,107:556,108:278,109:889,110:611,111:611,
  112:611,113:611,114:389,115:556,116:333,117:611,118:556,119:778,120:556,121:556,122:500,123:389,
  124:280,125:389,126:584,151:1000,215:584,183:350,169:737};

/** Unicode the invoice actually uses → the WinAnsi byte that draws it. */
const WINANSI = { '—':151, '–':150, '×':215, '·':183, '©':169, '’':146, '‘':145, '“':147, '”':148 };

function bytesOf(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const mapped = WINANSI[ch];
    if (mapped != null) { out.push(mapped); continue; }
    const code = ch.codePointAt(0);
    out.push(code < 256 ? code : 63);   // anything else becomes "?"
  }
  return out;
}

function widthOf(str, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let total = 0;
  for (const b of bytesOf(str)) total += (table[b] != null ? table[b] : 556);
  return total * size / 1000;
}

/** Escapes a string for a PDF literal, in WinAnsi bytes. */
function pdfString(str) {
  let out = '';
  for (const b of bytesOf(str)) {
    if (b === 40 || b === 41 || b === 92) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}

/* ---------------- a tiny drawing surface ---------------- */
const PAGE = { w: 612, h: 792 };          // US Letter, in points

class Canvas {
  constructor() { this.ops = []; }
  // PDF's origin is bottom-left; we think top-down, so flip here once.
  _y(y) { return PAGE.h - y; }

  color(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]
      .map(v => v.toFixed(3)).join(' ');
  }
  rect(x, y, w, h, hex) {
    this.ops.push(`${this.color(hex)} rg`, `${x} ${this._y(y + h)} ${w} ${h} re f`);
    return this;
  }
  /** Rounded rectangle, drawn with four bezier corners. */
  roundRect(x, y, w, h, r, hex) {
    const b = this._y(y + h), t = this._y(y), k = r * 0.5523;
    this.ops.push(`${this.color(hex)} rg`,
      `${x + r} ${b} m`,
      `${x + w - r} ${b} l`, `${x + w - r + k} ${b} ${x + w} ${b + r - k} ${x + w} ${b + r} c`,
      `${x + w} ${t - r} l`, `${x + w} ${t - r + k} ${x + w - r + k} ${t} ${x + w - r} ${t} c`,
      `${x + r} ${t} l`,     `${x + r - k} ${t} ${x} ${t - r + k} ${x} ${t - r} c`,
      `${x} ${b + r} l`,     `${x} ${b + r - k} ${x + r - k} ${b} ${x + r} ${b} c`,
      'f');
    return this;
  }
  line(x1, y1, x2, y2, hex, w = 1) {
    this.ops.push(`${this.color(hex)} RG`, `${w} w`,
      `${x1} ${this._y(y1)} m ${x2} ${this._y(y2)} l S`);
    return this;
  }
  /** A smooth multi-stop bar, drawn as thin interpolated strips. */
  gradient(x, y, w, h, stops) {
    const steps = Math.max(60, Math.round(w));
    const px = w / steps;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const seg = Math.min(Math.floor(t * (stops.length - 1)), stops.length - 2);
      const local = (t * (stops.length - 1)) - seg;
      const a = parseInt(stops[seg].slice(1), 16), b = parseInt(stops[seg + 1].slice(1), 16);
      const mix = sh => Math.round(((a >> sh & 255) * (1 - local)) + ((b >> sh & 255) * local));
      const hex = '#' + [mix(16), mix(8), mix(0)].map(v => v.toString(16).padStart(2, '0')).join('');
      // a hair of overlap so no white seams show between strips
      this.rect(x + i * px, y, px + 0.6, h, hex);
    }
    return this;
  }
  text(str, x, y, { size = 10, bold = false, hex = '#0A1224', align = 'left', spacing = 0 } = {}) {
    const s = String(str == null ? '' : str);
    if (!s) return this;
    let tx = x;
    const w = widthOf(s, size, bold) + spacing * Math.max(0, bytesOf(s).length - 1);
    if (align === 'right') tx = x - w;
    else if (align === 'center') tx = x - w / 2;
    this.ops.push('BT', `${this.color(hex)} rg`, `/${bold ? 'F2' : 'F1'} ${size} Tf`,
      spacing ? `${spacing} Tc` : '0 Tc',
      `1 0 0 1 ${tx.toFixed(2)} ${(this._y(y)).toFixed(2)} Tm`,
      `(${pdfString(s)}) Tj`, 'ET');
    return this;
  }
  /** Wraps to `maxLines` and ellipsises the overflow, so nothing ever runs long. */
  /** Shortens one unbreakable run of text until it fits. */
  _clip(word, maxW, size, bold) {
    if (widthOf(word, size, bold) <= maxW) return word;
    let w = word;
    while (w.length > 1 && widthOf(w + '...', size, bold) > maxW) w = w.slice(0, -1);
    return w + '...';
  }
  wrap(str, x, y, maxW, { size = 10, bold = false, hex = '#0A1224', leading = 1.35, maxLines = 3, measureOnly = false } = {}) {
    const words = String(str == null ? '' : str).split(/\s+/).filter(Boolean)
      .map(w => this._clip(w, maxW, size, bold));
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (widthOf(test, size, bold) <= maxW || !cur) cur = test;
      else { lines.push(cur); cur = word; }
      if (lines.length === maxLines) break;
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    if (lines.length === maxLines) {
      // did anything not fit?
      const used = lines.join(' ').split(/\s+/).length;
      if (used < words.length) {
        let last = lines[maxLines - 1];
        while (last && widthOf(last + '...', size, bold) > maxW) last = last.replace(/\s*\S+$/, '');
        lines[maxLines - 1] = last + '...';
      }
    }
    if (!measureOnly) lines.forEach((ln, i) => this.text(ln, x, y + i * size * leading, { size, bold, hex }));
    return { lines: lines.length, height: lines.length * size * leading };
  }
  stream() { return this.ops.join('\n'); }
}

/* ---------------- assemble the file ---------------- */
function buildPdf(canvas, title) {
  const content = canvas.stream();
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${pdfString(title)}) /Producer (JRNEE Hub) /Creator (JRNEE Technologies LLC) >>`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(o => { pdf += String(o).padStart(10, '0') + ' 00000 n \n'; });
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\n` +
         `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/* ---------------- the invoice layout ---------------- */
const INK = '#0A1224', SLATE = '#4B5A74', MUTED = '#92A0B8',
      BLUE = '#1257FF', LINE = '#E6EBF4', PANEL = '#F7F9FD', GOOD = '#0E9F6E';
const SPECTRUM = ['#22D3EE', '#1257FF', '#FBBF24', '#34D399', '#A78BFA', '#FF4D8D'];

const M = 54;                       // page margin
const RIGHT = PAGE.w - M;
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const money = n => '$' + Number(n || 0).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function niceDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** The J mark: a blue rounded tile with the hook drawn in white. */
function drawMark(c, x, y, size) {
  const s = size / 34;
  c.roundRect(x, y, size, size, size * 0.29, BLUE);
  const w = 2.8 * s;
  c.ops.push('1 1 1 RG', `${w} w`, '1 J', '1 j',
    `${x + 11 * s} ${c._y(y + 10.5 * s)} m`,
    `${x + 23 * s} ${c._y(y + 10.5 * s)} l`,
    `${x + 23 * s} ${c._y(y + 20.5 * s)} l`,
    // the hook at the foot of the J
    `${x + 23 * s} ${c._y(y + 23.3 * s)} ${x + 20.3 * s} ${c._y(y + 25.5 * s)} ${x + 18 * s} ${c._y(y + 25.5 * s)} c`,
    `${x + 15.7 * s} ${c._y(y + 25.5 * s)} ${x + 13 * s} ${c._y(y + 23.3 * s)} ${x + 13 * s} ${c._y(y + 20.5 * s)} c`,
    'S');
  // the dot
  const r = 2.9 * s, cx = x + 11 * s, cy = c._y(y + 10.5 * s), k = r * 0.5523;
  c.ops.push('1 1 1 rg',
    `${cx - r} ${cy} m`,
    `${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} c`,
    `${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} c`,
    `${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} c`,
    `${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} c`, 'f');
}

function label(c, text, x, y) {
  c.text(String(text).toUpperCase(), x, y, { size: 6.6, hex: MUTED, spacing: 1.2 });
}

function invoicePdf(inv) {
  const c = new Canvas();
  let y = M;

  /* ---- header ---- */
  drawMark(c, M, y, 34);
  c.text('JRNEE', M + 46, y + 13, { size: 19, bold: true, hex: INK });
  c.text('.ai', M + 46 + widthOf('JRNEE', 19, true), y + 13, { size: 19, bold: true, hex: BLUE });
  c.text(inv.from.legal, M + 46, y + 27, { size: 8, hex: MUTED });

  c.text('Invoice', RIGHT, y + 15, { size: 23, bold: true, hex: INK, align: 'right' });
  c.text('#' + inv.number, RIGHT, y + 30, { size: 10.5, hex: BLUE, align: 'right' });
  if (inv.status === 'paid') {
    const w = widthOf('PAID', 7, true) + 16;
    c.roundRect(RIGHT - w, y + 36, w, 14, 7, '#E7F7F0');
    c.text('PAID', RIGHT - w / 2, y + 45.5, { size: 7, bold: true, hex: GOOD, align: 'center', spacing: 1 });
  }

  y += 56;
  c.gradient(M, y, RIGHT - M, 2.5, SPECTRUM);

  /* ---- who, when ---- */
  y += 24;
  const span = RIGHT - M;
  const widths = [0.30, 0.28, 0.19, 0.23].map(f => f * span);
  const starts = widths.reduce((a, w, i) => (a.push(i ? a[i-1] + widths[i-1] : M), a), []);
  const cols = [
    { k: 'Billed to', lines: [[inv.billTo.name, true], [inv.billTo.domain, false]] },
    { k: 'From',      lines: [[inv.from.legal, true], [inv.from.line1, false], [inv.from.email, false]] },
    { k: 'Issued',    lines: [[niceDate(inv.issuedOn), false]] },
    { k: 'Due',       lines: [[niceDate(inv.dueOn), true], [`Net ${inv.termsDays}`, false]] }
  ];
  let metaBottom = y;
  cols.forEach((col, i) => {
    const x = starts[i];
    label(c, col.k, x, y);
    let ly = y + 14;
    col.lines.forEach(([txt, bold]) => {
      if (!txt) return;
      const r = c.wrap(txt, x, ly, widths[i] - 14,
        { size: bold ? 9.5 : 8.6, bold, hex: bold ? INK : SLATE, maxLines: 2, leading: 1.25 });
      ly += r.height + 2.5;
    });
    metaBottom = Math.max(metaBottom, ly);
  });

  /* ---- line items ---- */
  y = metaBottom + 16;
  const COL_QTY = M + (RIGHT - M) * 0.60, COL_RATE = M + (RIGHT - M) * 0.78, COL_AMT = RIGHT;
  label(c, 'Description', M, y);
  c.text('QTY', COL_QTY, y, { size: 6.6, hex: MUTED, spacing: 1.2, align: 'right' });
  c.text('RATE', COL_RATE, y, { size: 6.6, hex: MUTED, spacing: 1.2, align: 'right' });
  c.text('AMOUNT', COL_AMT, y, { size: 6.6, hex: MUTED, spacing: 1.2, align: 'right' });
  y += 9;
  c.line(M, y, RIGHT, y, LINE, 1);

  // One page, guaranteed: work out how much room the table actually has once
  // the totals, payment panel and footer have taken their share, then only
  // draw the rows that fit.
  const PANEL_H = 86;
  const TOTALS_H = 62;                       // subtotal + rule + total due
  const FOOT_H = 40;                         // the thank-you line and its rule
  const tableFloor = PAGE.h - M - FOOT_H - PANEL_H - 24 - TOTALS_H;

  const allLines = inv.lines || [];
  const drawn = [];
  let cursor = y;
  for (const l of allLines) {
    // measure the row before committing to it
    const head = c.wrap(l.description, M, 0, (COL_QTY - M) - 26,
      { size: 10.5, bold: true, maxLines: 2, leading: 1.3, measureOnly: true });
    const det = l.detail ? c.wrap(l.detail, M, 0, (COL_QTY - M) - 26,
      { size: 8.6, maxLines: 2, leading: 1.3, measureOnly: true }) : { height: 0 };
    const rowH = Math.max(18 + 18, 18 + head.height + 2 + det.height + 6);
    if (cursor + rowH > tableFloor) break;
    drawn.push(l);
    cursor += rowH;
  }
  const lines = drawn;
  const hidden = allLines.length - lines.length;

  lines.forEach(l => {
    y += 18;
    const r = c.wrap(l.description, M, y, (COL_QTY - M) - 26,
      { size: 10.5, bold: true, hex: INK, maxLines: 2, leading: 1.3 });
    let sub = y + r.height + 2;
    if (l.detail) {
      const d = c.wrap(l.detail, M, sub, (COL_QTY - M) - 26,
        { size: 8.6, hex: MUTED, maxLines: 2, leading: 1.3 });
      sub += d.height;
    }
    c.text(String(l.qty), COL_QTY, y + 8, { size: 10, hex: SLATE, align: 'right' });
    c.text(money(l.rate), COL_RATE, y + 8, { size: 10, hex: SLATE, align: 'right' });
    c.text(money(l.amount), COL_AMT, y + 8, { size: 10, bold: true, hex: INK, align: 'right' });
    y = Math.max(y + 18, sub + 6);
    c.line(M, y, RIGHT, y, '#EEF1F7', 0.8);
  });
  if (hidden > 0) {
    y += 15;
    c.text(`+ ${hidden} more item${hidden === 1 ? '' : 's'} on the attached statement`, M, y,
      { size: 8.6, hex: MUTED });
  }

  /* ---- totals ---- */
  y += 22;
  const SUM_L = RIGHT - 210;
  c.text('Subtotal', SUM_L, y, { size: 9.8, hex: SLATE });
  c.text(money(inv.subtotal), RIGHT, y, { size: 9.8, hex: INK, align: 'right' });
  y += 12;
  c.line(SUM_L, y, RIGHT, y, INK, 1.4);
  y += 19;
  c.text('Total due', SUM_L, y, { size: 14, bold: true, hex: INK });
  c.text(money(inv.total), RIGHT, y, { size: 15.5, bold: true, hex: INK, align: 'right' });

  /* ---- payment panel ---- */
  const panelY = Math.min(y + 38, PAGE.h - M - FOOT_H - PANEL_H);
  c.rect(M, panelY, RIGHT - M, PANEL_H, PANEL);
  c.line(M, panelY, RIGHT, panelY, LINE, 0.8);
  c.line(M, panelY + PANEL_H, RIGHT, panelY + PANEL_H, LINE, 0.8);

  let py = panelY + 20;
  const payCols = [
    ['Make payable to', inv.from.payTo],
    ['How to pay', inv.from.payNote],
    ['Questions', inv.from.email]
  ];
  payCols.forEach(([k, v], i) => {
    const x = M + 16 + i * ((RIGHT - M - 32) / 3);
    label(c, k, x, py);
    c.wrap(v, x, py + 13, (RIGHT - M - 32) / 3 - 16,
      { size: 8.8, hex: i === 2 ? BLUE : SLATE, maxLines: 3, leading: 1.35 });
  });

  py = PAGE.h - M - 20;
  c.line(M, py - 12, RIGHT, py - 12, LINE, 0.8);
  c.text("Thank you — it's a pleasure building with you.", M, py, { size: 8.6, hex: MUTED });
  c.text(`${inv.from.legal} · ${inv.from.site}`, RIGHT, py, { size: 8.6, hex: MUTED, align: 'right' });

  const title = `Invoice ${inv.number} — ${inv.billTo.name} — ${inv.monthLabel}`;
  return buildPdf(c, title);
}

/** What the downloaded file should be called. */
function fileName(inv) {
  return `Invoice ${inv.number} - ${inv.billTo.name} - ${inv.monthLabel}.pdf`
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { invoicePdf, fileName };
