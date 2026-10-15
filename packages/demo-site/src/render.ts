import type { Notice } from './notices.js';

export const DEMO_LABEL = 'DEMONSTRATION: synthetic notice, not a real government document.';
export const SITE_LABEL = 'Synthetic demonstration site for Chronicle. Not affiliated with any government.';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** `2026-10-30` -> `30 October 2026`. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

export function formatInr(amount: number): string {
  return amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/** IST wall-clock time without periods, so the `last updated` pattern covers the whole line. */
export function formatIstTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

interface Volatile {
  visitors: number;
  now: number;
}

function layout(title: string, main: string, v: Volatile): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:0 16px;color:#1b1b1b}
.top-banner{background:#7a1f1f;color:#fff;padding:8px 12px;font-weight:600}
.demo-label{border:2px dashed #7a1f1f;padding:8px;font-weight:600}
nav a{margin-right:12px}
footer{border-top:1px solid #ccc;margin-top:32px;padding:12px 0;font-size:.85em;color:#555}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}
</style>
</head>
<body>
<div class="top-banner">${escapeHtml(DEMO_LABEL)}</div>
<header><h2>Demo Government Portal (synthetic)</h2></header>
<nav class="main-menu"><a href="/circulars/">Circulars</a><a href="/admin">Demo admin</a></nav>
${main}
<footer>
<p>${escapeHtml(SITE_LABEL)}</p>
<div class="visitor-counter">Visitors: ${v.visitors}</div>
</footer>
</body>
</html>
`;
}

export function renderNotice(n: Notice, v: Volatile): string {
  const main = `<main>
<p class="demo-label">${escapeHtml(DEMO_LABEL)}</p>
<h1>${escapeHtml(n.title)}</h1>
<p class="circular-no">Circular No. ${escapeHtml(n.circularNo)}</p>
<p class="printed-date">Date: ${formatDate(n.printedDate)}</p>
<p class="department">Department: ${escapeHtml(n.department)}</p>
<p class="scheme">Scheme: ${escapeHtml(n.scheme)}</p>
${n.clauses.map((c) => `<p class="clause">${escapeHtml(c)}</p>`).join('\n')}
<p class="deadline">Last date to apply: ${formatDate(n.deadline)}</p>
<p class="amount">Amount: Rs. ${formatInr(n.amountInr)} ${escapeHtml(n.amountUnit)}</p>
<p class="pdf-link"><a href="/circulars/${n.id}.pdf">Download this circular (PDF)</a></p>
<p class="page-stats">Last updated: ${formatIstTime(v.now)} IST</p>
<p class="page-stats">Visitors: ${v.visitors}</p>
</main>`;
  return layout(`${n.title} | ${n.department} (synthetic demo)`, main, v);
}

export function renderIndex(notices: Notice[], v: Volatile): string {
  const rows = notices
    .map(
      (n) => `<tr><td>${escapeHtml(n.circularNo)}</td><td><a href="/circulars/${n.id}">${escapeHtml(n.title)}</a></td>
<td>${escapeHtml(n.department)}</td><td>${formatDate(n.printedDate)}</td><td><a href="/circulars/${n.id}.pdf">PDF</a></td></tr>`,
    )
    .join('\n');
  const main = `<main>
<p class="demo-label">${escapeHtml(DEMO_LABEL)}</p>
<h1>Circulars archive (synthetic)</h1>
<table>
<thead><tr><th>Circular No.</th><th>Title</th><th>Department</th><th>Date</th><th>File</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="page-stats">Last updated: ${formatIstTime(v.now)} IST</p>
</main>`;
  return layout('Circulars archive | Demo Government Portal (synthetic demo)', main, v);
}

export function renderMessage(heading: string, message: string, v: Volatile): string {
  const main = `<main>
<p class="demo-label">${escapeHtml(DEMO_LABEL)}</p>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
</main>`;
  return layout(`${heading} | Demo Government Portal (synthetic demo)`, main, v);
}

export const SOFT_REMOVED_MESSAGE =
  'The page you requested is no longer available. It may have been moved or withdrawn. Please visit the circulars archive.';

export function renderAdmin(): string {
  const options = ['001', '002', '003'].map((id) => `<option>${id}</option>`).join('');
  const actions: [string, string][] = [
    ['edit_deadline', 'YYYY-MM-DD'],
    ['edit_amount', 'rupees'],
    ['edit_text', 'new eligibility clause'],
    ['backdate', 'YYYY-MM-DD (optional)'],
    ['hide_from_vantage', 'vantage label, e.g. eu-vps (simulation)'],
    ['remove_404', ''],
    ['remove_410', ''],
    ['soft_remove', ''],
    ['redirect', ''],
    ['delist', ''],
    ['restore', ''],
  ];
  const buttons = actions
    .map(([a, hint]) => `<button data-action="${a}" title="${escapeHtml(hint)}">${a}</button>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Demo admin (synthetic)</title>
<style>
body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:0 16px}
.top-banner{background:#7a1f1f;color:#fff;padding:8px 12px;font-weight:600}
label{display:block;margin:8px 0}button{margin:4px}pre{background:#f4f4f4;padding:8px;overflow:auto}
</style></head>
<body>
<div class="top-banner">${escapeHtml(SITE_LABEL)}</div>
<h1>Demo admin panel</h1>
<p>Mutates the synthetic notices to drive the Chronicle demo. <code>hide_from_vantage</code> is a simulation of geo-selective removal: requests whose <code>x-chronicle-vantage</code> header matches get a 404.</p>
<label>Admin token <input id="token" type="password" autocomplete="off"></label>
<label>Notice <select id="id">${options}</select></label>
<label>Value <input id="value" size="50" placeholder="see button tooltip"></label>
<div>${buttons}</div>
<p><button id="state">Show state</button> <button id="reset">Reset all</button></p>
<pre id="out"></pre>
<script>
const $ = (id) => document.getElementById(id);
async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-admin-token': $('token').value, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  $('out').textContent = res.status + '\\n' + JSON.stringify(await res.json(), null, 2);
}
document.querySelectorAll('button[data-action]').forEach((b) =>
  b.addEventListener('click', () => {
    const value = $('value').value.trim();
    call('POST', '/admin/mutate', { id: $('id').value, action: b.dataset.action, ...(value ? { value } : {}) });
  }),
);
$('state').addEventListener('click', () => call('GET', '/admin/state'));
$('reset').addEventListener('click', () => call('POST', '/admin/reset', {}));
</script>
</body>
</html>
`;
}
