// Margin — plan engine. Pure functions, no DOM.
// Money is stored as integer piastres (1 EGP = 100) to avoid float drift.

export const SCHEMA_VERSION = 1;

/* ---------------- money ---------------- */
export const toP = (egp) => Math.round(Number(egp) * 100);
export const fromP = (p) => p / 100;

export function fmt(p, { sign = false, decimals = 'auto' } = {}) {
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  let s = whole.toLocaleString('en-US');
  if ((decimals === 'auto' && frac !== 0) || decimals === true) {
    s += '.' + String(frac).padStart(2, '0');
  }
  if (neg) return '−' + s;
  if (sign && p > 0) return '+' + s;
  return s;
}

// Accepts western and Arabic-Indic digits, commas, spaces. Returns piastres or null.
export function parseAmount(input) {
  if (input == null) return null;
  let s = String(input).trim();
  s = normaliseDigits(s).replace(/[,\s٬]/g, '').replace(/٫/g, '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const p = toP(parseFloat(s));
  return Number.isFinite(p) ? p : null;
}

export function normaliseDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/* ---------------- dates (local calendar, no time zones) ---------------- */
const pad = (n) => String(n).padStart(2, '0');
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = (now = new Date()) => isoOf(now);
export function parts(iso) { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; }
export function dayNumber(iso) { const { y, m, d } = parts(iso); return Date.UTC(y, m - 1, d) / 86400000; }
export function fromDayNumber(n) { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
export const addDays = (iso, n) => fromDayNumber(dayNumber(iso) + n);
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const isValidISO = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const { y, m, d } = parts(s);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
};
export const isValidKey = (k) => typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
export function longDate(iso) { const { y, m, d } = parts(iso); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return `${WEEKDAYS[wd]} ${d} ${MONTHS[m - 1]}`; }
export function shortDate(iso) { const { m, d } = parts(iso); return `${d} ${MONTHS[m - 1].slice(0, 3)}`; }
export function monthYear(key) { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }
export function monthShort(key) { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1].slice(0, 3)} ${y}`; }

/* ---------------- pay cycles ----------------
   A cycle is keyed by the YYYY-MM of the payday that starts it.
   Cycle "2026-10" runs from 25 Oct 2026 to 24 Nov 2026 (payday 25). */
export function nextKey(k) { let [y, m] = k.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${pad(m)}`; }
export function prevKey(k) { let [y, m] = k.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${pad(m)}`; }
export function keyDiff(a, b) { const [ya, ma] = a.split('-').map(Number); const [yb, mb] = b.split('-').map(Number); return (yb - ya) * 12 + (mb - ma); }
export function addKeys(k, n) { let r = k; if (n >= 0) for (let i = 0; i < n; i++) r = nextKey(r); else for (let i = 0; i < -n; i++) r = prevKey(r); return r; }

export function paydayDate(key, payday) {
  const [y, m] = key.split('-').map(Number);
  const d = Math.min(Math.max(1, payday), daysInMonth(y, m));
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function cycleStart(state, key) {
  const o = state.cycleStarts && state.cycleStarts[key];
  return o || paydayDate(key, state.plan.payday);
}
export function cycleEnd(state, key) { return addDays(cycleStart(state, nextKey(key)), -1); }

export function cycleKeyFor(state, iso) {
  const { y, m } = parts(iso);
  let k = `${y}-${pad(m)}`;
  if (cycleStart(state, nextKey(k)) <= iso) return nextKey(k);
  if (cycleStart(state, k) <= iso) return k;
  return prevKey(k);
}

export function cycleInfo(state, today) {
  const key = cycleKeyFor(state, today);
  const start = cycleStart(state, key);
  const end = cycleEnd(state, key);
  return {
    key, start, end,
    length: daysBetween(start, end) + 1,
    dayIndex: daysBetween(start, today) + 1,
    daysLeft: daysBetween(today, end) + 1, // including today
    nextPayday: addDays(end, 1),
  };
}

export const planStarted = (state, today) => cycleKeyFor(state, today) >= state.plan.startKey;

/* ---------------- plan structure ---------------- */
export const isActive = (line, key) => (!line.from || key >= line.from) && (!line.until || key <= line.until);
export const activeLines = (state, key) => state.plan.lines.filter((l) => isActive(l, key));
export const lineById = (state, id) => state.plan.lines.find((l) => l.id === id);

export function budgetFor(state, key) {
  const lines = activeLines(state, key);
  const sum = (f) => lines.filter(f).reduce((a, l) => a + l.amount, 0);
  const fixedBills = sum((l) => l.group === 'fixed' && l.kind === 'bill');
  const fixedSpend = sum((l) => l.group === 'fixed' && l.kind === 'envelope');
  const lifestyle = sum((l) => l.group === 'lifestyle');
  const fixed = fixedBills + fixedSpend;
  const income = state.plan.income;
  const free = income - fixed - lifestyle;
  return { income, fixedBills, fixedSpend, fixed, lifestyle, free };
}

// Lifestyle = flexible buckets. Unknown/deleted lines count as lifestyle so spending never vanishes.
export function isLifestyleEntry(state, e) {
  const l = lineById(state, e.lineId);
  return !l || l.group === 'lifestyle';
}

/* ---------------- balances ---------------- */
export function debtBalance(state, debt) {
  const paid = state.debtPays
    .filter((p) => p.debtId === debt.id && p.ts > debt.asOf)
    .reduce((a, p) => a + p.amount, 0);
  return Math.max(0, debt.balance - paid);
}
export function savingsBalance(state) {
  const s = state.plan.savings;
  const moves = state.savingsLog.filter((x) => x.ts > s.asOf).reduce((a, x) => a + x.amount, 0);
  const debtFromSavings = state.debtPays.filter((p) => p.from === 'savings' && p.ts > s.asOf).reduce((a, p) => a + p.amount, 0);
  return s.balance + moves - debtFromSavings;
}
export const debtsOrdered = (state) => [...state.plan.debts].sort((a, b) => a.order - b.order);
export const totalDebt = (state) => state.plan.debts.reduce((a, d) => a + debtBalance(state, d), 0);

// Split an amount across debts in priority order. Returns [{debtId, amount}] and any leftover.
export function splitAcrossDebts(state, amount, preferId = null) {
  let left = amount;
  const out = [];
  const order = debtsOrdered(state);
  if (preferId) order.sort((a, b) => (a.id === preferId ? -1 : b.id === preferId ? 1 : 0));
  for (const d of order) {
    if (left <= 0) break;
    const bal = debtBalance(state, d);
    if (bal <= 0) continue;
    const pay = Math.min(bal, left);
    out.push({ debtId: d.id, amount: pay });
    left -= pay;
  }
  return { parts: out, leftover: left };
}

/* ---------------- spending within a cycle ---------------- */
export function entriesBetween(state, from, to) {
  return state.entries.filter((e) => e.date >= from && e.date <= to);
}

export function spentByLine(state, from, to) {
  const m = {};
  for (const e of entriesBetween(state, from, to)) m[e.lineId] = (m[e.lineId] || 0) + e.amount;
  return m;
}

/* ---------------- buckets: planned / spent / left for every line ----------------
   A bill counts as spent by its "Paid" record plus any spending logged against it.
   Overspending on a fixed line (a bill or an essential) comes out of the flexible money. */
export function lineSpent(state, line, key, upTo) {
  const start = cycleStart(state, key);
  const end = upTo || cycleEnd(state, key);
  let sum = 0;
  for (const e of state.entries) if (e.lineId === line.id && e.date >= start && e.date <= end) sum += e.amount;
  const rec = state.bills[key] && state.bills[key][line.id];
  if (rec && rec.date <= end) sum += rec.amount;
  return sum;
}
export function fixedOverage(state, key, upTo) {
  let over = 0;
  for (const l of activeLines(state, key)) {
    if (l.group !== 'fixed') continue;
    const sp = lineSpent(state, l, key, upTo);
    if (sp > l.amount) over += sp - l.amount;
  }
  return over;
}
export function buckets(state, key, upTo) {
  return activeLines(state, key).filter((l) => l.amount > 0 || lineSpent(state, l, key, upTo) !== 0).map((l) => {
    const spent = lineSpent(state, l, key, upTo);
    const left = l.amount - spent;
    return { line: l, planned: l.amount, spent, left, over: left < 0 ? -left : 0, paid: l.kind === 'bill' ? spent > 0 : null };
  });
}

/* "Safe to spend today": what's left in the flexible pool, spread evenly over the days left.
   Today's allowance is fixed at the start of the day so it doesn't shrink as you log today.
   Unspent days roll forward automatically (more per day); overspending pulls every later day down. */
export function safeToSpend(state, today) {
  if (!planStarted(state, today)) return warmupSafe(state, today);
  const c = cycleInfo(state, today);
  const b = budgetFor(state, c.key);
  let before = 0, todaySpent = 0;
  for (const e of entriesBetween(state, c.start, today)) {
    if (!isLifestyleEntry(state, e)) continue;
    if (e.date < today) before += e.amount; else todaySpent += e.amount;
  }
  const yesterday = addDays(today, -1);
  const overBefore = yesterday >= c.start ? fixedOverage(state, c.key, yesterday) : 0;
  const overToday = fixedOverage(state, c.key, today) - overBefore;
  const poolLeftStartOfDay = b.lifestyle - before - overBefore;
  const daily = poolLeftStartOfDay > 0 ? Math.floor(poolLeftStartOfDay / c.daysLeft / 100) * 100 : 0; // whole pounds
  let delta = null;
  if (yesterday >= c.start) delta = daily - safeToSpend(state, yesterday).daily;
  return {
    mode: 'cycle',
    pool: b.lifestyle,
    daily,
    delta,
    spentToday: todaySpent + overToday,
    flexSpentToday: todaySpent,
    overToday,
    fixedOver: overBefore + overToday,
    leftToday: daily - todaySpent - overToday,
    cycleLeft: b.lifestyle - before - todaySpent - overBefore - overToday,
    daysLeft: c.daysLeft,
    cycle: c,
  };
}

function warmupSafe(state, today) {
  const startDate = cycleStart(state, state.plan.startKey);
  const daysLeft = Math.max(1, daysBetween(today, startDate)); // days until plan starts (today included)
  const w = state.warmup;
  if (!w) return { mode: 'warmup', unset: true, daysLeft, planStart: startDate };
  let before = 0, todaySpent = 0;
  for (const e of state.entries) {
    if (e.date < w.setOn || e.date >= startDate) continue;
    if (e.date < today) before += e.amount; else if (e.date === today) todaySpent += e.amount;
  }
  const left = w.amount - before;
  const daily = left > 0 ? Math.floor(left / daysLeft / 100) * 100 : 0;
  const y = addDays(today, -1);
  const delta = y >= w.setOn ? daily - warmupSafe(state, y).daily : null;
  return {
    mode: 'warmup', unset: false, pool: w.amount, daily, delta,
    spentToday: todaySpent, leftToday: daily - todaySpent,
    cycleLeft: left - todaySpent, daysLeft, planStart: startDate,
  };
}

/* ---------------- bills & tasks ---------------- */
export function billDue(state, line, key) {
  const start = cycleStart(state, key);
  if (!line.dueDay) return start;
  const { y, m } = parts(start);
  let cand = `${y}-${pad(m)}-${pad(Math.min(line.dueDay, daysInMonth(y, m)))}`;
  if (cand < start) {
    const nk = nextKey(`${y}-${pad(m)}`);
    const [ny, nm] = nk.split('-').map(Number);
    cand = `${ny}-${pad(nm)}-${pad(Math.min(line.dueDay, daysInMonth(ny, nm)))}`;
  }
  const end = cycleEnd(state, key);
  return cand > end ? end : cand;
}

export function billsForCycle(state, key) {
  const paid = (state.bills[key]) || {};
  return activeLines(state, key)
    .filter((l) => l.kind === 'bill')
    .map((l) => {
      const spent = lineSpent(state, l, key);
      return { line: l, due: billDue(state, l, key), paid: paid[l.id] || (spent > 0 ? { amount: spent, date: null } : null), spent };
    })
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

export function pendingTasks(state) { return state.plan.tasks.filter((t) => !t.done); }

/* ---------------- debt & savings for the current cycle ---------------- */
export function cycleMoneyMoves(state, key) {
  const start = cycleStart(state, key), end = cycleEnd(state, key);
  const inCycle = (x) => x.date >= start && x.date <= end;
  const paidFromCycle = state.debtPays.filter((p) => p.from === 'cycle' && inCycle(p)).reduce((a, p) => a + p.amount, 0);
  const savedFromCycle = state.savingsLog.filter((s) => s.src === 'cycle' && inCycle(s)).reduce((a, s) => a + s.amount, 0);
  const b = budgetFor(state, key);
  const free = Math.max(0, b.free);
  // Debt target for this cycle = whatever debt is left (after tasks scheduled this cycle), capped at free money.
  const pendingThisCycle = pendingTasks(state).filter((t) => t.due <= end);
  let debtLeft = totalDebt(state);
  for (const t of pendingThisCycle) if (t.debtId) debtLeft -= Math.min(t.amount, debtLeft);
  const debtTarget = Math.min(free, debtLeft + paidFromCycle);
  const debtRemaining = Math.max(0, debtTarget - paidFromCycle);
  const saveTarget = Math.max(0, free - debtTarget);
  const saveRemaining = Math.max(0, saveTarget - savedFromCycle);
  return { free, debtTarget, debtRemaining, paidFromCycle, saveTarget, saveRemaining, savedFromCycle, start, end };
}

/* ---------------- projection (the "Road") ---------------- */
export function project(state, today, maxCycles = 60) {
  const started = planStarted(state, today);
  const k0 = started ? cycleKeyFor(state, today) : state.plan.startKey;
  const bal = {};
  for (const d of state.plan.debts) bal[d.id] = debtBalance(state, d);
  let savings = savingsBalance(state);
  const order = debtsOrdered(state).map((d) => d.id);
  const tasks = pendingTasks(state).map((t) => ({ ...t }));
  const events = [];
  const series = [];
  const doneDebt = new Set(order.filter((id) => bal[id] <= 0));
  let debtFreeKey = order.every((id) => bal[id] <= 0) ? 'now' : null;

  let k = k0;
  for (let i = 0; i < maxCycles; i++) {
    const start = cycleStart(state, k), end = cycleEnd(state, k);
    // scheduled one-off tasks
    for (const t of tasks) {
      if (t.applied || t.due > end) continue;
      t.applied = true;
      if (t.from === 'savings') savings -= t.amount;
      if (t.debtId && bal[t.debtId] != null) bal[t.debtId] = Math.max(0, bal[t.debtId] - t.amount);
    }
    const b = budgetFor(state, k);
    let avail = Math.max(0, b.free);
    if (i === 0 && started) {
      const mv = cycleMoneyMoves(state, k);
      avail = Math.max(0, avail - mv.paidFromCycle - mv.savedFromCycle);
    }
    for (const id of order) {
      if (avail <= 0) break;
      const pay = Math.min(bal[id], avail);
      bal[id] -= pay; avail -= pay;
    }
    savings += avail;
    for (const id of order) {
      if (bal[id] <= 0 && !doneDebt.has(id)) {
        doneDebt.add(id);
        const d = state.plan.debts.find((x) => x.id === id);
        events.push({ type: 'debt', key: k, date: start, title: `${d.name} cleared`, debtId: id });
      }
    }
    if (!debtFreeKey && order.every((id) => bal[id] <= 0)) debtFreeKey = k;
    for (const l of state.plan.lines) {
      if (l.until === k && l.amount > 0) {
        events.push({ type: 'line', key: k, date: billDue(state, l, k), title: `Last ${lcName(l.name)} payment`, lineId: l.id, frees: l.amount });
      }
    }
    series.push({ key: k, savings, debt: order.reduce((a, id) => a + bal[id], 0) });
    k = nextKey(k);
  }
  return { events, series, debtFreeKey, startKey: k0 };
}

// "Car installment" -> "car installment", but keep acronyms like "ROSCA".
export function lcName(n) { const w = n.split(' ')[0]; return w.length > 1 && w === w.toUpperCase() ? n : n.charAt(0).toLowerCase() + n.slice(1); }

/* ---------------- reactions: pure trigger checks ---------------- */
// Flexible spending (incl. "Other") on one day.
export function flexSpentOn(state, iso) {
  return state.entries.filter((e) => e.date === iso && isLifestyleEntry(state, e)).reduce((a, e) => a + e.amount, 0);
}
// E5th fires once per 500 EGP "level" over today's share: over by 1–499 is level 1, 500–999 level 2, ...
export const OVER_STEP = 50000;
export const overLevel = (leftToday) => (leftToday < 0 ? Math.floor(-leftToday / OVER_STEP) + 1 : 0);
// Is the app counting days yet? (plan started, or the money-until-payday amount is set)
export function tracking(state, iso) {
  if (!state.plan) return false;
  if (planStarted(state, iso)) return true;
  return !!(state.warmup && iso >= state.warmup.setOn);
}
// Which reaction a just-saved spend should cause, comparing state before and after. At most one.
export function spendReaction(before, after, entry, today) {
  if (!entry || entry.date !== today || entry.amount <= 0) return null;
  if (!tracking(after, today)) return null;
  const line = lineById(after, entry.lineId);
  if (!line || line.group !== 'lifestyle') return null;
  const fx = after.meta.fx;
  const live = planStarted(after, today);
  const key = live ? cycleKeyFor(after, today) : null;
  if (live && line.id !== 'other' && line.amount > 0) {
    const was = line.amount - lineSpent(before, line, key);
    const now = line.amount - lineSpent(after, line, key);
    if (was >= 0 && now < 0 && !fx.buckets[`${key}:${line.id}`]) return { kind: 'bucket', key: `${key}:${line.id}`, line, over: -now, level: overLevel(safeToSpend(after, today).leftToday) };
  }
  const a = safeToSpend(after, today);
  const level = overLevel(a.leftToday);
  const shown = fx.overDay === today ? fx.overLevel || 0 : 0;
  if (level > shown) return { kind: 'over', level, over: -a.leftToday, tomorrow: safeToSpend(after, addDays(today, 1)).daily };
  return null;
}
// Debts that went from owing to cleared between two states.
export function clearedDebts(before, after) {
  return after.plan.debts.filter((d) => {
    const b = before.plan.debts.find((x) => x.id === d.id);
    return b && debtBalance(before, b) > 0 && debtBalance(after, d) === 0 && !after.meta.fx.debts[d.id];
  });
}
// Reactions due when the app opens (or the day rolls over), in display order.
export function openReactions(state, today) {
  const out = [];
  if (!state.plan) return out;
  const fx = state.meta.fx;
  const c = planStarted(state, today) ? cycleInfo(state, today) : null;
  const pk = c ? prevKey(c.key) : null;
  if (c && pk >= state.plan.startKey && c.dayIndex <= 10 && !fx.cycles[pk]) {
    const ps = cycleStart(state, pk), pe = cycleEnd(state, pk);
    const flexEntries = entriesBetween(state, ps, pe).filter((e) => isLifestyleEntry(state, e));
    const left = budgetFor(state, pk).lifestyle - flexEntries.reduce((a, e) => a + e.amount, 0) - fixedOverage(state, pk, pe);
    if (flexEntries.length >= 3 && left >= 0) out.push({ kind: 'cycle', key: pk, left });
  }
  const y = addDays(today, -1);
  if (fx.lastSeen === y && tracking(state, y) && !fx.nospend[y] && flexSpentOn(state, y) === 0) out.push({ kind: 'nospend', date: y, when: 'yesterday' });
  return out;
}

/* ---------------- streak ---------------- */
export function streak(state, today) {
  const days = new Set(state.entries.map((e) => e.date));
  for (const d of Object.keys(state.checkins || {})) days.add(d);
  let n = 0;
  let d = days.has(today) ? today : addDays(today, -1);
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------------- merchant memory ---------------- */
export function merchantKey(note) {
  if (!note) return '';
  return normaliseDigits(note).toLowerCase().replace(/[^a-z؀-ۿ0-9 ]+/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
}
export function guessLine(state, note) {
  const k = merchantKey(note);
  if (!k) return null;
  const id = state.merchants[k];
  if (id && lineById(state, id)) return id;
  // fall back to first word match
  const first = k.split(' ')[0];
  for (const [mk, lid] of Object.entries(state.merchants)) if (mk.split(' ')[0] === first && lineById(state, lid)) return lid;
  return null;
}

/* ---------------- usuals & note suggestions ----------------
   A "usual" is the same place + bucket + amount logged at least twice in the last 60 days
   (three times when there's no note). Things usually logged around this hour rank higher. */
export function usuals(state, today, hour, max = 4) {
  const since = addDays(today, -60);
  const groups = new Map();
  for (const e of state.entries) {
    if (e.amount <= 0 || e.date < since || e.date > today) continue;
    const l = lineById(state, e.lineId);
    if (!l || l.kind !== 'envelope' || !isActive(l, planStarted(state, today) ? cycleKeyFor(state, today) : state.plan.startKey)) continue;
    const k = `${merchantKey(e.note)}|${e.lineId}|${e.amount}`;
    const g = groups.get(k) || { note: '', lineId: e.lineId, amount: e.amount, count: 0, score: 0, last: '' };
    g.count++;
    const hr = new Date(e.ts).getHours();
    g.score += 1 + (Math.abs(hr - hour) <= 2 ? 1 : 0);
    if (e.date >= g.last) g.last = e.date;
    const n = (e.note || '').trim();
    if (n && (!g.note || (/^[a-z]/.test(g.note) && !/^[a-z]/.test(n)))) g.note = n; // prefer a capitalised spelling
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= (g.note ? 2 : 3))
    .sort((a, b) => b.score - a.score || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
    .slice(0, max);
}
// Recent distinct notes, newest first; optionally only for one bucket.
export function recentNotes(state, lineId = null, max = 3) {
  const seen = new Set(), out = [];
  const list = [...state.entries].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.ts - a.ts));
  for (const e of list) {
    if (!e.note || (lineId && e.lineId !== lineId)) continue;
    const k = merchantKey(e.note);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(e.note.trim());
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- bank SMS parsing ----------------
   Reads amount, merchant and direction from a pasted bank / wallet message.
   Never auto-saves: the result is shown for confirmation. */
const CUR = '(?:EGP|E\\.G\\.P|LE|L\\.E|جنيه|ج\\.م|جم|USD|\\$)';
const NUM = '(\\d{1,3}(?:[,\\u066C]\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const BAL_WORDS = /(available|avail\.?|balance|bal\.?|limit|الرصيد|رصيد|المتاح|حد)/i;
const CREDIT_WORDS = /(credited|received|deposit|refund|reversal|cash ?back|transfer(?:red)? to you|incoming|إيداع|ايداع|استلام|تم استلام|إضافة|اضافة|استرداد|وارد)/i;
const DEBIT_WORDS = /(debited|purchase|spent|paid|payment|withdrawal|withdrawn|charged|pos|transaction|خصم|سحب|شراء|دفع|عملية)/i;

export function parseSMS(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = normaliseDigits(raw).replace(/ /g, ' ').slice(0, 2000);
  const candidates = [];
  const reCurFirst = new RegExp(CUR + '\\s*' + NUM, 'gi');
  const reNumFirst = new RegExp(NUM + '\\s*' + CUR, 'gi');
  for (const re of [reCurFirst, reNumFirst]) {
    let m;
    while ((m = re.exec(text))) {
      const val = parseAmount(m[1]);
      if (val == null || val <= 0) continue;
      const before = text.slice(Math.max(0, m.index - 28), m.index);
      candidates.push({ val, idx: m.index, isBalance: BAL_WORDS.test(before) });
    }
  }
  if (!candidates.length) {
    // "amount 250.00" without currency
    const m = /(?:amount|amt|بمبلغ|مبلغ|قيمة)\s*:?\s*(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
    if (m) { const v = parseAmount(m[1]); if (v) candidates.push({ val: v, idx: m.index, isBalance: false }); }
  }
  const usable = candidates.filter((c) => !c.isBalance).sort((a, b) => a.idx - b.idx);
  if (!usable.length) return null;
  const amount = usable[0].val;
  const isCredit = CREDIT_WORDS.test(text) && !/(debited|purchase|خصم|شراء)/i.test(text);
  let merchant = '';
  const stop = '(?:on|at|ref|dated|using|via|with|ending|for|by|card|avail|balance|bal|the|بتاريخ|يوم|في|رقم|بطاقة)';
  const reM = new RegExp('(?:\\bat\\b|\\bfrom\\b|\\bto\\b|\\bmerchant\\b|(?:^|\\s)(?:لدى|لدي|عند|من|إلى|الى)(?=\\s))\\s*:?\\s*([A-Za-z\\u0600-\\u06FF][A-Za-z0-9\\u0600-\\u06FF&\'.\\- ]{1,40}?)(?=\\s+' + stop + '(?=\\s|$|[.,:])|[.,;:\\n]|\\s+\\d|$)', 'gi');
  let mm;
  while ((mm = reM.exec(text))) {
    const cand = mm[1].trim().replace(/\s+/g, ' ');
    if (/^(your|the|card|account|acc|a\/c|حساب|بطاق|المنتهية)/i.test(cand)) continue;
    merchant = cand; break;
  }
  return { amount, isCredit, merchant: merchant.slice(0, 40) };
}

/* ---------------- state ---------------- */
export function uid() {
  const a = new Uint8Array(8);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function emptyState() {
  return {
    v: SCHEMA_VERSION,
    plan: null,
    entries: [], bills: {}, debtPays: [], savingsLog: [],
    checkins: {}, merchants: {}, cycleStarts: {}, warmup: null, sweeps: {},
    meta: { created: Date.now(), lastBackup: null, setupId: null, reactions: true, fx: { overDay: null, overLevel: 0, lastSeen: null, buckets: {}, nospend: {}, debts: {}, cycles: {} } },
  };
}

const LINE_GROUPS = ['fixed', 'lifestyle'];
const LINE_KINDS = ['bill', 'envelope'];
const str = (x, max = 60) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const int = (x) => (Number.isInteger(x) ? x : Number.isFinite(x) ? Math.round(x) : null);

// Takes a plan from a setup link or the editor (amounts in EGP or piastres) and returns a safe, normalised plan.
export function normalisePlan(p, { amountsInEGP = false } = {}) {
  if (!p || typeof p !== 'object') throw new Error('Plan is missing');
  const money = (x) => {
    const n = amountsInEGP ? toP(x) : int(x);
    if (n == null || !Number.isFinite(n) || n < 0 || n > 1e12) throw new Error('A money amount is invalid');
    return n;
  };
  const payday = int(p.payday);
  if (!payday || payday < 1 || payday > 31) throw new Error('Payday must be a day between 1 and 31');
  if (!isValidKey(p.startKey)) throw new Error('Plan start month is invalid');
  const income = money(p.income);
  if (income <= 0) throw new Error('Income must be more than zero');
  const ids = new Set();
  const lines = (Array.isArray(p.lines) ? p.lines : []).slice(0, 60).map((l) => {
    const id = str(l.id, 24) || uid();
    if (ids.has(id)) throw new Error('Duplicate line');
    ids.add(id);
    const name = str(l.name, 40);
    if (!name) throw new Error('Every line needs a name');
    const group = LINE_GROUPS.includes(l.group) ? l.group : 'lifestyle';
    const kind = LINE_KINDS.includes(l.kind) ? l.kind : 'envelope';
    const from = l.from && isValidKey(l.from) ? l.from : null;
    const until = l.until && isValidKey(l.until) ? l.until : null;
    if (from && until && until < from) throw new Error(`${name}: end is before start`);
    const dueDay = int(l.dueDay);
    return { id, name, group, kind, amount: money(l.amount), from, until, dueDay: dueDay && dueDay >= 1 && dueDay <= 31 ? dueDay : null, note: str(l.note, 140), system: !!l.system };
  });
  if (!lines.some((l) => l.system && l.id === 'other')) {
    lines.push({ id: 'other', name: 'Other', group: 'lifestyle', kind: 'envelope', amount: 0, from: null, until: null, dueDay: null, note: 'Anything that doesn’t fit a bucket. Comes out of your flexible money.', system: true });
  }
  const dIds = new Set();
  const debts = (Array.isArray(p.debts) ? p.debts : []).slice(0, 20).map((d, i) => {
    const id = str(d.id, 24) || uid();
    if (dIds.has(id)) throw new Error('Duplicate debt');
    dIds.add(id);
    const name = str(d.name, 40);
    if (!name) throw new Error('Every debt needs a name');
    return { id, name, balance: money(d.balance), order: int(d.order) ?? i + 1, note: str(d.note, 140), asOf: int(d.asOf) ?? 0 };
  });
  const sv = p.savings || {};
  const savings = { balance: money(sv.balance ?? 0), asOf: int(sv.asOf) ?? 0, floor: sv.floor != null ? money(sv.floor) : 0 };
  const tasks = (Array.isArray(p.tasks) ? p.tasks : []).slice(0, 30).map((t) => {
    const title = str(t.title, 80);
    if (!title || !isValidISO(t.due)) throw new Error('A scheduled payment is invalid');
    return { id: str(t.id, 24) || uid(), title, amount: money(t.amount), due: t.due, from: t.from === 'savings' ? 'savings' : 'cycle', debtId: t.debtId && dIds.has(t.debtId) ? t.debtId : null, done: !!t.done };
  });
  return {
    name: str(p.name, 30), currency: str(p.currency, 6) || 'EGP',
    income, payday, startKey: p.startKey, lines, debts, savings, tasks,
  };
}

// Validates a whole saved state (from storage or a backup file).
export function validateState(s) {
  if (!s || typeof s !== 'object') throw new Error('Not a Margin backup');
  if (s.v !== SCHEMA_VERSION) throw new Error('This backup is from an unknown version');
  const out = emptyState();
  out.plan = s.plan ? normalisePlan(s.plan) : null;
  const lineIds = new Set(out.plan ? out.plan.lines.map((l) => l.id) : []);
  out.entries = (Array.isArray(s.entries) ? s.entries : []).filter((e) => e && isValidISO(e.date) && Number.isInteger(e.amount) && Math.abs(e.amount) < 1e12).map((e) => ({
    id: str(e.id, 24) || uid(), date: e.date, amount: e.amount, lineId: lineIds.has(e.lineId) ? e.lineId : 'other',
    note: str(e.note, 60), src: ['quick', 'sms', 'checkin'].includes(e.src) ? e.src : 'quick', ts: int(e.ts) ?? Date.now(),
  }));
  out.bills = {};
  if (s.bills && typeof s.bills === 'object') for (const [k, v] of Object.entries(s.bills)) {
    if (!isValidKey(k) || !v || typeof v !== 'object') continue;
    out.bills[k] = {};
    for (const [lid, rec] of Object.entries(v)) if (rec && isValidISO(rec.date) && Number.isInteger(rec.amount)) out.bills[k][lid] = { date: rec.date, amount: rec.amount, ts: int(rec.ts) ?? 0 };
  }
  const debtIds = new Set(out.plan ? out.plan.debts.map((d) => d.id) : []);
  out.debtPays = (Array.isArray(s.debtPays) ? s.debtPays : []).filter((p) => p && debtIds.has(p.debtId) && isValidISO(p.date) && Number.isInteger(p.amount) && p.amount > 0).map((p) => ({
    id: str(p.id, 24) || uid(), debtId: p.debtId, amount: p.amount, date: p.date, from: ['savings', 'cycle', 'extra'].includes(p.from) ? p.from : 'cycle', taskId: str(p.taskId, 24) || null, group: str(p.group, 24) || null, ts: int(p.ts) ?? Date.now(),
  }));
  out.savingsLog = (Array.isArray(s.savingsLog) ? s.savingsLog : []).filter((x) => x && isValidISO(x.date) && Number.isInteger(x.amount)).map((x) => ({
    id: str(x.id, 24) || uid(), amount: x.amount, date: x.date, src: ['cycle', 'manual', 'sweep'].includes(x.src) ? x.src : 'manual', note: str(x.note, 60), ts: int(x.ts) ?? Date.now(),
  }));
  out.checkins = {};
  if (s.checkins && typeof s.checkins === 'object') for (const k of Object.keys(s.checkins)) if (isValidISO(k)) out.checkins[k] = 'none';
  out.merchants = {};
  if (s.merchants && typeof s.merchants === 'object') for (const [k, v] of Object.entries(s.merchants).slice(0, 500)) if (lineIds.has(v)) out.merchants[str(k, 40)] = v;
  out.cycleStarts = {};
  if (s.cycleStarts && typeof s.cycleStarts === 'object') for (const [k, v] of Object.entries(s.cycleStarts)) if (isValidKey(k) && isValidISO(v)) out.cycleStarts[k] = v;
  out.warmup = s.warmup && Number.isInteger(s.warmup.amount) && isValidISO(s.warmup.setOn) ? { amount: s.warmup.amount, setOn: s.warmup.setOn } : null;
  out.sweeps = {};
  if (s.sweeps && typeof s.sweeps === 'object') for (const [k, v] of Object.entries(s.sweeps)) if (isValidKey(k)) out.sweeps[k] = v === 'saved' ? 'saved' : 'dismissed';
  const m = s.meta || {};
  const fx = m.fx && typeof m.fx === 'object' ? m.fx : {};
  const flags = (o, ok, max) => { const r = {}; if (o && typeof o === 'object') for (const k of Object.keys(o).slice(-max)) if (ok(k)) r[k] = 1; return r; };
  out.meta = {
    created: int(m.created) ?? Date.now(), lastBackup: int(m.lastBackup) ?? null, setupId: str(m.setupId, 40) || null,
    reactions: m.reactions !== false,
    fx: {
      overDay: isValidISO(fx.overDay) ? fx.overDay : null,
      overLevel: Number.isInteger(fx.overLevel) && fx.overLevel >= 0 && fx.overLevel < 100000 ? fx.overLevel : (isValidISO(fx.overDay) ? 1 : 0),
      lastSeen: isValidISO(fx.lastSeen) ? fx.lastSeen : null,
      buckets: flags(fx.buckets, (k) => /^\d{4}-\d{2}:[\w-]{1,24}$/.test(k), 400),
      nospend: flags(fx.nospend, isValidISO, 400),
      debts: flags(fx.debts, (k) => /^[\w-]{1,24}$/.test(k), 40),
      cycles: flags(fx.cycles, isValidKey, 120),
    },
  };
  return out;
}

/* ---------------- encrypted setup link ----------------
   Format: base64url( 0x01 | salt[16] | iv[12] | AES-GCM ciphertext ), key = PBKDF2-SHA256(code, salt, 310k). */
const ITER = 310000;
const enc = new TextEncoder(), dec = new TextDecoder();
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
async function deriveKey(code, salt, cryptoImpl) {
  const base = await cryptoImpl.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return cryptoImpl.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealSetup(obj, code, cryptoImpl = globalThis.crypto) {
  const salt = cryptoImpl.getRandomValues(new Uint8Array(16));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(code, salt, cryptoImpl);
  const ct = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(1 + 16 + 12 + ct.length);
  out[0] = 1; out.set(salt, 1); out.set(iv, 17); out.set(ct, 29);
  return b64url(out);
}
export async function openSetup(token, code, cryptoImpl = globalThis.crypto) {
  let bytes;
  try { bytes = unb64url(token); } catch { throw new Error('This link looks damaged. Copy the whole link again.'); }
  if (bytes.length < 30 || bytes[0] !== 1) throw new Error('This link looks damaged. Copy the whole link again.');
  const key = await deriveKey(code, bytes.slice(1, 17), cryptoImpl);
  let pt;
  try { pt = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(17, 29) }, key, bytes.slice(29)); }
  catch { throw new Error('That code doesn’t match this link.'); }
  return JSON.parse(dec.decode(pt));
}
export function extractSetupToken(text) {
  if (!text) return null;
  const m = /[#&]s=([A-Za-z0-9_-]{40,})/.exec(String(text).trim());
  if (m) return m[1];
  const t = String(text).trim();
  return /^[A-Za-z0-9_-]{40,}$/.test(t) ? t : null;
}
