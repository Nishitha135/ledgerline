'use strict';

const $ = (id) => document.getElementById(id);
const MAX_PAISE = 1000000000000n;

const state = {
  token: sessionStorage.getItem('token'),
  user: JSON.parse(sessionStorage.getItem('user') || 'null'),
  accounts: [],
  last: null,    // the last money request, so it can be sent again with the SAME key
  pending: false, // true when we do not know whether the last request was processed
  statementFor: null,
};

// ---------- helpers: everything shown on the page goes through text nodes ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  for (const kid of kids.flat()) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid ?? '')));
  return e;
}
function clear(e) { e.replaceChildren(); return e; }

// Money is integer paise. Rupees are only for display and typing.
function rupees(paise) {
  let p = BigInt(paise);
  const neg = p < 0n;
  if (neg) p = -p;
  const whole = (p / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}\u20B9${whole}.${(p % 100n).toString().padStart(2, '0')}`;
}
function toPaise(text) {
  const m = /^\s*(\d{1,10})(?:\.(\d{1,2}))?\s*$/.exec(text || '');
  if (!m) return null;
  const p = BigInt(m[1]) * 100n + BigInt((m[2] || '0').padEnd(2, '0'));
  return p > 0n && p <= MAX_PAISE ? Number(p) : null;
}

async function api(method, path, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401 && state.token) logout('Session expired. Please sign in again.');
  return { status: res.status, ok: res.ok, data, replayed: res.headers.get('Idempotent-Replayed') === 'true' };
}

// ---------- session ----------
function logout(message) {
  sessionStorage.clear();
  state.token = null; state.user = null; state.accounts = []; state.last = null; state.pending = false; state.statementFor = null;
  render();
  $('login-msg').textContent = message || '';
}

function render() {
  const signedIn = Boolean(state.token && state.user);
  $('login-view').hidden = signedIn;
  $('app-view').hidden = !signedIn;
  $('logout').hidden = !signedIn;
  $('who').textContent = signedIn ? `${state.user.email} (${state.user.role})` : '';
  if (!signedIn) return;
  const role = state.user.role;
  $('readonly-note').hidden = role !== 'auditor';
  $('money').hidden = role === 'auditor';
  $('withdraw-form').hidden = role !== 'holder';
  $('transfer-form').hidden = role !== 'holder';
  $('create-form').hidden = role !== 'admin';
  $('audit').hidden = role === 'holder';
}

async function enter() {
  render();
  await refresh();
}

async function signIn(email, password) {
  const r = await api('POST', '/auth/login', { email, password });
  if (!r.ok) {
    $('login-msg').textContent = (r.data && r.data.error) || `Sign in failed (HTTP ${r.status})`;
    return;
  }
  state.token = r.data.token;
  state.user = r.data.user;
  sessionStorage.setItem('token', state.token);
  sessionStorage.setItem('user', JSON.stringify(state.user));
  $('password').value = '';
  $('login-msg').textContent = '';
  await enter();
}

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  signIn($('email').value, $('password').value);
});
$('register').addEventListener('click', async () => {
  const email = $('email').value;
  const password = $('password').value;
  const r = await api('POST', '/auth/register', { email, password });
  if (!r.ok) {
    $('login-msg').textContent = (r.data && r.data.error) || `Could not register (HTTP ${r.status})`;
    return;
  }
  await signIn(email, password);
});
document.querySelectorAll('[data-demo]').forEach((b) => {
  b.addEventListener('click', () => {
    const [email, password] = b.dataset.demo.split('|');
    $('email').value = email;
    $('password').value = password;
  });
});
$('logout').addEventListener('click', () => logout(''));

// ---------- accounts ----------
function fillSelect(select, accounts) {
  const keep = select.value;
  clear(select);
  for (const a of accounts) {
    select.append(h('option', { value: a.id }, `#${a.id} ${a.name} (${rupees(a.balance)})`));
  }
  if (keep && accounts.some((a) => a.id === keep)) select.value = keep;
}

function renderAccounts() {
  const t = clear($('accounts'));
  t.append(h('thead', {}, h('tr', {}, ...['No.', 'Account', 'Owner', 'Balance', 'Overdraft limit', ''].map((x) => h('th', {}, x)))));
  const body = h('tbody');
  for (const a of state.accounts) {
    const btn = h('button', { type: 'button', class: 'secondary small' }, 'Statement');
    btn.addEventListener('click', () => loadStatement(a.id));
    body.append(h('tr', {},
      h('td', {}, a.id),
      h('td', {}, a.is_system ? `${a.name} (system)` : a.name),
      h('td', {}, a.is_system ? '-' : `user ${a.owner_id}`),
      h('td', { class: 'num' }, rupees(a.balance)),
      h('td', { class: 'num' }, rupees(a.overdraft_limit)),
      h('td', {}, btn)));
  }
  t.append(body);
}

async function refresh() {
  const r = await api('GET', '/accounts');
  if (!r.ok) return;
  state.accounts = r.data;
  renderAccounts();
  const usable = state.accounts.filter((a) => !a.is_system);
  for (const id of ['dep-account', 'wd-account', 'tr-from']) fillSelect($(id), usable);
  if (state.statementFor) await loadStatement(state.statementFor);
  if (['admin', 'auditor'].includes(state.user.role)) await loadAudit();
}

// ---------- statement ----------
async function loadStatement(id) {
  state.statementFor = id;
  const box = clear($('statement'));
  const r = await api('GET', `/accounts/${id}/statement`);
  if (!r.ok) {
    box.append(h('p', { class: 'msg' }, (r.data && r.data.error) || `Could not load (HTTP ${r.status})`));
    return;
  }
  const { account, entries } = r.data;
  box.append(h('p', {}, h('strong', {}, account.name), ` (account ${account.id}), balance ${rupees(account.balance)}`));
  if (!entries.length) {
    box.append(h('p', { class: 'hint' }, 'No activity yet.'));
    return;
  }
  const t = h('table', {}, h('thead', {}, h('tr', {},
    ...['When', 'Result', 'Type', 'Amount', 'Balance after', 'By', 'Reason'].map((x) => h('th', {}, x)))));
  const body = h('tbody');
  for (const e of entries) {
    const refused = e.kind === 'refused';
    const amount = refused ? rupees(e.amount) : `${e.direction === 'debit' ? '-' : '+'}${rupees(e.amount)}`;
    body.append(h('tr', { class: refused ? 'refused' : '' },
      h('td', {}, new Date(e.created_at).toLocaleString()),
      h('td', {}, refused ? 'refused' : 'posted'),
      h('td', {}, e.type),
      h('td', { class: 'num' }, amount),
      h('td', { class: 'num' }, e.balance_after === null ? '-' : rupees(e.balance_after)),
      h('td', {}, e.initiated_by),
      h('td', {}, e.reason || '')));
  }
  t.append(body);
  box.append(h('div', { class: 'scroll' }, t));
}

// ---------- audit (admin and auditor) ----------
async function loadAudit() {
  const box = clear($('reconcile'));
  const rec = await api('GET', '/audit/reconcile');
  if (rec.ok) {
    const d = rec.data;
    box.append(
      h('p', { class: d.ok ? 'good-text' : 'bad-text' }, d.ok ? 'Books balance: every check passes' : 'MISMATCH FOUND'),
      h('ul', {},
        h('li', {}, `Sum of all balances: ${rupees(d.totalBalance)} (must be 0.00)`),
        h('li', {}, `Ledger entries: ${d.ledgerEntries}`),
        h('li', {}, `Transactions whose debits and credits differ: ${d.unbalancedTransactions.length}`),
        h('li', {}, `Accounts whose balance differs from the ledger: ${d.mismatchedAccounts.length}`),
        h('li', {}, `Duplicate requests blocked: ${d.duplicateRequestsBlocked}`),
        h('li', {}, `Checked at ${new Date(d.checkedAt).toLocaleString()}`)));
  } else {
    box.append(h('p', { class: 'msg' }, `Could not run the checks (HTTP ${rec.status})`));
  }
  const ref = await api('GET', '/audit/refused?limit=50');
  const rbox = clear($('refused'));
  if (!ref.ok) return;
  if (!ref.data.length) {
    rbox.append(h('p', { class: 'hint' }, 'No refused attempts.'));
    return;
  }
  const t = h('table', {}, h('thead', {}, h('tr', {},
    ...['When', 'By', 'Type', 'Amount', 'Reason'].map((x) => h('th', {}, x)))));
  const body = h('tbody');
  for (const e of ref.data) {
    body.append(h('tr', {},
      h('td', {}, new Date(e.created_at).toLocaleString()),
      h('td', {}, e.initiated_by),
      h('td', {}, e.type),
      h('td', { class: 'num' }, e.amount === null ? '-' : rupees(e.amount)),
      h('td', {}, e.reason)));
  }
  t.append(body);
  rbox.append(t);
}
$('recheck').addEventListener('click', loadAudit);

// ---------- money movement ----------
function showResult(attempt, r) {
  const box = clear($('result'));
  box.hidden = false;
  if (!r) {
    box.className = 'result bad';
    box.append(h('strong', {}, 'No answer from the server. '),
      'The request may or may not have been processed. Sending it again with the same key is safe: the money moves at most once.');
  } else if (r.ok) {
    box.className = 'result good';
    box.append(h('strong', {}, `${attempt.label} done. `),
      `Transaction ${r.data.transactionId}. Balance of the account is now ${rupees(r.data.balance)}.`);
    if (r.replayed) {
      box.append(h('div', { class: 'note' }, 'Replayed: this key was already used, so the first answer was returned and no money moved again.'));
    }
  } else {
    box.className = 'result bad';
    box.append(h('strong', {}, `${attempt.label} not done. `),
      `${(r.data && r.data.error) || 'Request failed'} (HTTP ${r.status}).`);
    if (r.data && r.data.refused) {
      box.append(h('div', { class: 'note' }, 'No money moved. The refusal is recorded in the ledger.'));
    }
  }
  const again = h('button', { type: 'button', class: 'secondary small' },
    state.pending ? 'Retry with the same key' : 'Send again with the same key (money still moves once)');
  again.addEventListener('click', () => sendMoney(state.last));
  box.append(h('div', {}, again));
  box.append(h('div', { class: 'key' }, `Idempotency-Key: ${attempt.key}`));
}

function showMessage(text, kind) {
  const box = clear($('result'));
  box.hidden = false;
  box.className = `result ${kind}`;
  box.append(text);
}

function setBusy(on) {
  document.querySelectorAll('#money button[type=submit]').forEach((b) => { b.disabled = on; });
}

async function sendMoney(attempt) {
  state.last = attempt;
  setBusy(true);
  let r = null;
  try {
    r = await api('POST', attempt.path, attempt.body, { 'Idempotency-Key': attempt.key });
    state.pending = r.status >= 500;
  } catch (err) {
    state.pending = true; // network failure: we do not know whether it was processed
  }
  if (state.token) showResult(attempt, r);
  setBusy(false);
  if (state.token && r && r.status !== 401) await refresh();
}

function bindMoneyForm(formId, build) {
  $(formId).addEventListener('submit', (ev) => {
    ev.preventDefault();
    const attempt = build();
    if (attempt) sendMoney(attempt);
  });
}

const BAD_INPUT = 'Enter a valid account and an amount in rupees, for example 250.50.';

bindMoneyForm('deposit-form', () => {
  const amount = toPaise($('dep-amount').value);
  const id = $('dep-account').value;
  if (!amount || !id) { showMessage(BAD_INPUT, 'bad'); return null; }
  return { label: 'Deposit', key: crypto.randomUUID(), path: `/accounts/${id}/deposit`, body: { amount } };
});

bindMoneyForm('withdraw-form', () => {
  const amount = toPaise($('wd-amount').value);
  const id = $('wd-account').value;
  if (!amount || !id) { showMessage(BAD_INPUT, 'bad'); return null; }
  return { label: 'Withdrawal', key: crypto.randomUUID(), path: `/accounts/${id}/withdraw`, body: { amount } };
});

bindMoneyForm('transfer-form', () => {
  const amount = toPaise($('tr-amount').value);
  const from = $('tr-from').value;
  const to = $('tr-to').value.trim();
  if (!amount || !from || !/^[1-9]\d{0,17}$/.test(to)) { showMessage(BAD_INPUT, 'bad'); return null; }
  return {
    label: 'Transfer', key: crypto.randomUUID(), path: '/transfers',
    body: { fromAccountId: from, toAccountId: to, amount },
  };
});

// ---------- admin: create an account ----------
$('create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = $('cr-overdraft').value.trim();
  const overdraft = text === '' || /^0+(\.0{1,2})?$/.test(text) ? 0 : toPaise(text);
  if (overdraft === null) { showMessage('Overdraft must be an amount in rupees, or empty for none.', 'bad'); return; }
  const r = await api('POST', '/accounts', {
    ownerEmail: $('cr-email').value, name: $('cr-name').value, overdraftLimit: overdraft,
  });
  if (r.ok) {
    showMessage(`Account ${r.data.id} created.`, 'good');
    ev.target.reset();
    await refresh();
  } else {
    showMessage(`${(r.data && r.data.error) || 'Failed'} (HTTP ${r.status})`, 'bad');
  }
});

// ---------- start ----------
if (state.token && state.user) enter(); else render();
