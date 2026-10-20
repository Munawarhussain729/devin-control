// Tiny SVG chart helpers — no dependencies, everything is an escaped string
// built from theme CSS variables resolved at render time.

import { esc, fmtInt, fmtNum } from './core.js';

export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n, d) => cs.getPropertyValue(n).trim() || d;
  return {
    accent: v('--accent', '#4f8cff'),
    ok: v('--ok', '#3fb950'),
    warn: v('--warn', '#e3b341'),
    err: v('--err', '#f85149'),
    run: v('--run', '#58a6ff'),
    muted: v('--muted', '#8b98a8'),
    line: v('--line', '#2a3340'),
    text: v('--text', '#e6edf3'),
  };
}

export const PALETTE = ['#58a6ff', '#3fb950', '#e3b341', '#f778ba', '#a371f7', '#76e3ea', '#ffa657', '#d2a8ff', '#7ee787', '#ff9bce'];

const FONT = "font-size:11px;fill:currentColor;font-family:inherit";

// Vertical bar chart. labels: string[], values: number[]
export function barChart({ labels, values, color, height = 150, fmt = fmtInt }) {
  const t = theme();
  color = color || t.accent;
  const W = 600, H = height, padB = 18, padT = 16;
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const bw = W / n;
  const barW = Math.max(2, Math.min(34, bw * 0.62));
  const step = Math.max(1, Math.ceil(n / 8));
  let bars = '';
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const h = ((H - padB - padT) * v) / max;
    const x = i * bw + (bw - barW) / 2;
    const y = H - padB - h;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}"><title>${esc(labels[i])}: ${fmt(v)}</title></rect>`;
    if (v > 0 && bw >= 26)
      bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" style="${FONT}" opacity=".75">${fmt(v)}</text>`;
    if (i % step === 0)
      bars += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" style="${FONT}" opacity=".55">${esc(labels[i])}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">${bars}</svg>`;
}

// Filled area + line chart. Same signature as barChart.
export function areaChart({ labels, values, color, height = 150, fmt = (n) => fmtNum(n, 1) }) {
  const t = theme();
  color = color || t.run;
  const W = 600, H = height, padB = 18, padT = 14;
  const max = Math.max(0.001, ...values);
  const n = Math.max(2, values.length);
  const step = Math.max(1, Math.ceil(labels.length / 8));
  const px = (i) => (i / (n - 1)) * W;
  const py = (v) => H - padB - ((H - padB - padT) * v) / max;
  const pts = values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
  const gid = 'g' + Math.random().toString(36).slice(2, 8);
  let lab = '';
  for (let i = 0; i < labels.length; i += step)
    lab += `<text x="${px(i).toFixed(1)}" y="${H - 4}" text-anchor="middle" style="${FONT}" opacity=".55">${esc(labels[i])}</text>`;
  const dots = values
    .map((v, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="${values.length > 45 ? 0 : 2.4}" fill="${color}"><title>${esc(labels[i])}: ${fmt(v)}</title></circle>`)
    .join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="0,${H - padB} ${pts.join(' ')} ${W},${H - padB}" fill="url(#${gid})"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${lab}
  </svg>`;
}

// Donut chart. parts: [{label, value, color}]
export function donut({ parts, size = 150, fmt = fmtInt }) {
  const t = theme();
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 60, C = 2 * Math.PI * R;
  let off = 0;
  let segs = '';
  for (const p of parts.filter((x) => x.value > 0)) {
    const len = (p.value / (total || 1)) * C;
    segs += `<circle r="${R}" cx="0" cy="0" fill="none" stroke="${p.color}" stroke-width="22"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90)"><title>${esc(p.label)}: ${fmt(p.value)}</title></circle>`;
    off += len;
  }
  return `<div class="donut-wrap"><svg class="chart donut" viewBox="-80 -80 160 160" role="img" style="max-width:${size}px">
    ${total ? segs : `<circle r="${R}" cx="0" cy="0" fill="none" stroke="${t.line}" stroke-width="22"/>`}
    <text x="0" y="-2" text-anchor="middle" style="font-size:22px;font-weight:700;fill:${t.text}">${fmtInt(total)}</text>
    <text x="0" y="16" text-anchor="middle" style="font-size:10px;fill:${t.muted}">total</text>
  </svg>
  <div class="legend">${parts
    .filter((p) => p.value > 0)
    .map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} <b>${fmt(p.value)}</b></span>`)
    .join('')}</div></div>`;
}

// Horizontal bar rows (HTML, easier labels + click). rows: [{label, value, hint?, color?, key?}]
export function hbars({ rows, fmt = fmtInt, maxRows = 10 }) {
  const t = theme();
  const top = rows.slice(0, maxRows);
  const max = Math.max(1, ...top.map((r) => r.value));
  if (!top.length) return `<div class="empty">No data.</div>`;
  return `<div class="hbars">${top
    .map((r) => {
      const w = (100 * r.value) / max;
      return `<div class="hbar ${r.key ? 'click' : ''}" ${r.key ? `data-key="${esc(r.key)}"` : ''}>
        <span class="hl" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="ht"><span class="hf" style="width:${w.toFixed(1)}%;background:${r.color || t.accent}"></span></span>
        <span class="hv">${fmt(r.value)}${r.hint ? ` <i>${esc(r.hint)}</i>` : ''}</span>
      </div>`;
    })
    .join('')}</div>`;
}
