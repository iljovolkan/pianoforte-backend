// =====================================================================
// /school — единствен преглед на целата школа за Искра и господата (admin / finance_access).
// Само ЧИТА податоци (и една мала акција: откажување на индивидуален час).
// Сите постојни рути во /finance остануваат непроменети; новиот таб „Школа“ ги користи
// и нив за запишување уплати (mark-paid, roster payment) — нема дуплирање на логика.
// =====================================================================
const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const roster = require('../roster');

const router = express.Router();

async function requireFinanceAccess(req, res, next) {
  if (req.user.role === 'admin') return next();
  try {
    const [[row]] = await pool.query('SELECT finance_access FROM users WHERE id = ?', [req.user.id]);
    if (row && row.finance_access === 1) return next();
  } catch (e) { /* паѓа на забрана */ }
  return res.status(403).json({ error: 'Немаш пристап до податоците на школата.' });
}
router.use(requireAuth, requireFinanceAccess);


// ---- Пријави на уплата од родители (табела payment_reports, миграција 37) ----
async function pendingReportsCount() {
  try {
    const [[r]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM payment_reports pr JOIN installments i ON i.id = pr.installment_id
       WHERE pr.status = 'pending' AND i.status <> 'paid'`);
    return n(r.cnt);
  } catch (e) { return 0; }   // табелата уште не постои
}

const LIST_NOTE = 'Платено според школската листа';
const today = () => new Date().toISOString().slice(0, 10);
const currentYm = () => new Date().toISOString().slice(0, 7);
const isYm = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const defaultStartYear = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; };
const schoolYear = () => { const y = defaultStartYear(); return `${y}/${y + 1}`; };
const syForMonth = (ym) => { const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)); const s = m >= 9 ? y : y - 1; return `${s}/${s + 1}`; };
const n = (v) => Number(v || 0);

function wrap(fn) {
  return async (req, res) => {
    try { await fn(req, res); }
    catch (err) { console.error('/school ' + req.method + ' ' + req.originalUrl + ' ->', err.code, err.message); res.status(500).json({ error: 'Грешка: ' + err.message }); }
  };
}

// ---------- заеднички читања ----------
// Активни претплати со збирови од ратите
async function loadActiveSubs() {
  const [rows] = await pool.query(`
    SELECT s.id AS sub_id, s.payment_plan, s.group_id, s.secondary_group_id, s.next_due_date, s.created_at,
           c.id AS child_id, c.full_name AS child_name, c.parent_id,
           u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
           p.name AS package_name, p.instrument AS package_instrument,
           g.name AS group_name, g.professor_id, pu.full_name AS professor_name,
           (SELECT COALESCE(SUM(i.amount),0) FROM installments i WHERE i.subscription_id = s.id) AS total,
           (SELECT COALESCE(SUM(i.amount),0) FROM installments i WHERE i.subscription_id = s.id AND i.status = 'paid') AS paid,
           (SELECT COUNT(*) FROM installments i WHERE i.subscription_id = s.id) AS rati,
           (SELECT COUNT(*) FROM installments i WHERE i.subscription_id = s.id AND i.status = 'paid') AS rati_paid,
           (SELECT MIN(i.due_date) FROM installments i WHERE i.subscription_id = s.id AND i.status <> 'paid') AS next_due,
           (SELECT COALESCE(SUM(i.amount),0) FROM installments i WHERE i.subscription_id = s.id AND i.status <> 'paid' AND i.due_date < CURDATE()) AS overdue_amount,
           (SELECT COUNT(*) FROM installments i WHERE i.subscription_id = s.id AND i.status <> 'paid' AND i.due_date < CURDATE()) AS overdue_cnt
    FROM subscriptions s
    JOIN children c ON c.id = s.student_id
    JOIN users u ON u.id = c.parent_id
    JOIN packages p ON p.id = s.package_id
    LEFT JOIN groups_table g ON g.id = s.group_id
    LEFT JOIN users pu ON pu.id = g.professor_id
    WHERE s.released = FALSE
    ORDER BY c.full_name ASC`);
  return rows;
}

// Деца од листата (тековна школска година) со уплати
async function loadRoster(ym) {
  const [students] = await pool.query('SELECT * FROM roster_students WHERE school_year = ? ORDER BY professor_name, full_name', [schoolYear()]);
  if (!students.length) return [];
  const [pays] = await pool.query('SELECT roster_id, pay_month, amount FROM roster_payments WHERE roster_id IN (?) ORDER BY pay_month', [students.map(s => s.id)]);
  const by = {};
  pays.forEach(p => { (by[p.roster_id] = by[p.roster_id] || []).push({ pay_month: p.pay_month, amount: n(p.amount) }); });
  return students.map(st => {
    const ps = by[st.id] || [];
    const paidTotal = ps.reduce((a, p) => a + p.amount, 0);
    const paidTo = ps.filter(p => p.pay_month <= ym).reduce((a, p) => a + p.amount, 0);
    const expected = roster.expectedThrough(st.full_price, ym);
    return {
      id: st.id, full_name: st.full_name, key: st.name_key || roster.nameKey(st.full_name), module: st.module,
      professor_id: st.professor_id, professor_name: st.professor_name, full_price: n(st.full_price),
      payments: ps, paid_total: paidTotal, expected, owed: Math.max(0, expected - paidTo)
    };
  });
}

// ---------- GET /school/overview?month= ----------
router.get('/overview', wrap(async (req, res) => {
  const ym = isYm(req.query.month) ? req.query.month : currentYm();
  const end = monthEnd(ym);

  const subs = await loadActiveSubs();
  const rosterRows = await loadRoster(ym);
  const [kids] = await pool.query(`SELECT c.id, c.full_name,
      EXISTS(SELECT 1 FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE) AS has_sub FROM children c`);
  const subKeys = new Set(subs.map(s => roster.nameKey(s.child_name)));
  const kidByKey = {};
  kids.forEach(k => { kidByKey[roster.nameKey(k.full_name)] = k; });

  const activeChildren = new Set(subs.map(s => s.child_id));
  const rosterOnly = rosterRows.filter(r => !subKeys.has(r.key) && !subKeys.has(roster.nameKey(r.full_name)));
  const rosterOnlyNoProfile = rosterOnly.filter(r => !kidByKey[roster.nameKey(r.full_name)]);
  const rosterWaiting = rosterOnly.filter(r => kidByKey[roster.nameKey(r.full_name)]);   // има профил, нема претплата
  const noPlanChildren = kids.filter(k => !k.has_sub);
  const noGroup = subs.filter(s => !s.group_id);

  // приход / плати / трошоци за избраниот месец (иста логика како /finance/summary)
  const [[inc]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS cnt FROM installments
     WHERE status = 'paid' AND (paid_note IS NULL OR paid_note <> ?) AND DATE_FORMAT(paid_at, '%Y-%m') = ?`, [LIST_NOTE, ym]);
  const [[rinc]] = await pool.query(
    `SELECT COALESCE(SUM(rp.amount),0) AS total, COUNT(*) AS cnt FROM roster_payments rp
     JOIN roster_students rs ON rs.id = rp.roster_id WHERE rs.school_year = ? AND rp.pay_month = ?`, [syForMonth(ym), ym]);
  const [[sal]] = await pool.query(`SELECT COALESCE(SUM(amount + cash_amount),0) AS total FROM staff_salaries WHERE DATE_FORMAT(month, '%Y-%m') = ?`, [ym]);
  const [[exp]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN category='trosok' THEN amount ELSE 0 END),0) AS trosoci,
            COALESCE(SUM(CASE WHEN category='marketing' THEN amount ELSE 0 END),0) AS marketing
     FROM expenses WHERE DATE_FORMAT(expense_date, '%Y-%m') = ?`, [ym]);
  const income = n(inc.total) + n(rinc.total);
  const remainder = income - n(sal.total) - n(exp.trosoci) - n(exp.marketing);

  // за наплата
  const [[due]] = await pool.query(
    `SELECT COALESCE(SUM(i.amount),0) AS total, COUNT(*) AS cnt FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
     WHERE i.status <> 'paid' AND i.due_date <= ?`, [end]);
  const [[over]] = await pool.query(
    `SELECT COALESCE(SUM(i.amount),0) AS total, COUNT(*) AS cnt, COUNT(DISTINCT s.student_id) AS kids FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
     WHERE i.status <> 'paid' AND i.due_date < CURDATE()`);
  const rosterOwed = rosterOnly.filter(r => r.owed > 0);

  // часови
  const [[ib]] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM individual_bookings WHERE status <> 'cancelled' AND booking_date >= CURDATE() AND booking_date < DATE_ADD(CURDATE(), INTERVAL 8 DAY)`);
  const [[logs]] = await pool.query(
    `SELECT COALESCE(SUM(was_held = 1),0) AS held, COALESCE(SUM(was_held = 0),0) AS not_held FROM lesson_logs WHERE DATE_FORMAT(lesson_date, '%Y-%m') = ?`, [ym]);
  const [[pcount]] = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'professor'`);
  const [[gcount]] = await pool.query(`SELECT COUNT(*) AS cnt FROM groups_table`);

  res.json({
    month: ym, school_year: schoolYear(),
    people: {
      active_students: activeChildren.size,
      roster_only: rosterOnly.length,
      total_students: activeChildren.size + rosterOnly.length,
      roster_waiting: rosterWaiting.length,
      roster_no_profile: rosterOnlyNoProfile.length,
      children_without_plan: noPlanChildren.length,
      subscriptions: subs.length,
      no_group: noGroup.length,
      professors: pcount.cnt, groups: gcount.cnt
    },
    money: {
      income, income_platform: n(inc.total), income_roster: n(rinc.total),
      payments_count: n(inc.cnt) + n(rinc.cnt),
      salaries: n(sal.total), trosoci: n(exp.trosoci), marketing: n(exp.marketing), remainder
    },
    collection: {
      due_total: n(due.total) + rosterOwed.reduce((a, r) => a + r.owed, 0),
      due_count: n(due.cnt) + rosterOwed.length,
      overdue_total: n(over.total), overdue_count: n(over.cnt), overdue_kids: n(over.kids),
      roster_owed_total: rosterOwed.reduce((a, r) => a + r.owed, 0), roster_owed_count: rosterOwed.length,
      reports_pending: await pendingReportsCount()
    },
    lessons: { individual_next_7_days: ib.cnt, held_month: n(logs.held), not_held_month: n(logs.not_held) },
    attention: {
      no_group: noGroup.slice(0, 15).map(s => ({ child_id: s.child_id, child_name: s.child_name, package_name: s.package_name })),
      waiting: rosterWaiting.slice(0, 15).map(r => ({ full_name: r.full_name, professor_name: r.professor_name, full_price: r.full_price, paid_total: r.paid_total })),
      no_profile: rosterOnlyNoProfile.slice(0, 15).map(r => ({ full_name: r.full_name, professor_name: r.professor_name }))
    }
  });
}));

// ---------- GET /school/students — сите ученици на едно место (платформа + само-листа + без план) ----------
router.get('/students', wrap(async (req, res) => {
  const ym = currentYm();
  const subs = await loadActiveSubs();
  const rosterRows = await loadRoster(ym);
  const [kids] = await pool.query(`SELECT c.id, c.full_name, c.parent_id, u.full_name AS parent_name, u.email AS parent_email,
      (SELECT GROUP_CONCAT(DISTINCT g.name SEPARATOR ', ') FROM group_members gm JOIN groups_table g ON g.id = gm.group_id WHERE gm.student_id = c.id) AS groups_list,
      (SELECT COUNT(*) FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE) AS active_subs
    FROM children c JOIN users u ON u.id = c.parent_id ORDER BY c.full_name`);

  const rosterByKey = {};
  rosterRows.forEach(r => { (rosterByKey[roster.nameKey(r.full_name)] = rosterByKey[roster.nameKey(r.full_name)] || []).push(r); });
  const used = new Set();
  const rows = [];

  subs.forEach(s => {
    const done = s.rati > 0 && s.rati_paid === s.rati;
    const kr = rosterByKey[roster.nameKey(s.child_name)] || [];
    kr.forEach(r => used.add(r.id));
    rows.push({
      kind: 'platform', child_id: s.child_id, sub_id: s.sub_id, name: s.child_name,
      parent_name: s.parent_name, parent_email: s.parent_email, parent_phone: s.parent_phone || null,
      professor_id: s.professor_id, professor_name: s.professor_name || (kr[0] ? kr[0].professor_name : null),
      group_name: s.group_name || null, package_name: s.package_name,
      total: n(s.total), paid: n(s.paid), remaining: n(s.total) - n(s.paid), rati: n(s.rati), rati_paid: n(s.rati_paid),
      next_due: s.next_due ? String(s.next_due).slice(0, 10) : null, overdue_amount: n(s.overdue_amount), overdue_cnt: n(s.overdue_cnt),
      status: done ? 'done' : (n(s.overdue_cnt) > 0 ? 'overdue' : 'ok'),
      flags: [!s.group_id ? 'no_group' : null].filter(Boolean)
    });
  });

  const kidsKey = {};
  kids.forEach(k => { kidsKey[roster.nameKey(k.full_name)] = k; });
  const kidsWithSubs = new Set(subs.map(s => s.child_id));

  // деца од листата што немаат претплата
  rosterRows.forEach(r => {
    if (used.has(r.id)) return;
    const k = kidsKey[roster.nameKey(r.full_name)];
    if (k && kidsWithSubs.has(k.id)) return;   // има претплата за друг предмет — не се дуплира
    rows.push({
      kind: 'roster', roster_id: r.id, child_id: k ? k.id : null, name: r.full_name,
      parent_name: k ? k.parent_name : null, parent_email: k ? k.parent_email : null, parent_phone: null,
      professor_id: r.professor_id, professor_name: r.professor_name, group_name: k ? k.groups_list : null,
      package_name: r.module || 'Од листата', total: r.full_price, paid: r.paid_total, remaining: Math.max(0, r.full_price - r.paid_total),
      rati: null, rati_paid: null, next_due: null, overdue_amount: r.owed, overdue_cnt: r.owed > 0 ? 1 : 0,
      status: r.paid_total >= r.full_price && r.full_price > 0 ? 'done' : (r.owed > 0 ? 'overdue' : 'ok'),
      flags: [k ? 'has_profile_no_plan' : 'no_profile']
    });
  });

  // деца со профил, без претплата и без ред во листата
  const rosterKeys = new Set(rosterRows.map(r => roster.nameKey(r.full_name)));
  kids.forEach(k => {
    if (k.active_subs > 0) return;
    if (rosterKeys.has(roster.nameKey(k.full_name))) return;
    rows.push({
      kind: 'noplan', child_id: k.id, name: k.full_name, parent_name: k.parent_name, parent_email: k.parent_email, parent_phone: null,
      professor_id: null, professor_name: null, group_name: k.groups_list || null, package_name: '—',
      total: 0, paid: 0, remaining: 0, rati: null, rati_paid: null, next_due: null, overdue_amount: 0, overdue_cnt: 0,
      status: 'noplan', flags: ['no_plan']
    });
  });

  const [profs] = await pool.query(`SELECT id, full_name FROM users WHERE role = 'professor' ORDER BY full_name`);
  res.json({ month: ym, rows, professors: profs });
}));

// ---------- GET /school/student?child_id= | roster_id= — картон на ученик ----------
router.get('/student', wrap(async (req, res) => {
  const ym = currentYm();
  let childId = req.query.child_id ? Number(req.query.child_id) : null;
  const rosterId = req.query.roster_id ? Number(req.query.roster_id) : null;
  const rosterRows = await loadRoster(ym);
  let child = null, parent = null;
  if (childId) {
    const [[c]] = await pool.query('SELECT id, full_name, age, parent_id, created_at FROM children WHERE id = ?', [childId]);
    if (!c) return res.status(404).json({ error: 'Детето не постои.' });
    child = c;
    const [[u]] = await pool.query('SELECT id, full_name, email, phone FROM users WHERE id = ?', [c.parent_id]);
    parent = u || null;
  }
  let rosterMatches = [];
  if (child) rosterMatches = rosterRows.filter(r => roster.nameKey(r.full_name) === roster.nameKey(child.full_name));
  else if (rosterId) rosterMatches = rosterRows.filter(r => r.id === rosterId);
  if (!child && !rosterMatches.length) return res.status(404).json({ error: 'Ученикот не е пронајден.' });

  let subscriptions = [], groups = [], bookings = [], attendance = [];
  if (child) {
    const [subs] = await pool.query(
      `SELECT s.id, s.payment_plan, s.group_id, s.next_due_date, s.released, s.created_at, p.name AS package_name, p.instrument,
              g.name AS group_name, pu.full_name AS professor_name
       FROM subscriptions s JOIN packages p ON p.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id LEFT JOIN users pu ON pu.id = g.professor_id
       WHERE s.student_id = ? ORDER BY s.released ASC, s.id DESC`, [child.id]);
    if (subs.length) {
      const [inst] = await pool.query(
        `SELECT id, subscription_id, installment_number, total_installments, amount, due_date, status, paid_at, paid_method, paid_note
         FROM installments WHERE subscription_id IN (?) ORDER BY subscription_id, installment_number`, [subs.map(s => s.id)]);
      const by = {};
      inst.forEach(i => { (by[i.subscription_id] = by[i.subscription_id] || []).push({ ...i, amount: n(i.amount) }); });
      subscriptions = subs.map(s => ({ ...s, installments: by[s.id] || [] }));
    }
    [groups] = await pool.query(
      `SELECT g.id, g.name, g.instrument, pu.full_name AS professor_name FROM group_members gm
       JOIN groups_table g ON g.id = gm.group_id LEFT JOIN users pu ON pu.id = g.professor_id WHERE gm.student_id = ?`, [child.id]);
    [bookings] = await pool.query(
      `SELECT b.id, b.booking_date, b.start_time, b.duration_minutes, b.instrument, b.status, u.full_name AS professor_name
       FROM individual_bookings b JOIN users u ON u.id = b.professor_id
       WHERE b.student_id = ? AND b.booking_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) ORDER BY b.booking_date, b.start_time LIMIT 60`, [child.id]);
    [attendance] = await pool.query(
      `SELECT l.lesson_date, l.was_held, la.attended, g.name AS group_name FROM lesson_attendance la
       JOIN lesson_logs l ON l.id = la.lesson_log_id LEFT JOIN groups_table g ON g.id = l.group_id
       WHERE la.child_id = ? ORDER BY l.lesson_date DESC LIMIT 20`, [child.id]);
  }
  res.json({ child, parent, subscriptions, groups, bookings, attendance, roster: rosterMatches });
}));

// ---------- GET /school/payments/due?month= — што треба да се наплати (до крајот на месецот) ----------
router.get('/payments/due', wrap(async (req, res) => {
  const ym = isYm(req.query.month) ? req.query.month : currentYm();
  const end = monthEnd(ym);
  const [rows] = await pool.query(
    `SELECT i.id AS installment_id, i.subscription_id, i.installment_number, i.total_installments, i.amount, i.due_date,
            DATEDIFF(CURDATE(), i.due_date) AS days_overdue,
            c.id AS child_id, c.full_name AS child_name, u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
            p.name AS package_name, g.name AS group_name, g.professor_id, pu.full_name AS professor_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
     JOIN children c ON c.id = s.student_id
     JOIN users u ON u.id = c.parent_id
     JOIN packages p ON p.id = s.package_id
     LEFT JOIN groups_table g ON g.id = s.group_id
     LEFT JOIN users pu ON pu.id = g.professor_id
     WHERE i.status <> 'paid' AND i.due_date <= ?
     ORDER BY i.due_date ASC, c.full_name ASC LIMIT 1000`, [end]);

  const subs = await loadActiveSubs();
  const subKeys = new Set(subs.map(s => roster.nameKey(s.child_name)));
  const rosterRows = (await loadRoster(ym)).filter(r => !subKeys.has(roster.nameKey(r.full_name)) && r.owed > 0);

  res.json({
    month: ym,
    platform: rows.map(r => ({ ...r, amount: n(r.amount), due_date: String(r.due_date).slice(0, 10), days_overdue: n(r.days_overdue) })),
    roster: rosterRows.map(r => ({ roster_id: r.id, full_name: r.full_name, professor_name: r.professor_name, full_price: r.full_price,
      paid_total: r.paid_total, expected: r.expected, owed: r.owed })),
    totals: {
      platform: rows.reduce((a, r) => a + n(r.amount), 0),
      roster: rosterRows.reduce((a, r) => a + r.owed, 0)
    }
  });
}));

// ---------- GET /school/payments/recent?from=&to= — дневник на уплати ----------
router.get('/payments/recent', wrap(async (req, res) => {
  const to = isDate(req.query.to) ? req.query.to : today();
  const from = isDate(req.query.from) ? req.query.from : new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [plat] = await pool.query(
    `SELECT i.id, i.installment_number, i.total_installments, i.amount, i.paid_at, i.paid_method, i.paid_note,
            c.id AS child_id, c.full_name AS child_name, pu.full_name AS professor_name, p.name AS package_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN children c ON c.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     LEFT JOIN groups_table g ON g.id = s.group_id
     LEFT JOIN users pu ON pu.id = g.professor_id
     WHERE i.status = 'paid' AND i.paid_at IS NOT NULL AND DATE(i.paid_at) BETWEEN ? AND ? AND (i.paid_note IS NULL OR i.paid_note <> ?)
     ORDER BY i.paid_at DESC LIMIT 1000`, [from, to, LIST_NOTE]);
  const fromYm = from.slice(0, 7), toYm = to.slice(0, 7);
  const [ros] = await pool.query(
    `SELECT rp.pay_month, rp.amount, rs.full_name, rs.professor_name FROM roster_payments rp
     JOIN roster_students rs ON rs.id = rp.roster_id
     WHERE rp.pay_month BETWEEN ? AND ? ORDER BY rp.pay_month DESC, rs.full_name LIMIT 1000`, [fromYm, toYm]);
  const rows = [
    ...plat.map(r => ({ source: 'platform', date: r.paid_at, name: r.child_name, child_id: r.child_id, professor_name: r.professor_name,
      label: `${r.package_name} · рата ${r.installment_number}/${r.total_installments}`, method: r.paid_method, note: r.paid_note, amount: n(r.amount) })),
    ...ros.map(r => ({ source: 'list', date: r.pay_month, name: r.full_name, child_id: null, professor_name: r.professor_name,
      label: 'од школската листа', method: null, note: null, amount: n(r.amount) }))
  ];
  res.json({
    from, to, rows,
    totals: { platform: plat.reduce((a, r) => a + n(r.amount), 0), list: ros.reduce((a, r) => a + n(r.amount), 0) }
  });
}));

// ---------- GET /school/professors ----------
router.get('/professors', wrap(async (req, res) => {
  const ym = isYm(req.query.month) ? req.query.month : currentYm();
  const [profs] = await pool.query(`SELECT id, full_name, email, instrument FROM users WHERE role = 'professor' ORDER BY full_name`);
  const [groups] = await pool.query(
    `SELECT g.id, g.name, g.instrument, g.capacity, g.professor_id, g.is_closed, g.location,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS members,
            (SELECT GROUP_CONCAT(CONCAT(sl.day_of_week, ' ', TIME_FORMAT(sl.start_time, '%H:%i')) ORDER BY sl.day_of_week SEPARATOR ', ')
               FROM schedule_slots sl WHERE sl.group_id = g.id) AS termini
     FROM groups_table g ORDER BY g.name`);
  const subs = await loadActiveSubs();
  const rosterRows = await loadRoster(ym);
  const subKeys = new Set(subs.map(s => roster.nameKey(s.child_name)));

  const [paidRows] = await pool.query(
    `SELECT g.professor_id, COALESCE(SUM(i.amount),0) AS total
     FROM installments i JOIN subscriptions s ON s.id = i.subscription_id JOIN groups_table g ON g.id = s.group_id
     WHERE i.status = 'paid' AND (i.paid_note IS NULL OR i.paid_note <> ?) AND DATE_FORMAT(i.paid_at, '%Y-%m') = ?
     GROUP BY g.professor_id`, [LIST_NOTE, ym]);
  const paidBy = {}; paidRows.forEach(r => { paidBy[r.professor_id] = n(r.total); });
  const [salRows] = await pool.query(`SELECT professor_id, amount, cash_amount FROM staff_salaries WHERE DATE_FORMAT(month, '%Y-%m') = ?`, [ym]);
  const salBy = {}; salRows.forEach(r => { salBy[r.professor_id] = n(r.amount) + n(r.cash_amount); });
  const [ibRows] = await pool.query(
    `SELECT professor_id, COUNT(*) AS cnt FROM individual_bookings WHERE status <> 'cancelled' AND booking_date >= CURDATE() GROUP BY professor_id`);
  const ibBy = {}; ibRows.forEach(r => { ibBy[r.professor_id] = r.cnt; });
  const [logRows] = await pool.query(
    `SELECT professor_id, SUM(was_held = 1) AS held, SUM(was_held = 0) AS not_held FROM lesson_logs WHERE DATE_FORMAT(lesson_date, '%Y-%m') = ? GROUP BY professor_id`, [ym]);
  const logBy = {}; logRows.forEach(r => { logBy[r.professor_id] = { held: n(r.held), not_held: n(r.not_held) }; });

  const out = profs.map(p => {
    const mySubs = subs.filter(s => s.professor_id === p.id);
    const myRoster = rosterRows.filter(r => r.professor_id === p.id);
    const rosterOnly = myRoster.filter(r => !subKeys.has(roster.nameKey(r.full_name)));
    const rosterPaidMonth = myRoster.reduce((a, r) => a + r.payments.filter(x => x.pay_month === ym).reduce((b, x) => b + x.amount, 0), 0);
    return {
      id: p.id, full_name: p.full_name, email: p.email, instrument: p.instrument,
      groups: groups.filter(g => g.professor_id === p.id).map(g => ({ ...g, members: n(g.members), capacity: n(g.capacity) })),
      active_students: new Set(mySubs.map(s => s.child_id)).size, roster_only: rosterOnly.length, roster_total: myRoster.length,
      overdue_kids: new Set(mySubs.filter(s => s.overdue_cnt > 0).map(s => s.child_id)).size,
      overdue_amount: mySubs.reduce((a, s) => a + n(s.overdue_amount), 0) + rosterOnly.reduce((a, r) => a + r.owed, 0),
      collected_month: (paidBy[p.id] || 0) + rosterPaidMonth, salary_month: salBy[p.id] || 0,
      individual_upcoming: ibBy[p.id] || 0, lessons_held: (logBy[p.id] || {}).held || 0, lessons_not_held: (logBy[p.id] || {}).not_held || 0
    };
  });
  // професори само од листата (без профил)
  const unlinked = {};
  rosterRows.filter(r => !r.professor_id).forEach(r => {
    const e = unlinked[r.professor_name] = unlinked[r.professor_name] || { name: r.professor_name, students: 0, paid: 0, owed: 0 };
    e.students++; e.paid += r.paid_total; e.owed += r.owed;
  });
  res.json({ month: ym, professors: out, list_only_professors: Object.values(unlinked) });
}));

// ---------- GET /school/lessons?from=&to=&professor_id= — индивидуални часови + евиденција ----------
router.get('/lessons', wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : today();
  const to = isDate(req.query.to) ? req.query.to : new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const params = [from, to];
  let prof = '';
  if (req.query.professor_id) { prof = ' AND b.professor_id = ?'; params.push(Number(req.query.professor_id)); }
  const [bookings] = await pool.query(
    `SELECT b.id, b.booking_date, b.start_time, b.duration_minutes, b.instrument, b.status, b.payment_provider_ref,
            c.id AS child_id, c.full_name AS child_name, u.id AS professor_id, u.full_name AS professor_name
     FROM individual_bookings b JOIN children c ON c.id = b.student_id JOIN users u ON u.id = b.professor_id
     WHERE b.booking_date BETWEEN ? AND ?${prof} ORDER BY b.booking_date, b.start_time LIMIT 1000`, params);
  const lp = [from, to];
  let lprof = '';
  if (req.query.professor_id) { lprof = ' AND l.professor_id = ?'; lp.push(Number(req.query.professor_id)); }
  const [logs] = await pool.query(
    `SELECT l.id, l.lesson_date, l.was_held, l.notes, u.full_name AS professor_name, g.name AS group_name,
            (SELECT COUNT(*) FROM lesson_attendance la WHERE la.lesson_log_id = l.id AND la.attended = 1) AS present,
            (SELECT COUNT(*) FROM lesson_attendance la WHERE la.lesson_log_id = l.id) AS total_marked
     FROM lesson_logs l JOIN users u ON u.id = l.professor_id LEFT JOIN groups_table g ON g.id = l.group_id
     WHERE l.lesson_date BETWEEN ? AND ?${lprof} ORDER BY l.lesson_date DESC LIMIT 500`, lp);
  res.json({
    from, to,
    bookings: bookings.map(b => ({ ...b, booking_date: String(b.booking_date).slice(0, 10), start_time: String(b.start_time).slice(0, 5) })),
    logs: logs.map(l => ({ ...l, lesson_date: String(l.lesson_date).slice(0, 10), present: n(l.present), total_marked: n(l.total_marked) }))
  });
}));

// ---------- POST /school/bookings/:id/cancel — Искра може да откаже индивидуален час ----------
router.post('/bookings/:id/cancel', wrap(async (req, res) => {
  const [[b]] = await pool.query('SELECT id, status FROM individual_bookings WHERE id = ?', [req.params.id]);
  if (!b) return res.status(404).json({ error: 'Часот не постои.' });
  if (b.status === 'cancelled') return res.status(409).json({ error: 'Часот е веќе откажан.' });
  await pool.query("UPDATE individual_bookings SET status = 'cancelled' WHERE id = ?", [b.id]);
  res.json({ ok: true });
}));

// GET /school/reports/pending — родителски пријави што чекаат потврда
router.get('/reports/pending', wrap(async (req, res) => {
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT pr.id AS report_id, pr.installment_id, pr.method, pr.paid_date, pr.note, pr.created_at,
              i.amount, i.installment_number, i.total_installments, i.due_date,
              c.id AS child_id, c.full_name AS child_name,
              u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
              p.name AS package_name, g.name AS group_name, gp.full_name AS professor_name
       FROM payment_reports pr
       JOIN installments i ON i.id = pr.installment_id
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       JOIN users u ON u.id = c.parent_id
       JOIN packages p ON p.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id
       LEFT JOIN users gp ON gp.id = g.professor_id
       WHERE pr.status = 'pending' AND i.status <> 'paid'
       ORDER BY pr.created_at ASC`);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return res.json({ rows: [], migration_missing: true });
    throw e;
  }
  res.json({ rows });
}));

// POST /school/reports/:id/resolve — се вика откако ратата е означена платена (mark-paid): ја затвора пријавата како потврдена
router.post('/reports/:id/resolve', wrap(async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT pr.id, i.status AS inst_status FROM payment_reports pr JOIN installments i ON i.id = pr.installment_id WHERE pr.id = ?`, [req.params.id]);
  if (!r) return res.status(404).json({ error: 'Пријавата не постои.' });
  if (r.inst_status !== 'paid') return res.status(409).json({ error: 'Ратата сè уште не е означена како платена.' });
  await pool.query("UPDATE payment_reports SET status = 'confirmed', reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [req.user.id, r.id]);
  res.json({ ok: true });
}));

// POST /school/reports/:id/reject { reason }
router.post('/reports/:id/reject', wrap(async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 255);
  if (!reason) return res.status(400).json({ error: 'Внеси причина за одбивање — родителот ќе ја види.' });
  const [u] = await pool.query(
    "UPDATE payment_reports SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'",
    [reason, req.user.id, req.params.id]);
  if (!u.affectedRows) return res.status(404).json({ error: 'Пријавата не е пронајдена или е веќе обработена.' });
  res.json({ ok: true });
}));

module.exports = router;
