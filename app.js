import * as E from './engine.js';

const KEY = 'margin.state';
const PREV = 'margin.prev';
const VERSION = '1.2.0';

let S = null;               // app state
let bootError = null;       // { kind, raw }
let setupToken = null;      // from #s= in the URL
let lastToday = null;
let saveFailed = false;
const ui = { tab: 'today', logFilter: 'all', logQuery: '', logLimit: 120, laterBackup: false, setupStep: null, setupData: null };

/* ---------------- environment ---------------- */
const params = new URLSearchParams(location.search);
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
function today() { return (isLocal && params.get('today')) || E.todayISO(); }
function hourNow() { return isLocal && params.get('hour') ? Number(params.get('hour')) : new Date().getHours(); }
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ---------------- dom helpers ---------------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
function put(el, ...kids) { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; }
const NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of kids) if (c) el.append(c);
  return el;
}
const icon = {
  plus: () => sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }, sv('path', { d: 'M12 5v14M5 12h14' })),
  back: () => sv('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, sv('path', { d: 'M9 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5-6z' }), sv('path', { d: 'M12 10l4 4m0-4l-4 4' })),
  share: () => sv('svg', { class: 'share-glyph', viewBox: '0 0 16 20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, sv('path', { d: 'M8 1v11M4.5 4.5L8 1l3.5 3.5' }), sv('path', { d: 'M5 8H2.5v10.5h11V8H11' })),
};
const dots = () => h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
const money = (p, o) => E.fmt(p, o);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

/* ---------------- storage ---------------- */
function load() {
  let raw;
  try { raw = localStorage.getItem(KEY); } catch { bootError = { kind: 'blocked' }; return; }
  if (!raw) { S = E.emptyState(); return; }
  try { S = E.validateState(JSON.parse(raw)); return; } catch { /* fall through */ }
  try {
    const prev = localStorage.getItem(PREV);
    if (prev) { S = E.validateState(JSON.parse(prev)); toastLater('Recovered your data from the last good save.'); return; }
  } catch { /* fall through */ }
  bootError = { kind: 'corrupt', raw };
}
function save() {
  try {
    const json = JSON.stringify(S);
    const old = localStorage.getItem(KEY);
    let oldOk = false; try { oldOk = !!old && !!JSON.parse(old).v; } catch { oldOk = false; }
    if (oldOk && old !== json) localStorage.setItem(PREV, old);
    else if (!oldOk) localStorage.setItem(PREV, json); // always keep a good fallback copy
    localStorage.setItem(KEY, json);
    saveFailed = false;
    return true;
  } catch {
    saveFailed = true;
    toast('This phone wouldn’t let Margin save. Make a backup from the menu.');
    return false;
  }
}
let pendingToast = null;
function toastLater(msg) { pendingToast = msg; }

// Every change goes through commit(): it saves, re-renders and offers Undo.
function commit(mutate, message, { undo = true, celebrate = false, react = null } = {}) {
  const before = JSON.stringify(S);
  mutate();
  const queued = [];
  if (S.plan && S.meta.reactions && (celebrate || react)) {
    const prev = E.validateState(JSON.parse(before));
    if (react) { const r = react(prev); if (r) queued.push(r); }
    if (celebrate) for (const d of E.clearedDebts(prev, S)) { S.meta.fx.debts[d.id] = 1; queued.push({ kind: 'debt', debt: d }); }
  }
  if (!save()) { S = E.validateState(JSON.parse(before)); render(); return; }
  const after = JSON.stringify(S);
  render();
  queued.forEach(showReaction);
  if (message) toast(message, undo ? () => {
    if (JSON.stringify(S) !== after) { toast('Too late to undo that one.'); return; }
    S = E.validateState(JSON.parse(before)); save(); render(); toast('Undone.');
  } : null);
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, onUndo = null) {
  const root = document.getElementById('toast-root');
  root.replaceChildren();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast', role: 'status' }, h('div', { class: 'msg', text: msg }),
    onUndo && h('button', { text: 'Undo', onclick: () => { root.replaceChildren(); clearTimeout(toastTimer); onUndo(); } }));
  root.append(el);
  toastTimer = setTimeout(() => root.replaceChildren(), onUndo ? 6000 : 3500);
}

/* ---------------- sheets ---------------- */
let currentSheet = null;
function openSheet(title, build, { onClose } = {}) {
  closeSheet(true);
  document.getElementById('toast-root').replaceChildren();
  const root = document.getElementById('sheet-root');
  const backdrop = h('div', { class: 'backdrop' });
  const body = h('div', { class: 'body' });
  const head = h('div', { class: 'head' }, h('h3', { text: title }), h('button', { class: 'btn quiet', text: 'Close', onclick: () => close() }));
  const grab = h('div', { class: 'grab', 'aria-hidden': 'true' }, h('i'));
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, grab, head, body);
  let closed = false;
  function close(instant = false) {
    if (closed) return; closed = true;
    currentSheet = null;
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
    if (instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { backdrop.remove(); sheet.remove(); return; }
    sheet.classList.add('closing'); backdrop.classList.add('closing');
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 200);
  }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', () => close());
  // drag down to close
  let y0 = null, dy = 0;
  grab.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  grab.addEventListener('touchmove', (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sheet.style.transform = `translateY(${dy}px)`; }, { passive: true });
  grab.addEventListener('touchend', () => { if (dy > 90) close(); else sheet.style.transform = ''; y0 = null; });
  const api = { close, body, setTitle: (t) => { head.firstChild.textContent = t; }, refresh: () => { body.replaceChildren(); build(body, api); } };
  build(body, api);
  root.append(backdrop, sheet);
  currentSheet = api;
  return api;
}
function closeSheet(instant) { if (currentSheet) currentSheet.close(instant); }

/* ---------------- render root ---------------- */
function render() {
  lastToday = today();
  const app = document.getElementById('app');
  const keepScroll = app.dataset.tab === ui.tab ? window.scrollY : 0;
  app.replaceChildren();
  if (bootError) { app.append(recoveryScreen()); return; }
  if (setupToken && ui.setupStep) { app.append(setupScreen()); return; }
  if (!S.plan) { app.append(welcomeScreen()); return; }
  app.dataset.tab = ui.tab;
  const screens = { today: todayScreen, plan: planScreen, road: roadScreen, log: logScreen };
  app.append((screens[ui.tab] || todayScreen)(), tabBar());
  window.scrollTo(0, keepScroll);
  if (pendingToast) { toast(pendingToast); pendingToast = null; }
}

function tabBar() {
  const tab = (id, label) => h('button', { class: 'tab' + (ui.tab === id ? ' on' : ''), text: label, 'aria-current': ui.tab === id ? 'page' : null, onclick: () => { if (ui.tab !== id) { ui.tab = id; if (id !== 'log') ui.logFilter = 'all'; render(); window.scrollTo(0, 0); } } });
  return h('nav', { class: 'tabs', 'aria-label': 'Sections' }, h('div', { class: 'in' },
    tab('today', 'Today'), tab('plan', 'Plan'),
    h('button', { class: 'plus', 'aria-label': 'Add spending', onclick: () => openAdd() }, icon.plus()),
    tab('road', 'Road'), tab('log', 'Log')));
}

function topline(text) {
  return h('div', { class: 'topline' }, h('div', { class: 'eyebrow', text }),
    h('button', { class: 'iconbtn', 'aria-label': 'Menu', onclick: openMenu }, dots()));
}

/* ================= TODAY ================= */
function todayScreen() {
  const t = today();
  const started = E.planStarted(S, t);
  const sf = E.safeToSpend(S, t);
  const scr = h('main', { class: 'screen' });
  put(scr, topline(E.longDate(t)));

  if (sf.mode === 'warmup' && sf.unset) put(scr, warmupSetup(sf));
  else put(scr, hero(sf, t));

  put(scr, ...actionCards(t, started));

  if (started) put(scr, ...envelopesBlock(t));
  else put(scr, ...planStartsBlock(sf));

  put(scr, roadTeaser(t));

  const n = E.streak(S, t);
  if (n >= 2) put(scr, h('p', { class: 'muted', style: { textAlign: 'center', fontSize: '13px', marginTop: '28px' }, text: `${n} days logged in a row` }));
  return scr;
}

function hero(sf, t) {
  const over = sf.leftToday < 0;
  const wrap = h('section', { class: 'hero' });
  put(wrap, h('div', { class: 'label', text: over ? 'Over today’s share by' : 'Safe to spend today' }));
  put(wrap, h('div', { class: 'big num' + (over ? ' over' : '') }, h('span', { text: money(Math.abs(sf.leftToday)) }), h('span', { class: 'cur', text: 'EGP' })));
  const lines = [];
  if (sf.mode === 'cycle' && sf.delta) {
    const up = sf.delta > 0;
    lines.push(h('div', { class: 'delta ' + (up ? 'up' : 'down') }, h('b', { class: 'num', text: (up ? '+' : '−') + money(Math.abs(sf.delta)) }),
      up ? ' more than yesterday — unspent money rolls forward.' : ' less than yesterday — yesterday’s spending is spread over the days left.'));
  }
  if (sf.overToday > 0) lines.push(h('div', {}, h('b', { class: 'num', text: money(sf.overToday) }), ' of today’s share went to a bill or essential that ran over.'));
  if (sf.spentToday > 0) lines.push(h('div', {}, 'You’ve spent ', h('b', { class: 'num', text: money(sf.spentToday) }), ' of today’s ', h('b', { class: 'num', text: money(sf.daily) }), '.'));
  if (sf.mode === 'cycle') {
    if (sf.cycleLeft >= 0) lines.push(h('div', {}, h('b', { class: 'num', text: money(sf.cycleLeft) }), ` flexible money left until payday, ${E.shortDate(sf.cycle.nextPayday)}.`));
    else lines.push(h('div', {}, 'This cycle is ', h('b', { class: 'num', text: money(-sf.cycleLeft) }), ' over the flexible budget. Tomorrow’s share is zero until payday.'));
  } else {
    if (sf.cycleLeft >= 0) lines.push(h('div', {}, h('b', { class: 'num', text: money(sf.cycleLeft) }), ` left until your plan starts on ${E.shortDate(sf.planStart)}. `, h('button', { class: 'link', text: 'Change', onclick: editWarmup })));
    else lines.push(h('div', {}, 'You’re ', h('b', { class: 'num', text: money(-sf.cycleLeft) }), ' past what you set aside until payday. ', h('button', { class: 'link', text: 'Change', onclick: editWarmup })));
  }
  put(wrap, h('div', { class: 'sub' }, lines));
  // day ruler
  let start, end;
  if (sf.mode === 'cycle') { start = sf.cycle.start; end = sf.cycle.end; } else { start = S.warmup.setOn; end = E.addDays(sf.planStart, -1); }
  const len = Math.max(1, E.daysBetween(start, end) + 1);
  const idx = Math.min(len - 1, Math.max(0, E.daysBetween(start, t)));
  const ruler = h('div', { class: 'ruler', 'aria-hidden': 'true' }, h('div', { class: 'track' }));
  const done = h('div', { class: 'done' }); done.style.width = `${(idx / len) * 100}%`; ruler.append(done);
  if (len <= 40) for (let i = 1; i < len; i++) { const tk = h('div', { class: 'tick' }); tk.style.left = `${(i / len) * 100}%`; ruler.append(tk); }
  const now = h('div', { class: 'now' }); now.style.left = `calc(${((idx + 0.5) / len) * 100}% - 1px)`; ruler.append(now);
  put(wrap, ruler, h('div', { class: 'ruler-cap' },
    h('span', { text: sf.mode === 'cycle' ? `Day ${sf.cycle.dayIndex} of ${sf.cycle.length}` : 'Until payday' }),
    h('span', { text: `${plural(sf.daysLeft, 'day', 'days')} left` })));
  return wrap;
}

function warmupSetup(sf) {
  const wrap = h('section', { class: 'hero' });
  const input = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'e.g. 6,000', autocomplete: 'off', 'aria-label': 'Money left until payday' });
  const err = h('div', { class: 'errmsg' });
  const set = () => {
    const p = E.parseAmount(input.value);
    if (p == null) { err.textContent = 'Type an amount, like 6000.'; return; }
    commit(() => { S.warmup = { amount: p, setOn: today() }; }, 'Set. Your daily share is ready.');
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') set(); });
  put(wrap, 
    h('div', { class: 'label', text: 'Before your plan starts' }),
    h('h1', { class: 'title', text: `Your plan starts on payday, ${E.longDate(sf.planStart)}.` }),
    h('p', { class: 'lede', text: 'Until then, how much money do you have left to spend? Count everything — fuel and groceries too.' }),
    h('div', { class: 'field' }, input),
    err,
    h('button', { class: 'btn ink wide', text: 'Show my daily share', onclick: set }),
  );
  return wrap;
}
function editWarmup() {
  amountSheet({ title: 'Money until payday', label: 'Left to spend until your plan starts', initial: S.warmup ? S.warmup.amount : null, hint: 'Count from today. Spending you log from today on comes out of this.', confirm: 'Update' }, (p) => {
    commit(() => { S.warmup = { amount: p, setOn: today() }; }, 'Updated.');
  });
}

function card(cls, k, t, d, acts) {
  return h('div', { class: 'card ' + (cls || '') },
    k && h('div', { class: 'k', text: k }),
    t && h('div', { class: 't num', text: t }),
    d && h('div', { class: 'd' }, d),
    acts && acts.length ? h('div', { class: 'acts' }, acts) : null);
}

function actionCards(t, started) {
  const out = [];
  if (saveFailed) out.push(card('red', 'Not saved', 'Margin couldn’t save on this phone', 'Your last change may be lost if you close the app. Make a backup now.', [h('button', { class: 'btn ink', text: 'Back up now', onclick: exportBackup })]));

  // scheduled one-off payments (e.g. the card statement)
  for (const task of E.pendingTasks(S)) {
    const until = E.daysBetween(t, task.due);
    if (until > 3) continue;
    const when = until > 1 ? `Due in ${until} days · ${E.shortDate(task.due)}` : until === 1 ? 'Due tomorrow' : until === 0 ? 'Due today' : `Overdue since ${E.shortDate(task.due)}`;
    out.push(card(until < 0 ? 'red' : '', when, `${task.title} · ${money(task.amount)} EGP`,
      task.from === 'savings' ? `Pay this from your savings (${money(E.savingsBalance(S))} EGP).` : 'Pay this from this cycle’s money.',
      [h('button', { class: 'btn ink', text: 'Mark as paid', onclick: () => payTask(task) })]));
  }

  if (started) {
    const c = E.cycleInfo(S, t);
    // sweep last cycle
    const pk = E.prevKey(c.key);
    if (pk >= S.plan.startKey && !S.sweeps[pk] && c.dayIndex <= 10) {
      const ps = E.cycleStart(S, pk), pe = E.cycleEnd(S, pk);
      const pool = E.budgetFor(S, pk).lifestyle;
      const spent = E.entriesBetween(S, ps, pe).filter((e) => E.isLifestyleEntry(S, e)).reduce((a, e) => a + e.amount, 0);
      const left = pool - spent;
      if (left > 0) {
        const toDebt = E.totalDebt(S) > 0;
        out.push(card('green', 'Last cycle', `You finished with ${money(left)} EGP unspent`, toDebt ? 'Put it toward your debt? It brings the debt-free date closer.' : 'Move it to savings so it doesn’t drift away?', [
          h('button', { class: 'btn green', text: toDebt ? 'Put toward debt' : 'Move to savings', onclick: () => sweep(pk, left, toDebt) }),
          h('button', { class: 'btn quiet', text: 'Keep it', onclick: () => commit(() => { S.sweeps[pk] = 'dismissed'; }, null) }),
        ]));
      } else if (left < 0) {
        out.push(card('', 'Last cycle', `${money(-left)} EGP over the flexible budget`, 'That’s okay. This cycle is a clean slate — the daily share keeps you on track.', [
          h('button', { class: 'btn line', text: 'Got it', onclick: () => commit(() => { S.sweeps[pk] = 'dismissed'; }, null) }),
        ]));
      }
    }
    // bills due
    const due = E.billsForCycle(S, c.key).filter((b) => !b.paid && b.due <= t);
    if (due.length) {
      const total = due.reduce((a, b) => a + b.line.amount, 0);
      const rows = due.map((b) => h('div', { class: 'row' },
        h('button', { class: 'main', style: { textAlign: 'left' }, onclick: () => payBillAmount(c.key, b.line) }, h('div', { class: 'name', text: b.line.name }), h('div', { class: 'meta num', text: `${money(b.line.amount)} EGP · tap if it was different` })),
        h('button', { class: 'btn line', text: 'Paid', onclick: () => payBill(c.key, b.line) })));
      const box = card('', due.length === 1 ? 'Bill due' : 'Bills due', `${plural(due.length, 'bill', 'bills')} · ${money(total)} EGP`, null,
        due.length > 1 ? [h('button', { class: 'btn ink', text: 'Mark all paid', onclick: () => payBills(c.key, due.map((b) => b.line)) })] : null);
      box.insertBefore(h('div', { class: 'list', style: { marginTop: '10px' } }, rows), box.querySelector('.acts'));
      out.push(box);
    }
    // debt / savings move for this cycle
    const mv = E.cycleMoneyMoves(S, c.key);
    if (mv.debtRemaining > 0) {
      const first = E.debtsOrdered(S).find((d) => E.debtBalance(S, d) > 0);
      const partial = mv.paidFromCycle > 0;
      out.push(card('', partial ? 'Toward your debt · the rest' : 'Toward your debt this cycle', `Pay ${money(mv.debtRemaining)} EGP to ${first ? E.lcName(first.name) : 'your debt'}`,
        first && first.note ? first.note : 'Paying debt first saves you interest.',
        [h('button', { class: 'btn ink', text: 'Done', onclick: () => payDebt(mv.debtRemaining, 'cycle') }),
          h('button', { class: 'btn quiet', text: 'Different amount', onclick: () => amountSheet({ title: 'Toward your debt', label: 'How much did you pay?', initial: mv.debtRemaining, confirm: 'Save payment' }, (p) => payDebt(p, 'cycle')) })]));
    } else if (mv.saveRemaining > 0) {
      out.push(card('green', 'This cycle’s saving', `Move ${money(mv.saveRemaining)} EGP to savings`, 'Pay yourself first, before the month gets a vote.',
        [h('button', { class: 'btn green', text: 'Done', onclick: () => addSavings(mv.saveRemaining, 'cycle') }),
          h('button', { class: 'btn quiet', text: 'Different amount', onclick: () => amountSheet({ title: 'Savings', label: 'How much did you move?', initial: mv.saveRemaining, confirm: 'Save' }, (p) => addSavings(p, 'cycle')) })]));
    }
  }

  // evening check-in
  const hasToday = S.entries.some((e) => e.date === t) || S.checkins[t];
  if (hourNow() >= 18 && !hasToday) {
    out.push(card('', 'Evening check-in', 'Anything you spent today?', 'Cash counts too — takeout, coffee, a ride.', [
      h('button', { class: 'btn ink', text: 'Add spending', onclick: () => openAdd() }),
      h('button', { class: 'btn line', text: 'Nothing today', onclick: () => commit(() => { S.checkins[t] = 'none'; }, null, {
        react: () => { if (!E.planStarted(S, t) || E.flexSpentOn(S, t) !== 0 || S.meta.fx.nospend[t]) return null; S.meta.fx.nospend[t] = 1; return { kind: 'nospend', when: 'today' }; },
      }) }),
    ]));
  }

  // backup nudge
  const lb = S.meta.lastBackup;
  if (!ui.laterBackup && S.entries.length >= 10 && (!lb || Date.now() - lb > 14 * 864e5)) {
    out.push(card('', 'Keep it safe', 'Back up your log', 'Everything lives only on this phone. A backup saves a copy to your Files.', [
      h('button', { class: 'btn ink', text: 'Back up now', onclick: exportBackup }),
      h('button', { class: 'btn quiet', text: 'Later', onclick: () => { ui.laterBackup = true; render(); } }),
    ]));
  }
  // Safari, not installed
  if (isIOS() && !isStandalone()) {
    out.push(card('', 'Make it an app', 'Add Margin to your Home Screen', 'It opens full screen, works offline, and Safari won’t tidy away your data.', [h('button', { class: 'btn line', text: 'Show me how', onclick: openInstallHelp })]));
  }
  return out;
}

function envelopesBlock(t) {
  const c = E.cycleInfo(S, t);
  const all = E.buckets(S, c.key, t);
  const pace = (c.dayIndex - 0.5) / c.length;
  const bar = (pct, over, green, showPace) => {
    const b = h('div', { class: 'bar' + (over ? ' r' : green ? ' g' : '') }, h('i'));
    b.firstChild.style.width = `${Math.min(1, Math.max(0, pct)) * 100}%`;
    if (showPace) { const pm = h('span', { class: 'pace' }); pm.style.left = `${pace * 100}%`; b.append(pm); }
    return b;
  };
  const goLog = (id) => () => { ui.tab = 'log'; ui.logFilter = id; render(); window.scrollTo(0, 0); };
  const row = (bk) => {
    const l = bk.line;
    const over = bk.over > 0;
    const isBill = l.kind === 'bill';
    let right, small;
    if (isBill) {
      if (!bk.paid) { right = money(l.amount); small = `due ${E.shortDate(E.billDue(S, l, c.key))}`; }
      else if (over) { right = money(bk.over); small = 'over · from flexible'; }
      else if (bk.left > 0) { right = 'Paid'; small = `${money(bk.left)} under`; }
      else { right = 'Paid'; small = money(bk.spent); }
    } else if (over) { right = money(bk.over); small = l.group === 'fixed' ? 'over · from flexible' : 'over'; }
    else { right = money(bk.left); small = `left of ${money(l.amount)}`; }
    const pct = l.amount > 0 ? bk.spent / l.amount : (bk.spent > 0 ? 1 : 0);
    return h('button', { class: 'env', onclick: isBill ? () => payBillAmount(c.key, l) : goLog(l.id) },
      h('div', { class: 'top' }, h('span', { class: 'name', text: l.name }),
        h('span', { class: 'left num' + (over ? ' over' : isBill && bk.paid ? ' ok' : '') }, right, h('small', { text: small }))),
      bar(pct, over, isBill, !isBill && l.amount > 0));
  };
  const flexible = all.filter((b) => b.line.group === 'lifestyle');
  const essential = all.filter((b) => b.line.group === 'fixed' && b.line.kind === 'envelope');
  const bills = all.filter((b) => b.line.kind === 'bill');
  const known = new Set(all.map((b) => b.line.id));
  const orphan = E.entriesBetween(S, c.start, t).filter((e) => !known.has(e.lineId) && !E.lineById(S, e.lineId)).reduce((a, e) => a + e.amount, 0);
  const sum = (arr, f) => arr.reduce((a, b) => a + f(b), 0);
  const head = (title, arr) => {
    const left = sum(arr, (b) => b.left);
    return h('h2', { class: 'sec' }, title, h('span', { class: 'r num' + (left < 0 ? ' neg' : ' muted'), text: left >= 0 ? `${money(left)} left` : `${money(-left)} over` }));
  };
  const frag = [];
  frag.push(head('Flexible', flexible), h('div', { class: 'list' }, flexible.map(row)));
  if (orphan) frag.push(h('p', { class: 'why', style: { marginTop: '8px' }, text: `${money(orphan)} EGP logged to buckets you’ve since removed counts as flexible spending.` }));
  if (essential.length) frag.push(head('Essentials', essential), h('div', { class: 'list' }, essential.map(row)));
  if (bills.length) frag.push(h('h2', { class: 'sec' }, 'Bills', h('span', { class: 'r muted num', text: `${bills.filter((b) => b.paid).length} of ${bills.length} paid` })), h('div', { class: 'list' }, bills.map(row)));
  // toward debt / savings
  const mv = E.cycleMoneyMoves(S, c.key);
  const moves = [];
  if (mv.debtTarget > 0 || mv.paidFromCycle > 0) moves.push(['Toward your debt', mv.debtTarget, mv.paidFromCycle]);
  if (mv.saveTarget > 0 || mv.savedFromCycle > 0) moves.push(['To savings', mv.saveTarget, mv.savedFromCycle]);
  if (moves.length) {
    frag.push(h('h2', { class: 'sec', text: 'Debt & savings' }), h('div', { class: 'list' }, moves.map(([n, plan, done]) => {
      const left = plan - done;
      return h('button', { class: 'env', onclick: goLog('payments') },
        h('div', { class: 'top' }, h('span', { class: 'name', text: n }),
          h('span', { class: 'left num' + (left <= 0 ? ' ok' : '') }, left > 0 ? money(left) : 'Done', h('small', { text: left > 0 ? `to go of ${money(plan)}` : `${money(done)} this cycle` }))),
        bar(plan ? done / plan : 1, false, true, false));
    })));
  }
  return frag;
}

function planStartsBlock(sf) {
  const k = S.plan.startKey;
  const b = E.budgetFor(S, k);
  const mv = E.cycleMoneyMoves(S, k);
  const bills = E.billsForCycle(S, k);
  const tasks = E.pendingTasks(S).filter((x) => x.due <= E.cycleEnd(S, k));
  const days = E.daysBetween(today(), sf.planStart);
  const rows = [
    ...tasks.map((x) => [x.title + (x.from === 'savings' ? ' (from savings)' : ''), x.amount]),
    [`${plural(bills.length, 'bill', 'bills')}`, bills.reduce((a, x) => a + x.line.amount, 0)],
    ['Toward your debt', mv.debtTarget],
    ['To savings', mv.saveTarget],
    ['Essentials for the month', b.fixedSpend],
    ['Flexible money for the month', b.lifestyle],
  ].filter((r) => r[1] > 0);
  return [
    h('h2', { class: 'sec' }, 'On payday', h('span', { class: 'r muted', text: days === 1 ? 'tomorrow' : `in ${days} days` })),
    h('p', { class: 'why', text: `On ${E.shortDate(sf.planStart)} the plan takes over. Here’s what happens with your ${money(b.income)} EGP.` }),
    h('div', { class: 'list' }, rows.map(([n, v]) => h('div', { class: 'row' }, h('div', { class: 'main' }, h('div', { class: 'name', text: n })), h('div', { class: 'amt num', text: money(v) })))),
  ];
}

function roadTeaser(t) {
  const pr = E.project(S, t);
  const debt = E.totalDebt(S);
  const next = pr.events[0];
  if (!next && debt === 0) return h('div');
  const head = debt > 0 && pr.debtFreeKey && pr.debtFreeKey !== 'now'
    ? `Free of debt by ${E.monthYear(pr.debtFreeKey)}` : debt === 0 ? 'You’re free of debt' : 'Debt will take longer than 5 years at this pace';
  return h('button', { class: 'card', style: { width: '100%', textAlign: 'left', marginTop: '30px' }, onclick: () => { ui.tab = 'road'; render(); window.scrollTo(0, 0); } },
    h('div', { class: 'k', text: 'The road' }),
    h('div', { class: 't', text: head }),
    next ? h('div', { class: 'd', text: `Next: ${next.title} · ${E.monthShort(next.key)}` }) : null);
}

/* ---------------- actions ---------------- */
function payBill(key, line) {
  commit(() => { (S.bills[key] ||= {})[line.id] = { date: today(), amount: line.amount, ts: Date.now() }; }, `${line.name} marked paid.`);
}
function payBillAmount(key, line) {
  const rec = S.bills[key] && S.bills[key][line.id];
  amountSheet({ title: line.name, label: 'How much did you actually pay?', initial: rec ? rec.amount : line.amount, allowZero: true, hint: `Planned: ${money(line.amount)} EGP. If you paid more, the extra comes out of your flexible money.`, confirm: 'Save' }, (p) => {
    commit(() => {
      const m = (S.bills[key] ||= {});
      if (p === 0) { delete m[line.id]; if (!Object.keys(m).length) delete S.bills[key]; }
      else m[line.id] = { date: rec ? rec.date : today(), amount: p, ts: Date.now() };
    }, p === 0 ? `${line.name} marked not paid.` : p > line.amount ? `${line.name}: ${money(p - line.amount)} over plan.` : `${line.name} saved.`);
  });
}
function payBills(key, lines) {
  commit(() => { const m = (S.bills[key] ||= {}); for (const l of lines) m[l.id] = { date: today(), amount: l.amount, ts: Date.now() }; }, `${plural(lines.length, 'bill', 'bills')} marked paid.`);
}
function recordDebtPayment(amount, from, extra = {}) {
  const { parts, leftover } = E.splitAcrossDebts(S, amount, extra.debtId || null);
  const group = E.uid();
  let ts = Date.now();
  for (const p of parts) S.debtPays.push({ id: E.uid(), debtId: p.debtId, amount: p.amount, date: today(), from, taskId: extra.taskId || null, group, ts: ts++ });
  return leftover;
}
function payDebt(amount, from) {
  if (E.totalDebt(S) <= 0) { addSavings(amount, from === 'cycle' ? 'cycle' : 'manual'); return; }
  commit(() => {
    const leftover = recordDebtPayment(amount, from);
    if (leftover > 0) S.savingsLog.push({ id: E.uid(), amount: leftover, date: today(), src: from === 'cycle' ? 'cycle' : 'manual', note: 'Extra after debt', ts: Date.now() });
  }, `${money(amount)} EGP paid toward debt.`, { celebrate: true });
}
function payTask(task) {
  const sv = E.savingsBalance(S);
  const go = () => commit(() => {
    const leftover = task.debtId ? recordDebtPayment(task.amount, task.from, { taskId: task.id, debtId: task.debtId }) : task.amount;
    if (leftover > 0 && task.from === 'savings') S.savingsLog.push({ id: E.uid(), amount: -leftover, date: today(), src: 'manual', note: task.title, ts: Date.now() });
    const tt = S.plan.tasks.find((x) => x.id === task.id); if (tt) tt.done = true;
  }, `${task.title} marked paid.`, { celebrate: true });
  if (task.from === 'savings' && sv < task.amount) {
    confirmSheet('Not enough in savings', `Your savings show ${money(sv)} EGP, less than ${money(task.amount)}. Mark it paid anyway? Savings will go below zero until you update them.`, 'Mark as paid', go);
  } else go();
}
function addSavings(amount, src, note = '') {
  commit(() => { S.savingsLog.push({ id: E.uid(), amount, date: today(), src, note, ts: Date.now() }); }, amount >= 0 ? `${money(amount)} EGP moved to savings.` : `${money(-amount)} EGP taken from savings.`);
}
function sweep(key, amount, toDebt) {
  commit(() => {
    if (toDebt) {
      const leftover = recordDebtPayment(amount, 'extra');
      if (leftover > 0) S.savingsLog.push({ id: E.uid(), amount: leftover, date: today(), src: 'sweep', note: 'Leftover from last cycle', ts: Date.now() });
    } else S.savingsLog.push({ id: E.uid(), amount, date: today(), src: 'sweep', note: 'Leftover from last cycle', ts: Date.now() });
    S.sweeps[key] = 'saved';
  }, toDebt ? `${money(amount)} EGP put toward debt.` : `${money(amount)} EGP moved to savings.`, { celebrate: true });
}

/* ================= PLAYFUL REACTIONS ================= */
const reactQueue = [];
let reactShowing = false;
function reactionContent(r) {
  if (r.kind === 'over') return { art: artWallet(), title: 'E5th.', sub: `Over today’s share. Tomorrow’s share: ${money(r.tomorrow)} EGP.`, ms: 2600 };
  if (r.kind === 'bucket') return { art: artReceipt(), title: 'Yalahweeey', sub: `${r.line.name} is ${money(r.over)} over for this cycle. It comes out of your other flexible money.`, ms: 3000 };
  if (r.kind === 'nospend') return { art: artCoin(), title: r.when === 'yesterday' ? 'Zero spend yesterday.' : 'Zero spend today.', sub: 'Your future self says thokran.', ms: 2800 };
  if (r.kind === 'cycle') return { art: artStamp(), title: 'Bravooo Thara', sub: `Last pay cycle finished under budget${r.left > 0 ? `, with ${money(r.left)} EGP to spare` : ''}.`, ms: 3400 };
  if (r.kind === 'debt') {
    const card = r.debt.id === 'card' || /card/i.test(r.debt.name);
    return { art: card ? artCardSnap() : artConfetti(), title: card ? 'Elhamdullah 2adar w lataf' : 'yaaaay', sub: `${r.debt.name} is fully paid.`, ms: 3600, party: true };
  }
  return null;
}
function showReaction(r) { reactQueue.push(r); if (!reactShowing) nextReaction(); }
function nextReaction() {
  const r = reactQueue.shift();
  if (!r) { reactShowing = false; return; }
  const c = reactionContent(r);
  if (!c) return nextReaction();
  reactShowing = true;
  const root = document.getElementById('toast-root');
  const el = h('div', { class: 'react' + (c.party ? ' party' : ''), role: 'status', 'aria-live': 'assertive' },
    h('div', { class: 'react-card' }, h('div', { class: 'react-art', 'aria-hidden': 'true' }, c.art),
      h('div', { class: 'react-title', text: c.title }), h('div', { class: 'react-sub num', text: c.sub })));
  if (c.party) el.append(confettiLayer());
  let done = false;
  const close = () => { if (done) return; done = true; el.classList.add('out'); setTimeout(() => { el.remove(); nextReaction(); }, 220); };
  el.addEventListener('click', close);
  document.body.append(el);
  setTimeout(close, c.ms);
  void root;
}
const INK = '#1B1A17', GREEN = '#1E5A43', RED = '#A3452B', GOLD = '#B9A27A', PAPER = '#FAF8F3';
function artWallet() {
  return sv('svg', { viewBox: '0 0 120 120', class: 'a-wallet' },
    sv('ellipse', { cx: 60, cy: 104, rx: 34, ry: 4, fill: '#E6E0D2', class: 'shadow' }),
    sv('g', { class: 'body' },
      sv('rect', { x: 22, y: 42, width: 76, height: 54, rx: 9, fill: PAPER, stroke: INK, 'stroke-width': 3 }),
      sv('path', { d: 'M22 58 h76', stroke: INK, 'stroke-width': 3 }),
      sv('rect', { x: 70, y: 62, width: 28, height: 18, rx: 5, fill: PAPER, stroke: INK, 'stroke-width': 3 }),
      sv('circle', { cx: 80, cy: 71, r: 2.5, fill: INK }),
      sv('path', { d: 'M40 74 q4 -4 8 0 M52 74 q4 -4 8 0', stroke: INK, 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round', class: 'eyes' }),
      sv('path', { d: 'M45 86 q6 -4 12 0', stroke: INK, 'stroke-width': 2.5, fill: 'none', 'stroke-linecap': 'round' }),
      sv('path', { d: 'M104 40 q6 2 4 10', stroke: '#7C766A', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', class: 'sweat' })));
}
function artReceipt() {
  const lines = [];
  for (let i = 0; i < 9; i++) lines.push(sv('path', { d: `M42 ${38 + i * 9} h${i % 3 === 2 ? 22 : 36}`, stroke: '#A9A293', 'stroke-width': 2.5, 'stroke-linecap': 'round' }));
  return sv('svg', { viewBox: '0 0 120 130', class: 'a-receipt' },
    sv('rect', { x: 24, y: 18, width: 72, height: 14, rx: 4, fill: INK }),
    sv('g', { class: 'paper' },
      sv('path', { d: 'M34 30 h52 v92 l-6.5 -5 l-6.5 5 l-6.5 -5 l-6.5 5 l-6.5 -5 l-6.5 5 l-6.5 -5 l-6.5 5 z', fill: PAPER, stroke: INK, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }),
      ...lines,
      sv('path', { d: 'M42 116 h36', stroke: RED, 'stroke-width': 3, 'stroke-linecap': 'round' })));
}
function artCoin() {
  return sv('svg', { viewBox: '0 0 120 120', class: 'a-coin' },
    sv('ellipse', { cx: 60, cy: 106, rx: 24, ry: 3.5, fill: '#E6E0D2' }),
    sv('g', { class: 'spin' },
      sv('circle', { cx: 60, cy: 58, r: 36, fill: '#E9DFC6', stroke: INK, 'stroke-width': 3 }),
      sv('circle', { cx: 60, cy: 58, r: 28, fill: 'none', stroke: GOLD, 'stroke-width': 2, 'stroke-dasharray': '3 4' }),
      sv('text', { x: 60, y: 72, 'text-anchor': 'middle', 'font-family': 'M Serif, Georgia, serif', 'font-size': 40, 'font-weight': 500, fill: INK }, document.createTextNode('0'))));
}
function artStamp() {
  const t = sv('text', { x: 60, y: 66, 'text-anchor': 'middle', 'font-family': 'M Sans, Arial, sans-serif', 'font-size': 10.5, 'font-weight': 600, 'letter-spacing': 1, fill: GREEN });
  t.textContent = 'UNDER BUDGET';
  return sv('svg', { viewBox: '0 0 120 120', class: 'a-stamp' },
    sv('g', { class: 'ink' },
      sv('circle', { cx: 60, cy: 60, r: 44, fill: 'none', stroke: GREEN, 'stroke-width': 4 }),
      sv('circle', { cx: 60, cy: 60, r: 37, fill: 'none', stroke: GREEN, 'stroke-width': 1.5 }),
      sv('path', { d: 'M30 52 h60 M30 74 h60', stroke: GREEN, 'stroke-width': 1.5 }), t));
}
function artCardSnap() {
  const half = (cls, x) => sv('g', { class: cls },
    sv('rect', { x, y: 34, width: 40, height: 52, rx: 6, fill: '#2D2B26' }),
    cls === 'l' ? sv('rect', { x: x + 10, y: 46, width: 14, height: 10, rx: 2, fill: GOLD }) : sv('path', { d: `M${x + 8} 74 h22`, stroke: '#7C766A', 'stroke-width': 3, 'stroke-linecap': 'round' }));
  return sv('svg', { viewBox: '0 0 120 120', class: 'a-card' },
    half('l', 20), half('r', 60),
    sv('path', { d: 'M60 26 l-4 10 l7 8 l-6 9 l7 9 l-6 9 l7 9 l-5 10', stroke: RED, 'stroke-width': 2.5, fill: 'none', class: 'crack' }));
}
function artConfetti() {
  return sv('svg', { viewBox: '0 0 120 120', class: 'a-pop' },
    sv('path', { d: 'M38 98 L60 40 L82 98 Z', fill: GOLD, stroke: INK, 'stroke-width': 3, 'stroke-linejoin': 'round' }),
    sv('path', { d: 'M46 78 h28 M52 62 h16', stroke: INK, 'stroke-width': 2.5 }),
    sv('path', { d: 'M60 30 v-12 M44 34 l-8 -9 M76 34 l8 -9', stroke: GREEN, 'stroke-width': 3, 'stroke-linecap': 'round', class: 'burst' }));
}
function confettiLayer() {
  const layer = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  const cols = [GREEN, GOLD, INK, RED, '#2F7458'];
  for (let i = 0; i < 34; i++) {
    const p = h('i');
    Object.assign(p.style, { left: `${(i * 37) % 100}%`, background: cols[i % cols.length], animationDelay: `${(i % 9) * 0.07}s`, animationDuration: `${1.9 + (i % 5) * 0.25}s`, width: `${5 + (i % 3) * 2}px`, height: `${9 + (i % 4) * 2}px`, transform: `rotate(${(i * 47) % 180}deg)` });
    layer.append(p);
  }
  return layer;
}
// Run when the app opens or the day changes: no-spend yesterday, cycle under budget.
function checkOpenReactions() {
  if (!S || !S.plan || bootError || ui.setupStep) return;
  const t = today();
  const fx = S.meta.fx;
  const list = S.meta.reactions ? E.openReactions(S, t) : [];
  for (const r of list) { if (r.kind === 'cycle') fx.cycles[r.key] = 1; if (r.kind === 'nospend') fx.nospend[r.date] = 1; }
  if (fx.lastSeen !== t || list.length) { fx.lastSeen = t; save(); }
  list.forEach(showReaction);
}

/* ================= ADD / EDIT SPENDING ================= */
function rawFromP(p) { const a = Math.abs(p); const w = Math.floor(a / 100), f = a % 100; return f ? `${w}.${String(f).padStart(2, '0').replace(/0$/, '')}` : String(w); }
function displayRaw(raw) {
  if (!raw) return '0';
  const [w, d] = raw.split('.');
  const ws = Number(w || '0').toLocaleString('en-US');
  return d !== undefined ? `${ws}.${d}` : ws;
}

function openAdd(existing = null, preset = {}) {
  const t = today();
  const st = {
    raw: existing ? rawFromP(existing.amount) : '',
    lineId: existing ? existing.lineId : preset.lineId || null,
    manual: !!existing || !!preset.lineId,
    note: existing ? existing.note : '',
    date: existing ? existing.date : t,
    refund: existing ? existing.amount < 0 : false,
    src: existing ? existing.src : 'quick',
    mode: 'pad', confirmBig: false, confirmDelete: false, busy: false, smsText: '', smsErr: '', smsNote: '',
  };
  openSheet(existing ? 'Edit spending' : 'Add spending', (body, api) => {
    if (st.mode === 'sms') return buildSms(body, api);
    const key = E.planStarted(S, st.date) ? E.cycleKeyFor(S, st.date) : S.plan.startKey;
    const startedAt = E.planStarted(S, st.date);
    const env = E.activeLines(S, key).filter((l) => l.kind === 'envelope' && (l.amount > 0 || l.id === 'other'));
    const rank = (l) => (l.id === 'other' ? 2 : l.group === 'lifestyle' ? 0 : 1);
    env.sort((a, b) => rank(a) - rank(b));
    const billLines = E.activeLines(S, key).filter((l) => l.kind === 'bill');
    const debtChip = !existing && startedAt && E.totalDebt(S) > 0 ? { id: '__debt', name: 'Toward your debt', amount: 0, kind: 'debt' } : null;
    const all = [...env];
    if (st.lineId && !env.some((l) => l.id === st.lineId) && !billLines.some((l) => l.id === st.lineId)) { const l = E.lineById(S, st.lineId); if (l) all.push(l); }
    const firstMore = all.length;
    all.push(...billLines);
    if (debtChip) all.push(debtChip);
    const cs = startedAt ? E.cycleInfo(S, st.date) : null;
    const spent = cs ? E.spentByLine(S, cs.start, cs.end) : {};
    const mvNow = cs ? E.cycleMoneyMoves(S, cs.key) : null;
    const amt = h('div', { class: 'v num' + (st.raw ? '' : ' placeholder') + (st.refund ? ' refund' : ''), text: (st.refund && st.raw ? '+' : '') + displayRaw(st.raw) });
    const warn = h('div', { class: 'warnline' });
    const save = h('button', { class: 'btn ink wide', text: existing ? 'Save changes' : 'Save' });
    const refreshState = () => {
      amt.textContent = (st.refund && st.raw ? '+' : '') + displayRaw(st.raw);
      amt.className = 'v num' + (st.raw ? '' : ' placeholder') + (st.refund ? ' refund' : '');
      const p = E.parseAmount(st.raw || '0');
      save.disabled = !(p > 0 && st.lineId);
      if (!st.confirmBig) warn.textContent = '';
    };
    const chipFor = (l) => {
      let sm = null;
      if (l.kind === 'debt') sm = mvNow && mvNow.debtRemaining > 0 ? money(mvNow.debtRemaining) : null;
      else if (l.kind === 'bill') sm = cs ? (E.lineSpent(S, l, cs.key) > 0 ? 'paid' : money(l.amount)) : null;
      else if (cs && l.amount > 0) { const left = l.amount - (spent[l.id] || 0); sm = left >= 0 ? money(left) : `−${money(-left)}`; }
      return h('button', { class: 'bucket' + (st.lineId === l.id ? ' on' : ''), role: 'radio', 'aria-checked': st.lineId === l.id ? 'true' : 'false', onclick: () => { st.lineId = l.id; st.manual = true; st.confirmBig = false; if (l.kind === 'debt') st.refund = false; api.refresh(); } },
        l.name, sm ? h('span', { class: 'sm num', text: sm }) : null);
    };
    const chips = h('div', { role: 'radiogroup', 'aria-label': 'Bucket' },
      h('div', { class: 'buckets' }, all.slice(0, firstMore).map(chipFor)),
      all.length > firstMore ? h('div', { class: 'chip-label', text: 'Bills & debt' }) : null,
      all.length > firstMore ? h('div', { class: 'buckets more' }, all.slice(firstMore).map(chipFor)) : null);
    const note = h('input', { class: 'note-input', type: 'text', placeholder: 'Where? (optional)', value: st.note, maxlength: '60', autocomplete: 'off', autocapitalize: 'words', enterkeyhint: 'done', 'aria-label': 'Note' });
    note.addEventListener('input', () => {
      st.note = note.value;
      if (!st.manual) { const g = E.guessLine(S, st.note); if (g && g !== st.lineId) { st.lineId = g; chips.querySelectorAll('.bucket').forEach((b, i) => { const on = all[i].id === g; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }); refreshState(); } }
    });
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') note.blur(); });

    // date pill with native picker underneath
    const dateLabel = st.date === t ? 'Today' : st.date === E.addDays(t, -1) ? 'Yesterday' : E.shortDate(st.date);
    const dateInput = h('input', { type: 'date', value: st.date, max: t, min: E.addDays(t, -400), 'aria-label': 'Date' });
    Object.assign(dateInput.style, { position: 'absolute', inset: '0', opacity: '0', width: '100%', height: '100%' });
    dateInput.addEventListener('change', () => { if (E.isValidISO(dateInput.value) && dateInput.value <= t) { st.date = dateInput.value; api.refresh(); } });
    const datePill = h('label', { class: 'pill', style: { position: 'relative' } }, dateLabel, dateInput);
    const refundPill = st.lineId === '__debt' ? null : h('button', { class: 'pill' + (st.refund ? ' on' : ''), 'aria-pressed': st.refund ? 'true' : 'false', text: 'Money back', onclick: () => { st.refund = !st.refund; api.refresh(); } });
    const smsPill = h('button', { class: 'pill', text: 'Paste bank SMS', onclick: () => { st.mode = 'sms'; api.refresh(); } });

    const press = (k) => {
      let r = st.raw;
      if (k === 'del') r = r.slice(0, -1);
      else if (k === '.') { if (r.includes('.')) return; r = (r || '0') + '.'; }
      else {
        if (r.includes('.')) { if (r.split('.')[1].length >= 2) return; r += k; }
        else { if (r === '0') r = k; else { if (r.replace('.', '').length >= 8) return; r += k; } }
      }
      st.raw = r; st.confirmBig = false; refreshState();
    };
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'].map((k) =>
      h('button', { class: 'key num', 'aria-label': k === 'del' ? 'Delete digit' : k === '.' ? 'Decimal point' : k, onclick: () => press(k) }, k === 'del' ? icon.back() : k));

    save.addEventListener('click', () => {
      if (st.busy) return;
      const p = E.parseAmount(st.raw);
      if (!(p > 0) || !st.lineId) return;
      if (st.lineId === '__debt') { st.busy = true; api.close(); payDebt(p, 'cycle'); return; }
      const line = E.lineById(S, st.lineId);
      const big = p > E.toP(20000) || (line && line.amount > 0 && p > line.amount * 2 && p > E.toP(1000));
      if (big && !st.confirmBig && !st.refund) { st.confirmBig = true; warn.textContent = `${money(p)} EGP is a big one. Tap Save again if that’s right.`; return; }
      st.busy = true;
      const entry = { id: existing ? existing.id : E.uid(), date: st.date, amount: st.refund ? -p : p, lineId: st.lineId, note: st.note.trim().slice(0, 60), src: st.src, ts: existing ? existing.ts : Date.now() };
      api.close();
      commit(() => {
        if (existing) { const i = S.entries.findIndex((e) => e.id === existing.id); if (i >= 0) S.entries[i] = entry; else S.entries.push(entry); }
        else S.entries.push(entry);
        const mk = E.merchantKey(entry.note);
        if (mk) S.merchants[mk] = entry.lineId;
      }, existing ? 'Changes saved.' : `${money(p)} EGP ${st.refund ? 'back to' : 'to'} ${line ? E.lcName(line.name) : 'other'}.`, {
        react: existing ? null : (prev) => {
          const r = E.spendReaction(prev, S, entry, today());
          if (!r) return null;
          if (r.kind === 'bucket') S.meta.fx.buckets[r.key] = 1;
          S.meta.fx.overDay = today(); // one reaction per day for overspending
          return r;
        },
      });
    });

    put(body, 
      h('div', { class: 'amount-display' }, amt, h('div', { class: 'c', text: st.refund ? 'EGP BACK' : 'EGP' })),
      st.smsNote ? h('p', { class: 'why', style: { textAlign: 'center', margin: '6px 0 0' }, text: st.smsNote }) : null,
      chips,
      note,
      h('div', { class: 'metarow' }, datePill, refundPill, existing ? null : smsPill),
      h('div', { class: 'keypad' }, keys),
      warn,
      h('div', { class: 'save-wrap' }, save),
      existing ? h('button', { class: 'btn danger wide', style: { marginTop: '6px' }, text: st.confirmDelete ? 'Tap again to delete' : 'Delete', onclick: () => {
        if (!st.confirmDelete) { st.confirmDelete = true; api.refresh(); return; }
        api.close();
        commit(() => { S.entries = S.entries.filter((e) => e.id !== existing.id); }, 'Deleted.');
      } }) : null,
    );
    refreshState();
  });

  function buildSms(body, api) {
    api.setTitle('Paste bank SMS');
    const ta = h('textarea', { placeholder: 'Long-press the bank message, Copy, then paste it here.', 'aria-label': 'Bank message' });
    ta.value = st.smsText;
    ta.addEventListener('input', () => { st.smsText = ta.value; });
    const err = h('div', { class: 'errmsg', text: st.smsErr });
    const read = () => {
      const r = E.parseSMS(st.smsText);
      if (!r) { st.smsErr = 'Couldn’t find an amount in that message. Type it in instead.'; api.refresh(); return; }
      st.raw = rawFromP(r.amount); st.refund = r.isCredit; st.note = r.merchant || st.note; st.src = 'sms';
      const g = E.guessLine(S, r.merchant);
      if (g && !st.manual) st.lineId = g;
      st.smsNote = `Read from the message${r.merchant ? ` — ${r.merchant}` : ''}. Check it, pick a bucket, save.`;
      st.smsErr = ''; st.mode = 'pad'; api.setTitle('Add spending'); api.refresh();
    };
    const canRead = navigator.clipboard && typeof navigator.clipboard.readText === 'function';
    put(body, 
      h('p', { class: 'why', style: { marginTop: '6px' }, text: 'Margin reads the amount and the shop. Nothing leaves your phone.' }),
      h('div', { class: 'field' }, ta), err,
      h('div', { class: 'acts', style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        canRead ? h('button', { class: 'btn line', text: 'Paste', onclick: async () => { try { const x = await navigator.clipboard.readText(); if (x) { st.smsText = x; ta.value = x; read(); } } catch { ta.focus(); } } }) : null,
        h('button', { class: 'btn ink', style: { flex: '1' }, text: 'Read message', onclick: read })),
      h('button', { class: 'btn quiet wide', style: { marginTop: '8px' }, text: 'Back to keypad', onclick: () => { st.mode = 'pad'; api.setTitle(existing ? 'Edit spending' : 'Add spending'); api.refresh(); } }),
    );
    setTimeout(() => ta.focus(), 250);
  }
}

/* ---------------- small reusable sheets ---------------- */
function amountSheet({ title, label, initial, hint, confirm = 'Save', allowZero = false, allowNegative = false }, onDone) {
  openSheet(title, (body, api) => {
    const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: initial != null ? rawFromP(initial) : '' });
    if (initial != null && initial < 0) input.value = '-' + input.value;
    const err = h('div', { class: 'errmsg' });
    const go = () => {
      let v = input.value.trim(); let neg = false;
      if (allowNegative && /^[-−]/.test(v)) { neg = true; v = v.slice(1); }
      const p = E.parseAmount(v);
      if (p == null || (!allowZero && p === 0)) { err.textContent = 'Type an amount, like 1500.'; return; }
      api.close(); onDone(neg ? -p : p);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    put(body, h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null), err,
      h('button', { class: 'btn ink wide', style: { marginTop: '14px' }, text: confirm, onclick: go }));
    setTimeout(() => input.focus(), 260);
  });
}
function confirmSheet(title, text, yes, onYes, { danger = false } = {}) {
  openSheet(title, (body, api) => {
    put(body, h('p', { class: 'lede', text }),
      h('button', { class: 'btn wide ' + (danger ? 'danger line' : 'ink'), style: { marginTop: '20px' }, text: yes, onclick: () => { api.close(); onYes(); } }),
      h('button', { class: 'btn quiet wide', style: { marginTop: '6px' }, text: 'Cancel', onclick: () => api.close() }));
  });
}

/* ================= PLAN ================= */
function planScreen() {
  const t = today();
  const started = E.planStarted(S, t);
  const key = started ? E.cycleKeyFor(S, t) : S.plan.startKey;
  const b = E.budgetFor(S, key);
  const mv = E.cycleMoneyMoves(S, key);
  const scr = h('main', { class: 'screen' });
  put(scr, topline(started ? `${E.shortDate(E.cycleStart(S, key))} – ${E.shortDate(E.cycleEnd(S, key))}` : `Starts ${E.shortDate(E.cycleStart(S, key))}`));
  put(scr, h('h1', { class: 'title', text: 'The plan' }),
    h('p', { class: 'lede num', text: `${money(b.income)} EGP comes in on the ${ordinal(S.plan.payday)}. Every pound has a job.` }));

  if (b.free < 0) put(scr, card('red', 'Needs a fix', `This plan spends ${money(-b.free)} EGP more than comes in`, 'Trim a flexible bucket in Edit plan so the month closes.', [h('button', { class: 'btn ink', text: 'Edit plan', onclick: openEditor })]));

  const segs = [['Fixed bills & essentials', b.fixed, 'c-fixed'], ['Flexible', b.lifestyle, 'c-life'], ['Toward your debt', mv.debtTarget, 'c-debt'], ['To savings', mv.saveTarget, 'c-save']];
  const total = Math.max(b.income, segs.reduce((a, s) => a + s[1], 0));
  const split = h('div', { class: 'split', role: 'img', 'aria-label': segs.map((s) => `${s[0]} ${money(s[1])}`).join(', ') });
  for (const [, v, c] of segs) if (v > 0) { const i = h('i', { class: c }); i.style.flex = String(v / total); split.append(i); }
  const COLORS = { 'c-fixed': '#2D2B26', 'c-life': '#B9A27A', 'c-debt': '#A3452B', 'c-save': '#1E5A43' };
  put(scr, split, h('div', { class: 'legend' }, segs.map(([l, v, c]) => h('div', { style: { borderColor: COLORS[c] } }, h('div', { class: 'v num', text: money(v) }), h('div', { class: 'l', text: l })))));

  const lines = E.activeLines(S, key);
  const paid = S.bills[key] || {};
  const lineRow = (l, withStatus) => {
    const metaBits = [];
    if (l.note) metaBits.push(l.note);
    if (l.until) metaBits.push(`last payment ${E.monthShort(l.until)}`);
    let tag = null;
    if (withStatus && started) {
      const rec = paid[l.id];
      const sp = E.lineSpent(S, l, key);
      tag = sp > l.amount ? h('span', { class: 'tag due', text: `Paid · ${money(sp - l.amount)} over` })
        : sp > 0 ? h('span', { class: 'tag ok', text: rec ? `Paid ${E.shortDate(rec.date)}` : 'Paid' })
        : h('span', { class: 'tag due', text: `Due ${E.shortDate(E.billDue(S, l, key))}` });
    }
    return h('div', { class: 'row' }, h('div', { class: 'main' }, h('div', { class: 'name', text: l.name }), metaBits.length ? h('div', { class: 'meta wrap', text: metaBits.join(' · ') }) : null),
      h('div', { style: { textAlign: 'right' } }, h('div', { class: 'amt num', text: money(l.amount) }), tag));
  };
  const sec = (title, why, rows, right) => [h('h2', { class: 'sec' }, title, right ? h('span', { class: 'r num', text: right }) : null), why ? h('p', { class: 'why', text: why }) : null, h('div', { class: 'list' }, rows)];

  const bills = lines.filter((l) => l.kind === 'bill');
  const ess = lines.filter((l) => l.group === 'fixed' && l.kind === 'envelope');
  const flex = lines.filter((l) => l.group === 'lifestyle' && l.amount > 0);
  if (bills.length) put(scr, ...sec('Fixed bills', 'Paid once each cycle. Tap Paid on Today when they go out.', bills.map((l) => lineRow(l, true)), money(b.fixedBills)));
  if (ess.length) put(scr, ...sec('Essentials', 'Spent through the month. These don’t eat into your flexible money.', ess.map((l) => lineRow(l)), money(b.fixedSpend)));
  if (flex.length) put(scr, ...sec('Flexible', 'Where the plan bends. Your daily safe-to-spend comes from here.', flex.map((l) => lineRow(l)), money(b.lifestyle)));

  // debts
  if (S.plan.debts.length) {
    const rows = E.debtsOrdered(S).map((d) => {
      const bal = E.debtBalance(S, d);
      const paidSince = d.balance - bal;
      const bar = h('div', { class: 'bar g' }, h('i')); bar.firstChild.style.width = `${d.balance ? (paidSince / d.balance) * 100 : 100}%`;
      return h('button', { class: 'row', style: { display: 'block' }, onclick: () => updateDebtBalance(d) },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '10px' } },
          h('div', { class: 'main' }, h('div', { class: 'name', text: d.name }), h('div', { class: 'meta', text: bal === 0 ? 'Cleared' : (d.note || `${money(paidSince)} paid so far`) })),
          h('div', { class: 'amt num' + (bal === 0 ? ' pos' : ''), text: bal === 0 ? '0' : money(bal) })),
        bar);
    });
    put(scr, ...sec('Debt', mv.debtTarget > 0 ? `${money(mv.debtTarget)} EGP goes to debt this cycle, highest-cost first. Tap a debt to match it to your latest statement.` : 'Tap a debt to match it to your latest statement.', rows, money(E.totalDebt(S))));
  }
  // savings
  const svb = E.savingsBalance(S);
  put(scr, ...sec('Savings', mv.saveTarget > 0 ? `${money(mv.saveTarget)} EGP goes to savings this cycle.` : 'Grows once the debt is cleared.', [
    h('button', { class: 'row', onclick: openSavingsSheet }, h('div', { class: 'main' }, h('div', { class: 'name', text: 'Savings balance' }), h('div', { class: 'meta', text: 'Tap to add or take money out' })), h('div', { class: 'amt num' + (svb < 0 ? ' neg' : ''), text: money(svb) })),
  ]));
  const tasks = E.pendingTasks(S);
  if (tasks.length) put(scr, ...sec('Scheduled', null, tasks.map((x) => h('div', { class: 'row' }, h('div', { class: 'main' }, h('div', { class: 'name', text: x.title }), h('div', { class: 'meta', text: `${E.shortDate(x.due)} · ${x.from === 'savings' ? 'from savings' : 'from the cycle'}` })), h('div', { class: 'amt num', text: money(x.amount) })))));

  put(scr, h('button', { class: 'btn line wide', style: { marginTop: '30px' }, text: 'Edit plan', onclick: openEditor }));
  return scr;
}

function updateDebtBalance(d) {
  amountSheet({ title: d.name, label: 'Balance on your latest statement', initial: E.debtBalance(S, d), allowZero: true, hint: 'Use this when interest or fees change the number. Payments you log from now on come off this.', confirm: 'Update balance' }, (p) => {
    commit(() => { const x = S.plan.debts.find((y) => y.id === d.id); x.balance = p; x.asOf = Date.now(); }, `${d.name} updated.`);
  });
}
function openSavingsSheet() {
  openSheet('Savings', (body, api) => {
    const bal = E.savingsBalance(S);
    put(body, h('p', { class: 'lede num', text: `Balance: ${money(bal)} EGP` }),
      h('button', { class: 'btn ink wide', style: { marginTop: '18px' }, text: 'Add to savings', onclick: () => { api.close(); amountSheet({ title: 'Add to savings', label: 'Amount', confirm: 'Add' }, (p) => addSavings(p, 'manual')); } }),
      h('button', { class: 'btn line wide', style: { marginTop: '10px' }, text: 'Take money out', onclick: () => { api.close(); amountSheet({ title: 'Take from savings', label: 'Amount', confirm: 'Take out' }, (p) => addSavings(-p, 'manual')); } }),
      h('button', { class: 'btn quiet wide', style: { marginTop: '10px' }, text: 'Correct the balance', onclick: () => { api.close(); amountSheet({ title: 'Savings balance', label: 'What’s actually in savings now?', initial: bal, allowZero: true, confirm: 'Update' }, (p) => commit(() => { S.plan.savings.balance = p; S.plan.savings.asOf = Date.now(); }, 'Savings updated.')); } }));
  });
}

/* ================= ROAD ================= */
function roadScreen() {
  const t = today();
  const pr = E.project(S, t);
  const scr = h('main', { class: 'screen' });
  put(scr, topline('The road'));
  const debt = E.totalDebt(S);
  const longest = S.plan.lines.filter((l) => l.until && l.until >= (E.planStarted(S, t) ? E.cycleKeyFor(S, t) : S.plan.startKey)).sort((a, b) => (a.until < b.until ? 1 : -1))[0];
  const hero = h('section', { class: 'hero' });
  if (debt === 0) put(hero, h('div', { class: 'label', text: 'Debt' }), h('div', { class: 'big', style: { fontSize: '52px' }, text: 'All clear.' }));
  else if (pr.debtFreeKey && pr.debtFreeKey !== 'now') put(hero, h('div', { class: 'label', text: 'Free of debt by' }), h('div', { class: 'big', style: { fontSize: '56px' }, text: E.monthYear(pr.debtFreeKey) }));
  else put(hero, h('div', { class: 'label', text: 'Debt' }), h('div', { class: 'big', style: { fontSize: '40px' }, text: 'More than 5 years away' }), h('div', { class: 'sub', text: 'Your plan has no room for debt payments. Look at Edit plan.' }));
  if (longest) put(hero, h('div', { class: 'sub', text: `${longest.name}: last payment ${E.monthYear(longest.until)}.` }));
  put(scr, hero);

  // chart: debt falling, savings rising
  const horizon = Math.min(pr.series.length, Math.max(15, (pr.debtFreeKey && pr.debtFreeKey !== 'now' ? E.keyDiff(pr.startKey, pr.debtFreeKey) : 0) + 10));
  const ser = pr.series.slice(0, horizon);
  if (ser.length > 1) put(scr, chart(ser, debt));

  // timeline
  const items = [];
  const nowKey = E.planStarted(S, t) ? E.cycleKeyFor(S, t) : null;
  for (const task of S.plan.tasks.filter((x) => x.done)) items.push({ state: 'done', when: E.shortDate(task.due), what: `${task.title} paid`, det: `${money(task.amount)} EGP` });
  for (const d of S.plan.debts) if (d.balance > 0 && E.debtBalance(S, d) === 0) {
    const last = S.debtPays.filter((p) => p.debtId === d.id).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    items.push({ state: 'done', when: last ? E.shortDate(last.date) : '', what: `${d.name} cleared`, det: null });
  }
  if (nowKey) for (const l of S.plan.lines) if (l.until && l.until < nowKey && l.until >= S.plan.startKey) items.push({ state: 'done', when: E.monthShort(l.until), what: `Last ${E.lcName(l.name)} payment`, det: `Frees ${money(l.amount)} EGP a month` });
  items.push({ state: 'now', when: 'Today', what: debt > 0 ? `${money(debt)} EGP of debt left` : `${money(E.savingsBalance(S))} EGP saved`, det: debt > 0 ? `${money(E.savingsBalance(S))} EGP in savings` : null });
  const future = [];
  for (const task of E.pendingTasks(S)) future.push({ sort: task.due, when: E.shortDate(task.due), what: task.title, det: `${money(task.amount)} EGP ${task.from === 'savings' ? 'from savings' : ''}`.trim() });
  for (const ev of pr.events) {
    const det = ev.type === 'debt' ? nextDebtLine(ev.debtId) : `Frees ${money(ev.frees)} EGP a month`;
    future.push({ sort: E.cycleStart(S, ev.key), when: E.monthShort(ev.key), what: ev.title, det });
  }
  // savings milestones
  const sv0 = E.savingsBalance(S);
  const essentials = E.budgetFor(S, nowKey || S.plan.startKey).fixed;
  const goals = [];
  if (S.plan.savings.balance > 0 && sv0 < S.plan.savings.balance) goals.push([S.plan.savings.balance, 'Savings back where they started']);
  goals.push([essentials * 3, '3 months of essentials saved']);
  goals.push([essentials * 6, '6 months of essentials saved']);
  for (const [target, title] of goals) {
    if (sv0 >= target) continue;
    const hit = pr.series.find((x) => x.savings >= target);
    if (hit) future.push({ sort: E.cycleStart(S, hit.key) + 'z', when: E.monthShort(hit.key), what: title, det: `${money(target)} EGP` });
  }
  future.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  future.forEach((f, i) => items.push({ ...f, state: i === 0 ? 'next' : '' }));

  put(scr, h('h2', { class: 'sec', text: 'Milestones' }), h('div', { class: 'tl' }, items.map((it) =>
    h('div', { class: 'item ' + it.state }, h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('div', { class: 'when', text: it.when }), h('div', { class: 'what num', text: it.what }), it.det ? h('div', { class: 'det num', text: it.det }) : null))));
  const end = pr.series.find((x) => x.key === `${Number(t.slice(0, 4)) + 1}-12`);
  if (end) put(scr, h('p', { class: 'why', style: { marginTop: '6px' }, text: `If every cycle follows the plan, you’d have about ${money(Math.round(end.savings / 100000) * 100000)} EGP saved by ${E.monthYear(end.key)}.` }));
  put(scr, h('p', { class: 'why', style: { marginTop: '14px' }, text: 'Dates assume each pay cycle follows the plan. They move with the payments you actually log.' }));
  return scr;
}
function nextDebtLine(id) {
  const order = E.debtsOrdered(S);
  const i = order.findIndex((d) => d.id === id);
  const nxt = order.slice(i + 1).find((d) => E.debtBalance(S, d) > 0);
  return nxt ? `Then everything goes to ${E.lcName(nxt.name)}` : 'Then the money goes to savings';
}
function chart(ser, debtNow) {
  const W = 340, H = 150, pl = 4, pr = 4, pt = 12, pb = 22;
  const max = Math.max(1, ...ser.map((x) => Math.max(x.savings, x.debt)));
  const X = (i) => pl + (i / (ser.length - 1)) * (W - pl - pr);
  const Y = (v) => pt + (1 - Math.max(0, v) / max) * (H - pt - pb);
  const path = (f) => ser.map((x, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(f(x)).toFixed(1)}`).join('');
  const svg = sv('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Projected debt going down and savings going up' });
  svg.append(sv('line', { x1: pl, x2: W - pr, y1: H - pb, y2: H - pb, stroke: '#DAD3C3', 'stroke-width': '1' }));
  svg.append(sv('path', { d: `${path((x) => x.savings)}L${X(ser.length - 1)},${H - pb}L${X(0)},${H - pb}Z`, fill: '#1E5A43', opacity: '.08' }));
  if (debtNow > 0) svg.append(sv('path', { d: path((x) => x.debt), fill: 'none', stroke: '#A3452B', 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke' }));
  svg.append(sv('path', { d: path((x) => x.savings), fill: 'none', stroke: '#1E5A43', 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke' }));
  const lab = (i, anchor) => { const tx = sv('text', { x: X(i), y: H - 6, 'text-anchor': anchor, class: 'ax' }); tx.textContent = E.monthShort(ser[i].key); return tx; };
  svg.append(lab(0, 'start'), lab(Math.floor((ser.length - 1) / 2), 'middle'), lab(ser.length - 1, 'end'));
  const key = h('div', { class: 'ruler-cap', style: { justifyContent: 'flex-start', gap: '16px', marginTop: '4px' } },
    debtNow > 0 ? h('span', { style: { color: '#A3452B' }, text: '— Debt' }) : null, h('span', { style: { color: '#1E5A43' }, text: '— Savings' }));
  return h('div', { style: { marginTop: '18px' } }, svg, key);
}

/* ================= LOG ================= */
function logItems() {
  const items = [];
  for (const e of S.entries) {
    const l = E.lineById(S, e.lineId);
    items.push({ kind: 'spend', id: e.id, date: e.date, ts: e.ts, amount: e.amount, title: e.note || (l ? l.name : 'Other'), sub: (l ? l.name : 'Other') + (e.src === 'sms' ? ' · from SMS' : ''), lineId: e.lineId, ref: e });
  }
  for (const [key, m] of Object.entries(S.bills)) for (const [lid, rec] of Object.entries(m)) {
    const l = E.lineById(S, lid);
    items.push({ kind: 'bill', id: `${key}:${lid}`, date: rec.date, ts: rec.ts, amount: rec.amount, title: l ? l.name : 'Bill', sub: 'Bill paid', key, lineId: lid });
  }
  const groups = {};
  for (const p of S.debtPays) { const g = p.group || p.id; (groups[g] ||= []).push(p); }
  for (const [g, ps] of Object.entries(groups)) {
    const names = ps.map((p) => (S.plan.debts.find((d) => d.id === p.debtId) || {}).name || 'debt').join(' & ');
    const from = ps[0].from === 'savings' ? 'from savings' : ps[0].from === 'extra' ? 'leftover money' : 'this cycle';
    items.push({ kind: 'debt', id: g, date: ps[0].date, ts: ps[0].ts, amount: ps.reduce((a, p) => a + p.amount, 0), title: `Paid ${E.lcName(names)}`, sub: `Toward your debt · ${from}`, group: g });
  }
  for (const s of S.savingsLog) items.push({ kind: 'save', id: s.id, date: s.date, ts: s.ts, amount: s.amount, title: s.amount >= 0 ? 'Into savings' : 'Out of savings', sub: s.note || 'Savings' });
  return items.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.ts - a.ts));
}
function logScreen() {
  const scr = h('main', { class: 'screen' });
  put(scr, topline('Log'), h('h1', { class: 'title', text: 'Everything, in order' }), S.entries.length || S.debtPays.length ? h('p', { class: 'why', style: { marginTop: '8px' }, text: 'Tap to edit. Swipe left to delete.' }) : null);
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search', value: ui.logQuery, 'aria-label': 'Search the log', autocomplete: 'off' });
  let tmr;
  search.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => { ui.logQuery = search.value; const list = scr.querySelector('#loglist'); list.replaceWith(buildList()); }, 120); });
  const used = new Set(S.entries.map((e) => e.lineId));
  const rank = (l) => (l.id === 'other' ? 2 : l.group === 'lifestyle' ? 0 : 1);
  const filters = [['all', 'All'], ...S.plan.lines.filter((l) => l.kind === 'envelope' && (l.amount > 0 || used.has(l.id))).sort((a, b) => rank(a) - rank(b)).map((l) => [l.id, l.name]), ['payments', 'Payments']];
  if (!filters.some((f) => f[0] === ui.logFilter)) ui.logFilter = 'all';
  const chips = h('div', { class: 'chips', role: 'tablist' }, filters.map(([id, n]) => h('button', { class: 'chip' + (ui.logFilter === id ? ' on' : ''), role: 'tab', 'aria-selected': ui.logFilter === id ? 'true' : 'false', text: n, onclick: () => { ui.logFilter = id; ui.logLimit = 120; render(); } })));
  put(scr, search, chips);

  function buildList() {
    let items = logItems();
    if (ui.logFilter === 'payments') items = items.filter((i) => i.kind !== 'spend');
    else if (ui.logFilter !== 'all') items = items.filter((i) => i.kind === 'spend' && i.lineId === ui.logFilter);
    const q = ui.logQuery.trim().toLowerCase();
    if (q) items = items.filter((i) => `${i.title} ${i.sub} ${money(i.amount)} ${E.fromP(i.amount)}`.toLowerCase().includes(q));
    const wrap = h('div', { id: 'loglist' });
    if (!items.length) {
      put(wrap, h('div', { class: 'empty' }, h('span', { class: 'serif', text: q ? 'Nothing matches.' : 'Nothing here yet.' }), q ? 'Try another word or amount.' : 'Tap + to log your first spend. It takes two taps.'));
      return wrap;
    }
    const shown = items.slice(0, ui.logLimit);
    let day = null, block = null;
    const dayTotals = {};
    for (const i of items) if (i.kind === 'spend') dayTotals[i.date] = (dayTotals[i.date] || 0) + i.amount;
    for (const i of shown) {
      if (i.date !== day) {
        day = i.date;
        put(wrap, h('div', { class: 'dayhead' }, h('span', { text: day === today() ? 'Today' : day === E.addDays(today(), -1) ? 'Yesterday' : E.longDate(day) }), dayTotals[day] ? h('span', { class: 'num', text: `${money(dayTotals[day])} spent` }) : null));
        block = h('div'); put(wrap, block);
      }
      const isIn = i.kind === 'spend' ? i.amount < 0 : i.kind === 'save' && i.amount < 0 ? false : false;
      const amtTxt = i.kind === 'spend' ? (i.amount < 0 ? `+${money(-i.amount)}` : money(i.amount)) : i.kind === 'save' ? (i.amount >= 0 ? money(i.amount) : `−${money(-i.amount)}`) : money(i.amount);
      const rowEl = h('button', { class: 'row', onclick: () => openLogItem(i) },
        h('div', { class: 'main' }, h('div', { class: 'name', text: i.title }), h('div', { class: 'meta', text: i.sub })),
        h('div', { class: 'amt num' + (isIn ? ' pos' : '') + (i.kind !== 'spend' ? ' muted' : ''), text: amtTxt }));
      block.append(swipeRow(rowEl, i.kind === 'spend' ? 'Delete' : 'Remove', () => removeLogItem(i)));
    }
    if (items.length > shown.length) put(wrap, h('button', { class: 'btn line wide', style: { marginTop: '18px' }, text: `Show ${Math.min(120, items.length - shown.length)} more`, onclick: () => { ui.logLimit += 120; const list = scr.querySelector('#loglist'); list.replaceWith(buildList()); } }));
    return wrap;
  }
  put(scr, buildList());
  return scr;
}
function removeLogItem(i) {
  commit(() => {
    if (i.kind === 'spend') S.entries = S.entries.filter((e) => e.id !== i.id);
    else if (i.kind === 'bill') { if (S.bills[i.key]) { delete S.bills[i.key][i.lineId]; if (!Object.keys(S.bills[i.key]).length) delete S.bills[i.key]; } }
    else if (i.kind === 'debt') {
      const ps = S.debtPays.filter((p) => (p.group || p.id) === i.group);
      for (const p of ps) if (p.taskId) { const tk = S.plan.tasks.find((x) => x.id === p.taskId); if (tk) tk.done = false; }
      S.debtPays = S.debtPays.filter((p) => (p.group || p.id) !== i.group);
    } else S.savingsLog = S.savingsLog.filter((s) => s.id !== i.id);
  }, i.kind === 'spend' ? 'Deleted.' : 'Payment removed.');
}
function openLogItem(i) {
  if (i.kind === 'spend') return openAdd(i.ref);
  const text = i.kind === 'bill' ? `This marks ${i.title} as not paid for that cycle.` : i.kind === 'debt' ? 'This removes the payment. Your debt balance goes back up by the same amount.' : 'This removes the savings entry.';
  confirmSheet(`${i.title} · ${money(Math.abs(i.amount))} EGP`, `${E.longDate(i.date)}. ${text}`, 'Undo this payment', () => removeLogItem(i), { danger: true });
}
// Swipe left on a row to reveal Delete. A tap elsewhere or a swipe back closes it.
let openSwipe = null;
function swipeRow(rowEl, label, onAction) {
  const act = h('button', { class: 'swipe-act', text: label, 'aria-hidden': 'true', tabindex: '-1', onclick: (e) => { e.stopPropagation(); onAction(); } });
  const wrap = h('div', { class: 'swipe' }, act, rowEl);
  const W = 92;
  let x0 = null, y0 = null, dx = 0, base = 0, horiz = null;
  const setX = (x, anim) => { rowEl.style.transition = anim ? 'transform .2s ease' : 'none'; rowEl.style.transform = x ? `translateX(${x}px)` : ''; };
  const close = () => { setX(0, true); wrap.classList.remove('open'); if (openSwipe === close) openSwipe = null; };
  rowEl.addEventListener('touchstart', (e) => { if (openSwipe && openSwipe !== close) openSwipe(); x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horiz = null; base = wrap.classList.contains('open') ? -W : 0; }, { passive: true });
  rowEl.addEventListener('touchmove', (e) => {
    if (x0 == null) return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (horiz == null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) horiz = Math.abs(mx) > Math.abs(my);
    if (!horiz) return;
    dx = Math.min(0, Math.max(-W * 1.3, base + mx)); setX(dx, false);
  }, { passive: true });
  rowEl.addEventListener('touchend', () => {
    if (x0 == null) return; x0 = null;
    if (!horiz) return;
    if (dx < -W / 2) { setX(-W, true); wrap.classList.add('open'); openSwipe = close; } else close();
  });
  rowEl.addEventListener('click', (e) => { if (wrap.classList.contains('open')) { e.stopImmediatePropagation(); e.preventDefault(); close(); } }, true);
  return wrap;
}

/* ================= MENU ================= */
function openMenu() {
  openSheet('Margin', (body, api) => {
    const t = today();
    const item = (label, sub, fn, cls = '') => h('button', { class: 'row ' + cls, onclick: () => { api.close(); fn(); } }, h('div', { class: 'main' }, h('div', { class: 'name', text: label }), sub ? h('div', { class: 'meta', text: sub }) : null));
    const list = h('div', { class: 'list' });
    if (E.planStarted(S, t)) {
      const c = E.cycleInfo(S, t);
      if (c.daysLeft <= 7 && c.dayIndex > 1) list.append(item('Salary came early', `Start the next pay cycle today instead of ${E.shortDate(c.nextPayday)}`, () => confirmSheet('Start the next cycle today?', `Your new pay cycle will start today, ${E.shortDate(t)}. Bills and the daily share reset for the new cycle.`, 'Start new cycle', () => commit(() => { S.cycleStarts[E.nextKey(c.key)] = t; }, 'New cycle started.'))));
      if (S.cycleStarts[c.key]) list.append(item('Undo early payday', `This cycle started on ${E.shortDate(c.start)}`, () => commit(() => { delete S.cycleStarts[c.key]; }, 'Payday moved back.')));
    }
    list.append(
      item('Edit plan', 'Income, bills, buckets, debts', openEditor),
      item('Back up', S.meta.lastBackup ? `Last backup ${E.shortDate(E.todayISO(new Date(S.meta.lastBackup)))}` : 'Save a copy to Files', exportBackup),
      item('Restore from a backup', 'Replace what’s on this phone', importBackup),
      item('Evening reminder', 'A nudge at 9pm to log the day', openReminderHelp),
      item('Playful reactions', S.meta.reactions ? 'On — tap to turn off' : 'Off — tap to turn on', () => commit(() => { S.meta.reactions = !S.meta.reactions; }, S.meta.reactions ? 'Reactions off.' : 'Reactions on. Yalla.', { undo: false })),
    );
    if (!isStandalone()) list.append(item('Add to Home Screen', 'Use Margin like an app', openInstallHelp));
    const snap = readSnapshot();
    if (snap) list.append(item('Bring back what I had', `From before the reset on ${E.shortDate(E.todayISO(new Date(snap.at)))}`, restoreSnapshot));
    put(body, list, h('h2', { class: 'sec', text: 'Start over' }));
    const list2 = h('div', { class: 'list' },
      item('Start fresh from today', 'Keep the plan, set today’s real balances, clear the history', openFreshStart),
      item('Clear spending log', 'Delete logged spending, keep payments and the plan', clearSpending),
      item('Erase everything', 'Remove the plan and all data from this phone', eraseAll, 'danger'));
    put(body, list2, h('p', { class: 'why', style: { marginTop: '16px', textAlign: 'center' }, text: `Margin ${VERSION} · Your data stays on this phone.` }));
    return;
    put(body, list, h('p', { class: 'why', style: { marginTop: '16px', textAlign: 'center' }, text: `Margin ${VERSION} · Your data stays on this phone.` }));
  });
}

function openReminderHelp() {
  openSheet('Evening reminder', (body) => {
    put(body, h('p', { class: 'lede', text: 'A daily nudge keeps the log honest. It takes 30 seconds to set up:' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'Open the Reminders app and tap New Reminder.' }),
        h('li', { text: 'Name it “Log today in Margin”.' }),
        h('li', { text: 'Tap the info button, turn on Date and Time, set 9:00 PM.' }),
        h('li', { text: 'Set Repeat to Daily. Done.' })),
      h('p', { class: 'why', text: 'When it pops up, open Margin — after 6pm Today asks “Anything you spent today?”' }));
  });
}
function openInstallHelp() {
  openSheet('Add to Home Screen', (body) => {
    put(body, 
      h('ol', { class: 'steps' },
        h('li', {}, 'In Safari, tap the Share button ', icon.share(), ' in the toolbar.'),
        h('li', { text: 'Scroll down and tap “Add to Home Screen”, then Add.' }),
        h('li', { text: 'Open Margin from your Home Screen from now on.' })),
      S.plan && S.entries.length ? h('p', { class: 'why', text: 'The Home Screen app keeps its own storage, separate from Safari. To bring what you’ve logged here: tap Back up first, then in the app use Restore from a backup.' }) : null,
      S.plan && S.entries.length ? h('button', { class: 'btn ink wide', style: { marginTop: '14px' }, text: 'Back up now', onclick: exportBackup }) : null,
    );
  });
}

/* ---------------- backup ---------------- */
async function exportBackup() {
  const date = today();
  const data = JSON.stringify(S, null, 1);
  const name = `margin-backup-${date}.json`;
  let file = null;
  try { file = new File([data], name, { type: 'application/json' }); } catch { /* old Safari */ }
  const download = () => {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Margin backup' }); }
      catch (e) { if (e && e.name === 'AbortError') return; download(); }
    } else download();
  } catch {
    toast('Couldn’t make the backup. Try again.'); return;
  }
  S.meta.lastBackup = Date.now(); save(); render();
  toast('Backup saved. Keep it somewhere safe, like Files › iCloud Drive.');
}
function importBackup() {
  const input = h('input', { type: 'file', accept: 'application/json,.json' });
  input.addEventListener('change', async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (f.size > 5e6) { toast('That file is too big to be a Margin backup.'); return; }
    let next;
    try { next = E.validateState(JSON.parse(await f.text())); } catch { toast('That file isn’t a Margin backup.'); return; }
    if (!next.plan) { toast('That backup has no plan in it.'); return; }
    confirmSheet('Restore this backup?', `It has ${plural(next.entries.length, 'entry', 'entries')}. Everything currently on this phone will be replaced.`, 'Restore', () => {
      const before = JSON.stringify(S);
      S = next; if (!save()) { S = E.validateState(JSON.parse(before)); return; }
      bootError = null; ui.tab = 'today'; render(); toast('Restored.');
    }, { danger: true });
  });
  input.click();
}
const SNAP = 'margin.snapshot';
function takeSnapshot() { try { localStorage.setItem(SNAP, JSON.stringify({ at: Date.now(), state: S })); return true; } catch { return false; } }
function readSnapshot() { try { const x = JSON.parse(localStorage.getItem(SNAP) || 'null'); return x && x.state && x.at ? x : null; } catch { return null; } }
function restoreSnapshot() {
  const snap = readSnapshot(); if (!snap) return;
  let st; try { st = E.validateState(snap.state); } catch { toast('That saved copy can’t be read.'); return; }
  confirmSheet('Bring back the old data?', `This replaces what’s on this phone now with everything as it was before the reset on ${E.shortDate(E.todayISO(new Date(snap.at)))}.`, 'Bring it back', () => {
    commit(() => { S = st; }, 'Your old data is back.');
  });
}
function clearSpending() {
  confirmSheet('Clear the spending log?', `This deletes ${plural(S.entries.length, 'logged spend', 'logged spends')}. Your plan, bills, debt payments and savings stay. A copy is kept so you can bring it back from the menu.`, 'Clear spending', () => {
    if (!takeSnapshot()) { toast('Couldn’t keep a copy first, so nothing was cleared.'); return; }
    commit(() => { S.entries = []; S.checkins = {}; S.sweeps = {}; }, 'Spending log cleared.');
  }, { danger: true });
}
function openFreshStart() {
  const t = today();
  const started = E.planStarted(S, t);
  const c = started ? E.cycleInfo(S, t) : null;
  const d = {
    debts: E.debtsOrdered(S).map((x) => ({ id: x.id, name: x.name, raw: rawFromP(E.debtBalance(S, x)) })),
    sav: rawFromP(E.savingsBalance(S)),
    tasks: E.pendingTasks(S).map((x) => ({ id: x.id, title: x.title, amount: x.amount, done: false })),
    flexLeft: c ? rawFromP(Math.max(0, E.safeToSpend(S, t).cycleLeft)) : '',
    bills: c ? E.billsForCycle(S, c.key).map((b) => ({ id: b.line.id, name: b.line.name, amount: b.line.amount, paid: !!b.paid })) : [],
    debtPaid: c ? E.cycleMoneyMoves(S, c.key).paidFromCycle > 0 : false,
    err: '',
  };
  openSheet('Start fresh from today', (body, api) => {
    const fld = (label, val, on, hint) => { const i = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', value: val }); i.addEventListener('input', () => on(i.value)); return h('div', { class: 'field' }, h('label', { text: label }), i, hint ? h('div', { class: 'hint', text: hint }) : null); };
    const tick = (label, on, val) => { const b = h('button', { class: 'tickrow' + (val ? ' on' : ''), 'aria-pressed': val ? 'true' : 'false' }, h('span', { class: 'box' }), label); b.addEventListener('click', () => { on(!val); api.refresh(); }); return b; };
    put(body, h('p', { class: 'why', style: { marginTop: '4px' }, text: 'Your plan stays. Tell Margin where things really stand today, and it starts counting from here. A copy of everything is kept in the menu in case you change your mind.' }));
    if (d.debts.length) put(body, h('h2', { class: 'sec', text: 'What you owe today' }), d.debts.map((x) => fld(x.name, x.raw, (v) => { x.raw = v; })));
    put(body, h('h2', { class: 'sec', text: 'Savings today' }), fld('In savings now', d.sav, (v) => { d.sav = v; }));
    if (d.tasks.length) put(body, h('h2', { class: 'sec', text: 'Scheduled payments' }), d.tasks.map((x) => tick(`${x.title} (${money(x.amount)}) is already paid`, (v) => { x.done = v; }, x.done)));
    if (c) {
      put(body, h('h2', { class: 'sec', text: 'This pay cycle' }),
        fld('Flexible money left until payday', d.flexLeft, (v) => { d.flexLeft = v; }, `For takeout, shopping and going out until ${E.shortDate(c.nextPayday)}.`));
      if (d.bills.length) put(body, h('div', { class: 'field' }, h('label', { text: 'Bills already paid this cycle' })), d.bills.map((b) => tick(`${b.name} · ${money(b.amount)}`, (v) => { b.paid = v; }, b.paid)));
      if (E.cycleMoneyMoves(S, c.key).debtTarget > 0) put(body, tick('I already paid this cycle’s debt amount', (v) => { d.debtPaid = v; }, d.debtPaid));
    }
    const err = h('div', { class: 'errmsg', text: d.err });
    put(body, err, h('button', { class: 'btn ink wide', style: { marginTop: '14px' }, text: 'Start fresh', onclick: () => {
      try {
        const bals = d.debts.map((x) => { const p = E.parseAmount(x.raw || '0'); if (p == null) throw new Error(`Check the amount for ${x.name}.`); return [x.id, p]; });
        const sav = E.parseAmount(d.sav || '0'); if (sav == null) throw new Error('Check the savings amount.');
        let flexLeft = null;
        if (c) { flexLeft = E.parseAmount(d.flexLeft || '0'); if (flexLeft == null) throw new Error('Check the flexible money amount.'); }
        if (!takeSnapshot()) throw new Error('Couldn’t keep a copy first, so nothing was changed.');
        api.close();
        commit(() => {
          const now = Date.now();
          const mvTarget = c ? E.cycleMoneyMoves(S, c.key).debtTarget : 0;
          S.entries = []; S.bills = {}; S.debtPays = []; S.savingsLog = []; S.checkins = {}; S.sweeps = {}; S.warmup = null;
          for (const [id, p] of bals) { const x = S.plan.debts.find((y) => y.id === id); x.balance = p; x.asOf = now; }
          S.plan.savings.balance = sav; S.plan.savings.asOf = now;
          for (const tk of d.tasks) { const x = S.plan.tasks.find((y) => y.id === tk.id); if (x && tk.done) x.done = true; }
          if (c) {
            const pool = E.budgetFor(S, c.key).lifestyle;
            const used = pool - flexLeft;
            if (used !== 0) S.entries.push({ id: E.uid(), date: c.start, amount: used, lineId: 'other', note: 'Spent before starting fresh', src: 'quick', ts: now - 2 });
            for (const b of d.bills) if (b.paid) (S.bills[c.key] ||= {})[b.id] = { date: c.start, amount: b.amount, ts: now - 2 };
            // already-paid debt counts for this cycle but not again against the balances you just entered
            const first = E.debtsOrdered(S)[0];
            if (d.debtPaid && mvTarget > 0 && first) S.debtPays.push({ id: E.uid(), debtId: first.id, amount: mvTarget, date: c.start, from: 'cycle', taskId: null, group: E.uid(), ts: now - 1 - 1e9 });
          }
        }, 'Fresh start. Counting from today.', { undo: true });
      } catch (e) { d.err = e.message; err.textContent = e.message; }
    } }));
  });
}
function eraseAll() {
  openSheet('Erase everything', (body, api) => {
    const input = h('input', { type: 'text', placeholder: 'Type ERASE', autocapitalize: 'characters', autocomplete: 'off' });
    const btn = h('button', { class: 'btn danger line wide', style: { marginTop: '14px' }, text: 'Erase this phone’s data', disabled: true, onclick: () => {
      try { localStorage.removeItem(KEY); localStorage.removeItem(PREV); localStorage.removeItem(SNAP); } catch { /* ignore */ }
      S = E.emptyState(); bootError = null; api.close(); ui.tab = 'today'; render(); toast('Erased.');
    } });
    input.addEventListener('input', () => { btn.disabled = input.value.trim().toUpperCase() !== 'ERASE'; });
    put(body, h('p', { class: 'lede', text: 'This deletes your plan and every entry on this phone. It can’t be undone unless you have a backup.' }), h('div', { class: 'field' }, input), btn);
  });
}

/* ================= PLAN EDITOR ================= */
const TYPE_OPTS = [['bill', 'Fixed bill (paid once a cycle)'], ['essential', 'Essential spending'], ['flex', 'Flexible spending']];
const typeOf = (l) => (l.kind === 'bill' ? 'bill' : l.group === 'fixed' ? 'essential' : 'flex');
function openEditor({ creating = false } = {}) {
  const base = S.plan;
  const egp = (p) => (p == null ? '' : rawFromP(p));
  const d = {
    name: base ? base.name : '',
    income: base ? egp(base.income) : '',
    payday: base ? String(base.payday) : '25',
    lines: base ? base.lines.filter((l) => !l.system).map((l) => ({ ...l, amountRaw: egp(l.amount), type: typeOf(l) })) : [
      { id: E.uid(), name: 'Rent', amountRaw: '', type: 'bill', until: null, dueDay: null, note: '' },
      { id: E.uid(), name: 'Groceries', amountRaw: '', type: 'essential', until: null, note: '' },
      { id: E.uid(), name: 'Eating out', amountRaw: '', type: 'flex', until: null, note: '' },
    ],
    debts: base ? base.debts.map((x) => ({ ...x, balRaw: egp(E.debtBalance(S, x)), origBal: E.debtBalance(S, x) })) : [],
    savRaw: base ? egp(E.savingsBalance(S)) : '0',
    savOrig: base ? E.savingsBalance(S) : 0,
    err: '',
  };
  openSheet(creating ? 'Build your plan' : 'Edit plan', (body, api) => {
    const fld = (label, input, hint) => h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null);
    const inp = (val, on, extra = {}) => { const i = h('input', { value: val ?? '', autocomplete: 'off', ...extra }); i.addEventListener('input', () => on(i.value)); return i; };
    const sel = (val, opts, on) => { const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v, text: l, selected: v === val ? true : null }))); s.addEventListener('change', () => on(s.value)); return s; };

    put(body, 
      fld('Your name (optional)', inp(d.name, (v) => { d.name = v; }, { maxlength: '30' })),
      h('div', { class: 'grid2' },
        fld('Monthly income', inp(d.income, (v) => { d.income = v; }, { inputmode: 'decimal', placeholder: 'EGP' })),
        fld('Payday', inp(d.payday, (v) => { d.payday = v; }, { inputmode: 'numeric', placeholder: '1–31' }), 'Day of the month')),
      h('h2', { class: 'sec', text: 'Bills & buckets' }),
    );
    d.lines.forEach((l, idx) => {
      const box = h('div', { class: 'editor-line' },
        fld('Name', inp(l.name, (v) => { l.name = v; }, { maxlength: '40' })),
        h('div', { class: 'grid2' },
          fld('Amount a month', inp(l.amountRaw, (v) => { l.amountRaw = v; }, { inputmode: 'decimal' })),
          fld('Type', sel(l.type, TYPE_OPTS.map(([v, t]) => [v, t.split(' (')[0]]), (v) => { l.type = v; api.refresh(); }))),
        l.type === 'bill' ? h('div', { class: 'grid2' },
          fld('Last payment', inp(l.until || '', (v) => { l.until = v || null; }, { type: 'month' }), 'Leave empty if it never ends'),
          fld('Due day', inp(l.dueDay || '', (v) => { l.dueDay = v; }, { inputmode: 'numeric', placeholder: 'Payday' }))) : null,
        h('button', { class: 'rm', text: 'Remove', onclick: () => { d.lines.splice(idx, 1); api.refresh(); } }));
      put(body, box);
    });
    put(body, h('button', { class: 'btn line wide', style: { marginTop: '12px' }, text: 'Add a bill or bucket', onclick: () => { d.lines.push({ id: E.uid(), name: '', amountRaw: '', type: 'flex', until: null, note: '' }); api.refresh(); } }));

    put(body, h('h2', { class: 'sec', text: 'Debts' }), h('p', { class: 'why', text: 'Listed in the order they get paid. Put the most expensive one first.' }));
    d.debts.forEach((x, idx) => {
      put(body, h('div', { class: 'editor-line' },
        h('div', { class: 'grid2' },
          fld('Name', inp(x.name, (v) => { x.name = v; }, { maxlength: '40' })),
          fld('Balance now', inp(x.balRaw, (v) => { x.balRaw = v; }, { inputmode: 'decimal' }))),
        h('div', { style: { display: 'flex', gap: '16px' } },
          idx > 0 ? h('button', { class: 'link', text: 'Move up', onclick: () => { d.debts.splice(idx - 1, 0, d.debts.splice(idx, 1)[0]); api.refresh(); } }) : null,
          h('button', { class: 'rm', text: 'Remove', onclick: () => { d.debts.splice(idx, 1); api.refresh(); } }))));
    });
    put(body, h('button', { class: 'btn line wide', style: { marginTop: '12px' }, text: 'Add a debt', onclick: () => { d.debts.push({ id: E.uid(), name: '', balRaw: '', origBal: null, note: '' }); api.refresh(); } }));
    put(body, h('h2', { class: 'sec', text: 'Savings' }), fld('Saved right now', inp(d.savRaw, (v) => { d.savRaw = v; }, { inputmode: 'decimal' })));

    const err = h('div', { class: 'errmsg', text: d.err });
    put(body, err, h('button', { class: 'btn ink wide', style: { marginTop: '10px' }, text: creating ? 'Start my plan' : 'Save plan', onclick: () => {
      try {
        const income = E.parseAmount(d.income);
        if (!income) throw new Error('Add your monthly income.');
        const payday = Number(d.payday);
        if (!Number.isInteger(payday) || payday < 1 || payday > 31) throw new Error('Payday should be a day between 1 and 31.');
        const lines = d.lines.map((l) => {
          if (!l.name.trim()) throw new Error('Every bill or bucket needs a name.');
          const amount = E.parseAmount(l.amountRaw || '0');
          if (amount == null) throw new Error(`Check the amount for ${l.name}.`);
          const [group, kind] = l.type === 'bill' ? ['fixed', 'bill'] : l.type === 'essential' ? ['fixed', 'envelope'] : ['lifestyle', 'envelope'];
          const dueDay = l.dueDay ? Number(l.dueDay) : null;
          if (dueDay != null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) throw new Error(`${l.name}: due day should be 1–31.`);
          return { id: l.id, name: l.name, amount, group, kind, from: l.from || null, until: kind === 'bill' ? (l.until || null) : null, dueDay: kind === 'bill' ? dueDay : null, note: l.note || '' };
        });
        const other = base ? base.lines.find((l) => l.id === 'other') : null;
        if (other) lines.push(other);
        const now = Date.now();
        const debts = d.debts.map((x, i) => {
          if (!x.name.trim()) throw new Error('Every debt needs a name.');
          const bal = E.parseAmount(x.balRaw || '0');
          if (bal == null) throw new Error(`Check the balance for ${x.name}.`);
          const changed = x.origBal == null || bal !== x.origBal;
          return { id: x.id, name: x.name, balance: changed ? bal : x.balance, asOf: changed ? now : x.asOf, order: i + 1, note: x.note || '' };
        });
        const sav = E.parseAmount(d.savRaw || '0');
        if (sav == null) throw new Error('Check the savings amount.');
        const savings = sav !== d.savOrig || !base ? { balance: sav, asOf: now } : { ...base.savings };
        let startKey = base ? base.startKey : null;
        if (!startKey) { const tmp = { plan: { payday }, cycleStarts: {} }; startKey = E.cycleKeyFor(tmp, today()); }
        const plan = E.normalisePlan({ name: d.name, currency: 'EGP', income, payday, startKey, lines, debts, savings, tasks: base ? base.tasks : [] });
        api.close();
        commit(() => { S.plan = plan; }, creating ? 'Your plan is ready.' : 'Plan saved.', { undo: !creating });
      } catch (e) { d.err = e.message; err.textContent = e.message; err.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    } }));
  });
}

/* ================= ONBOARDING ================= */
function welcomeScreen() {
  return h('main', { class: 'welcome' },
    h('div', { class: 'mark', text: 'Margin' }),
    h('h1', { text: 'A calm plan for your money.' }),
    h('p', { class: 'p', text: 'One number each morning: what’s safe to spend today. Bills, debt and savings are already taken care of.' }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn ink wide', text: 'I have a setup link', onclick: openPasteLink }),
    h('button', { class: 'btn line wide', style: { marginTop: '10px' }, text: 'Build my own plan', onclick: () => openEditor({ creating: true }) }),
    h('button', { class: 'btn quiet wide', style: { marginTop: '6px' }, text: 'Restore from a backup', onclick: importBackup }));
}
function openPasteLink() {
  openSheet('Your setup link', (body, api) => {
    const ta = h('textarea', { placeholder: 'Paste the link you were sent', 'aria-label': 'Setup link' });
    const err = h('div', { class: 'errmsg' });
    const go = (text) => {
      const tok = E.extractSetupToken(text);
      if (!tok) { err.textContent = 'That doesn’t look like a Margin setup link. Copy the whole link and try again.'; return; }
      api.close(); setupToken = tok; ui.setupStep = 'code'; render();
    };
    const canRead = navigator.clipboard && typeof navigator.clipboard.readText === 'function';
    put(body, h('div', { class: 'field' }, ta), err,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        canRead ? h('button', { class: 'btn line', text: 'Paste', onclick: async () => { try { const x = await navigator.clipboard.readText(); ta.value = x; go(x); } catch { ta.focus(); } } }) : null,
        h('button', { class: 'btn ink', style: { flex: '1' }, text: 'Continue', onclick: () => go(ta.value) })));
  });
}

function setupScreen() {
  const step = ui.setupStep;
  if (step === 'install') {
    let copied = false;
    const copyBtn = h('button', { class: 'btn ink wide', text: 'Copy my setup link' });
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); copied = true; copyBtn.textContent = 'Copied ✓'; }
      catch { copyBtn.textContent = 'Couldn’t copy — keep the message with the link'; }
    });
    return h('main', { class: 'welcome' },
      h('div', { class: 'mark', text: 'Margin' }),
      h('h1', { text: 'First, make it an app.' }),
      h('p', { class: 'p', text: 'Margin works best from your Home Screen — full screen, offline, and your data stays put.' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'Tap Copy my setup link below.' }),
        h('li', {}, 'Tap the Share button ', icon.share(), ' in Safari, then “Add to Home Screen”.'),
        h('li', { text: 'Open Margin from your Home Screen, tap “I have a setup link” and paste.' })),
      h('div', { class: 'grow' }),
      copyBtn,
      h('button', { class: 'btn quiet wide', style: { marginTop: '8px' }, text: 'Or continue here in Safari', onclick: () => { ui.setupStep = 'code'; render(); } }));
  }
  if (step === 'code') {
    const input = h('input', { class: 'code-input num', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '••••••', 'aria-label': 'Six-digit code' });
    const err = h('div', { class: 'errmsg' });
    const btn = h('button', { class: 'btn ink wide', text: 'Unlock my plan' });
    const go = async () => {
      const code = E.normaliseDigits(input.value).replace(/\D/g, '');
      if (code.length !== 6) { err.textContent = 'The code has 6 digits.'; return; }
      btn.disabled = true; btn.textContent = 'Unlocking…'; err.textContent = '';
      try {
        const obj = await E.openSetup(setupToken, code);
        const plan = E.normalisePlan(obj.plan, { amountsInEGP: true });
        ui.setupData = { plan, id: String(obj.id || '') }; ui.setupStep = 'preview'; render();
      } catch (e) { btn.disabled = false; btn.textContent = 'Unlock my plan'; err.textContent = e.message || 'Something went wrong. Try again.'; input.select(); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    input.addEventListener('input', () => { if (E.normaliseDigits(input.value).replace(/\D/g, '').length === 6) go(); });
    btn.addEventListener('click', go);
    setTimeout(() => input.focus(), 300);
    return h('main', { class: 'welcome' },
      h('div', { class: 'mark', text: 'Margin' }),
      h('h1', { text: 'Unlock your plan.' }),
      h('p', { class: 'p', text: 'Enter the 6-digit code you were given with the link. It keeps your numbers private.' }),
      h('div', { class: 'field', style: { marginTop: '26px' } }, input), err,
      h('div', { class: 'grow' }),
      btn,
      h('button', { class: 'btn quiet wide', style: { marginTop: '8px' }, text: 'Cancel', onclick: cancelSetup }));
  }
  if (step === 'preview') {
    const { plan } = ui.setupData;
    const tmp = { ...E.emptyState(), plan };
    const k = plan.startKey;
    const b = E.budgetFor(tmp, k);
    const mv = E.cycleMoneyMoves(tmp, k);
    const pr = E.project(tmp, today());
    const replacing = S.plan && S.meta.setupId !== ui.setupData.id;
    const row = (n, v) => h('div', { class: 'row' }, h('div', { class: 'main' }, h('div', { class: 'name', text: n })), h('div', { class: 'amt num', text: v }));
    return h('main', { class: 'welcome' },
      h('div', { class: 'mark', text: 'Margin' }),
      h('h1', { text: plan.name ? `Hi ${plan.name}. Here’s your plan.` : 'Here’s your plan.' }),
      h('p', { class: 'p', text: `It starts on payday, ${E.longDate(E.cycleStart(tmp, k))}.` }),
      h('div', { class: 'preview' },
        row('Income', money(b.income)), row('Bills & essentials', money(b.fixed)), row('Flexible spending', money(b.lifestyle)),
        mv.debtTarget ? row('Toward your debt', money(mv.debtTarget)) : null, mv.saveTarget ? row('To savings', money(mv.saveTarget)) : null,
        pr.debtFreeKey && pr.debtFreeKey !== 'now' ? row('Free of debt by', E.monthYear(pr.debtFreeKey)) : null),
      replacing ? h('p', { class: 'why', style: { marginTop: '14px' }, text: 'This replaces the plan on this phone. Spending you’ve already logged stays.' }) : null,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn ink wide', style: { marginTop: '24px' }, text: 'Start my plan', onclick: acceptSetup }),
      h('button', { class: 'btn quiet wide', style: { marginTop: '8px' }, text: 'Cancel', onclick: cancelSetup }));
  }
  return h('div');
}
function clearHash() { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ } }
function cancelSetup() { setupToken = null; ui.setupStep = null; ui.setupData = null; clearHash(); render(); }
function acceptSetup() {
  const { plan, id } = ui.setupData;
  const before = JSON.stringify(S);
  S.plan = plan; S.meta.setupId = id || null; S.meta.fx.lastSeen = today();
  if (!save()) { S = E.validateState(JSON.parse(before)); return; }
  try { localStorage.setItem('margin.lastToken', setupToken); } catch { /* ignore */ }
  setupToken = null; ui.setupStep = null; ui.setupData = null; ui.tab = 'today';
  clearHash();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  toast('Your plan is ready.');
}

/* ---------------- recovery ---------------- */
function recoveryScreen() {
  if (bootError.kind === 'blocked') {
    return h('main', { class: 'welcome' }, h('div', { class: 'mark', text: 'Margin' }), h('h1', { text: 'Storage is turned off.' }),
      h('p', { class: 'p', text: 'This browser isn’t letting Margin save anything — often because of Private Browsing. Open Margin in a normal Safari tab or from your Home Screen.' }));
  }
  return h('main', { class: 'welcome' }, h('div', { class: 'mark', text: 'Margin' }), h('h1', { text: 'Something’s off with your saved data.' }),
    h('p', { class: 'p', text: 'Margin couldn’t read what’s saved on this phone. Nothing has been deleted. Save a copy of the raw data first, then restore a backup or start fresh.' }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn ink wide', text: 'Save a copy of the raw data', onclick: async () => {
      const blob = new Blob([bootError.raw || ''], { type: 'text/plain' });
      const f = new File([blob], `margin-raw-${today()}.txt`, { type: 'text/plain' });
      try { if (navigator.canShare && navigator.canShare({ files: [f] })) await navigator.share({ files: [f] }); else { const u = URL.createObjectURL(blob); const a = h('a', { href: u, download: f.name }); document.put(body, a); a.click(); a.remove(); } } catch { /* cancelled */ }
    } }),
    h('button', { class: 'btn line wide', style: { marginTop: '10px' }, text: 'Restore from a backup', onclick: () => { S = E.emptyState(); importBackup(); } }),
    h('button', { class: 'btn quiet wide danger', style: { marginTop: '6px' }, text: 'Start fresh', onclick: () => confirmSheet('Start fresh?', 'This clears the unreadable data from this phone.', 'Start fresh', () => { try { localStorage.removeItem(KEY); localStorage.removeItem(PREV); } catch { /* ignore */ } bootError = null; S = E.emptyState(); render(); }, { danger: true }) }));
}

/* ================= BOOT ================= */
function readHash() {
  const tok = E.extractSetupToken(location.hash);
  if (!tok) return;
  let last = null;
  try { last = localStorage.getItem('margin.lastToken'); } catch { /* ignore */ }
  if (S && S.plan && last === tok) { clearHash(); return; }
  setupToken = tok;
  ui.setupStep = isIOS() && !isStandalone() && !(S && S.plan) ? 'install' : 'code';
}

function boot() {
  load();
  if (!bootError) readHash();
  render();
  setTimeout(checkOpenReactions, 600);
  window.addEventListener('hashchange', () => { readHash(); render(); });
  const tick = () => { if (today() !== lastToday && !currentSheet) { render(); checkOpenReactions(); } };
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reloadFromStorage(); tick(); } });
  window.addEventListener('storage', (e) => { if (e.key === KEY) reloadFromStorage(true); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || isLocal)) registerSW();
}
function reloadFromStorage(force = false) {
  if (bootError) return;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    if (!force && raw === JSON.stringify(S)) return;
    S = E.validateState(JSON.parse(raw));
    if (!currentSheet) render();
  } catch { /* keep current state */ }
}
function registerSW() {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) return; refreshing = true; location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = (w) => showUpdate(w);
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch(() => { /* offline-first is a bonus, not a requirement */ });
}
function showUpdate(worker) {
  const root = document.getElementById('toast-root');
  root.replaceChildren(h('div', { class: 'toast', role: 'status' }, h('div', { class: 'msg', text: 'A new version of Margin is ready.' }),
    h('button', { text: 'Update', onclick: () => worker.postMessage('skipWaiting') })));
  clearTimeout(toastTimer);
}

boot();
