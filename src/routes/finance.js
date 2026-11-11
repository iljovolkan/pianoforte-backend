const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const invoiceLib = require('../invoice');
const payments = require('./payments');
const { schoolMonthsLeft, buildAnnualSchedule } = require('../schedule');
const roster = require('../roster');

const router = express.Router();

// Пристап до финансиите: admin, ИЛИ корисник со finance_access=1 (максимум 3 членови
// од персоналот на кои admin им ja доделил дозволата преку /admin/staff/:id/finance-access).
// Прави сопствен DB-повик (не се потпира на req.user.finance_access од JWT токенот,
// бидejќи дозволата може да се смени по издавањето на токенот).
async function requireFinanceAccess(req, res, next) {
  if (req.user.role === 'admin') return next();
  try {
    const [[row]] = await pool.query('SELECT finance_access FROM users WHERE id = ?', [req.user.id]);
    if (row && row.finance_access === 1) return next();
  } catch (e) { /* паѓа на забрана подолу */ }
  return res.status(403).json({ error: 'Немаш пристап до финансиските податоци.' });
}
router.use(requireAuth, requireFinanceAccess);

// ---------- 1. ПРИХОД (месечно) — АВТОМАТСКИ, од платените рати ----------
// GET /finance/income?from=2026-01&to=2026-12
router.get('/income', async (req, res) => {
  const { from, to } = req.query;
  let query = `
    SELECT DATE_FORMAT(paid_at, '%Y-%m') AS month, SUM(amount) AS total
    FROM installments
    WHERE status = 'paid' AND paid_at IS NOT NULL AND (paid_note IS NULL OR paid_note <> 'Платено според школската листа')`;
  const params = [];
  if (from) { query += ' AND paid_at >= ?'; params.push(from + '-01'); }
  if (to) { query += ' AND paid_at <= LAST_DAY(?)'; params.push(to + '-01'); }
  query += ' GROUP BY month ORDER BY month DESC';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// ---------- 2. ПЛАТИ И ХОНОРАРИ по професор ----------
// GET /finance/salaries?month=2026-01
router.get('/salaries', async (req, res) => {
  const { month } = req.query;
  let query = `
    SELECT s.*, u.full_name AS professor_name, u.instrument
    FROM staff_salaries s JOIN users u ON u.id = s.professor_id
    WHERE 1=1`;
  const params = [];
  if (month) { query += ' AND s.month = ?'; params.push(month + '-01'); }
  query += ' ORDER BY s.month DESC, u.full_name ASC';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// POST /finance/salaries — внес/ажурирање на плата за професор за конкретен месец
router.post('/salaries', async (req, res) => {
  const { professor_id, month, amount, tax_amount, cash_amount, notes } = req.body;
  if (!professor_id || !month || amount === undefined) {
    return res.status(400).json({ error: 'professor_id, month и amount се задолжителни.' });
  }
  const monthDate = month.length === 7 ? month + '-01' : month;
  await pool.query(
    `INSERT INTO staff_salaries (professor_id, month, amount, tax_amount, cash_amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), tax_amount = VALUES(tax_amount), cash_amount = VALUES(cash_amount), notes = VALUES(notes)`,
    [professor_id, monthDate, amount, tax_amount || 0, cash_amount || 0, notes || null, req.user.id]
  );
  res.status(201).json({ ok: true });
});

// DELETE /finance/salaries/:id
router.delete('/salaries/:id', async (req, res) => {
  await pool.query('DELETE FROM staff_salaries WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- 3. ТРОШОЦИ И МАРКЕТИНГ ----------
// GET /finance/expenses?month=2026-01
router.get('/expenses', async (req, res) => {
  const { month } = req.query;
  let query = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];
  if (month) { query += ' AND DATE_FORMAT(expense_date, "%Y-%m") = ?'; params.push(month); }
  query += ' ORDER BY expense_date DESC';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// POST /finance/expenses
router.post('/expenses', async (req, res) => {
  const { category, description, amount, expense_date } = req.body;
  if (!description || amount === undefined || !expense_date) {
    return res.status(400).json({ error: 'description, amount и expense_date се задолжителни.' });
  }
  const [result] = await pool.query(
    `INSERT INTO expenses (category, description, amount, expense_date, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [['trosok', 'marketing'].includes(category) ? category : 'trosok', description, amount, expense_date, req.user.id]
  );
  res.status(201).json({ id: result.insertId });
});

// PUT /finance/expenses/:id
router.put('/expenses/:id', async (req, res) => {
  const { category, description, amount, expense_date } = req.body;
  await pool.query(
    `UPDATE expenses SET category=?, description=?, amount=?, expense_date=? WHERE id=?`,
    [['trosok', 'marketing'].includes(category) ? category : 'trosok', description, amount, expense_date, req.params.id]
  );
  res.json({ ok: true });
});

// DELETE /finance/expenses/:id
router.delete('/expenses/:id', async (req, res) => {
  await pool.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// ---------- 4. ОСТАТОК (приход − плати − трошоци) — АВТОМАТСКИ ПРЕСМЕТАНО ----------
// GET /finance/summary?month=2026-01
router.get('/summary', async (req, res) => {
  const { month } = req.query;
  if (!month) return res.status(400).json({ error: 'month е задолжителен (YYYY-MM).' });

  const [[incomeRow]] = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM installments
     WHERE status='paid' AND (paid_note IS NULL OR paid_note <> 'Платено според школската листа') AND DATE_FORMAT(paid_at, '%Y-%m') = ?`, [month]
  );
  const [[salaryRow]] = await pool.query(
    `SELECT COALESCE(SUM(amount + cash_amount),0) AS total FROM staff_salaries WHERE DATE_FORMAT(month, '%Y-%m') = ?`, [month]
  );
  const [[expenseRow]] = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN category='trosok' THEN amount ELSE 0 END),0) AS trosoci,
       COALESCE(SUM(CASE WHEN category='marketing' THEN amount ELSE 0 END),0) AS marketing
     FROM expenses WHERE DATE_FORMAT(expense_date, '%Y-%m') = ?`, [month]
  );

  // + уплати од увезената листа (пр. рачно/готовина/банка) за истиот месец
  let rosterIncome = 0;
  try {
    const my = Number(month.slice(0, 4)), mm = Number(month.slice(5, 7));
    const sy = schoolYearStr(mm >= 9 ? my : my - 1);
    const [[rr]] = await pool.query(
      `SELECT COALESCE(SUM(rp.amount),0) AS total FROM roster_payments rp
       JOIN roster_students rs ON rs.id = rp.roster_id WHERE rs.school_year = ? AND rp.pay_month = ?`, [sy, month]);
    rosterIncome = Number(rr.total);
  } catch (e) { /* табелите од листата можеби уште не постојат */ }

  const incomePlatform = Number(incomeRow.total);
  const income = incomePlatform + rosterIncome;
  const salaries = Number(salaryRow.total);
  const trosoci = Number(expenseRow.trosoci);
  const marketing = Number(expenseRow.marketing);
  const remainder = income - salaries - trosoci - marketing;

  res.json({ month, income, income_platform: incomePlatform, income_roster: rosterIncome, salaries, trosoci, marketing, total_expenses: trosoci + marketing, remainder });
});

// ---------- 5. НЕПЛАТЕНИ ШКОЛАРИНИ по месец ----------
// GET /finance/unpaid?month=2026-01
router.get('/unpaid', async (req, res) => {
  const { month } = req.query;
  let query = `
    SELECT i.id, i.amount, i.due_date, i.installment_number, i.total_installments,
           c.full_name AS student_name, u.full_name AS parent_name, u.email AS parent_email,
           p.name AS package_name, g.name AS group_name
    FROM installments i
    JOIN subscriptions s ON s.id = i.subscription_id
    JOIN children c ON c.id = s.student_id
    JOIN users u ON u.id = c.parent_id
    JOIN packages p ON p.id = s.package_id
    LEFT JOIN groups_table g ON g.id = s.group_id
    WHERE i.status = 'pending'`;
  const params = [];
  if (month) { query += " AND DATE_FORMAT(i.due_date, '%Y-%m') = ?"; params.push(month); }
  query += ' ORDER BY i.due_date ASC';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// ---------- 6. ПРИХОД ПО ПРОФЕСОР (колку донел секој професор) ----------
// GET /finance/professor-revenue?from=2026-01&to=2026-12
router.get('/professor-revenue', async (req, res) => {
  const { from, to } = req.query;
  let query = `
    SELECT u.id AS professor_id, u.full_name AS professor_name, u.instrument,
           COALESCE(SUM(i.amount),0) AS total_revenue,
           COUNT(DISTINCT s.student_id) AS student_count
    FROM users u
    LEFT JOIN groups_table g ON g.professor_id = u.id
    LEFT JOIN subscriptions s ON s.group_id = g.id
    LEFT JOIN installments i ON i.subscription_id = s.id AND i.status = 'paid' AND (i.paid_note IS NULL OR i.paid_note <> 'Платено според школската листа')`;
  const params = [];
  const conditions = [];
  if (from) { conditions.push('(i.paid_at IS NULL OR i.paid_at >= ?)'); params.push(from + '-01'); }
  if (to) { conditions.push('(i.paid_at IS NULL OR i.paid_at <= LAST_DAY(?))'); params.push(to + '-01'); }
  query += ` WHERE u.role = 'professor'` + (conditions.length ? ' AND ' + conditions.join(' AND ') : '');
  query += ' GROUP BY u.id, u.full_name, u.instrument ORDER BY total_revenue DESC';
  const [rows] = await pool.query(query, params);

  // + ученици и уплати од увезената листа (по професор)
  try {
    const sy = schoolYearStr(defaultStartYear());
    const [kids] = await pool.query('SELECT full_name FROM children');
    const kidKeys = new Set(kids.map(k => roster.nameKey(k.full_name)));
    const [rs] = await pool.query('SELECT id, professor_id, professor_name, full_name FROM roster_students WHERE school_year = ?', [sy]);
    const [pays] = rs.length ? await pool.query(
      `SELECT roster_id, pay_month, amount FROM roster_payments WHERE roster_id IN (?)`, [rs.map(x => x.id)]) : [[]];
    const inRange = (ym) => (!from || ym >= from) && (!to || ym <= to);
    const paidBy = {};
    pays.forEach(p => { if (inRange(p.pay_month)) paidBy[p.roster_id] = (paidBy[p.roster_id] || 0) + Number(p.amount); });
    const byProf = new Map();
    rs.forEach(r => {
      const k = r.professor_id ? 'id' + r.professor_id : 'n' + r.professor_name;
      const e = byProf.get(k) || { professor_id: r.professor_id, professor_name: r.professor_name, revenue: 0, only: 0 };
      e.revenue += paidBy[r.id] || 0;
      if (!kidKeys.has(roster.nameKey(r.full_name))) e.only++;
      byProf.set(k, e);
    });
    byProf.forEach(e => {
      const row = e.professor_id ? rows.find(r => r.professor_id === e.professor_id) : null;
      if (row) { row.total_revenue = Number(row.total_revenue) + e.revenue; row.student_count = Number(row.student_count) + e.only; }
      else rows.push({ professor_id: null, professor_name: e.professor_name + ' (од листата)', instrument: null, total_revenue: e.revenue, student_count: e.only });
    });
    rows.sort((a, b) => Number(b.total_revenue) - Number(a.total_revenue));
  } catch (e) { /* листата уште не е увезена */ }
  res.json(rows);
});

// GET /finance/invoices?from=YYYY-MM-DD&to=YYYY-MM-DD&q=пребарување
// Целата архива на фактури, пребарлива по период и по име/email.
router.get('/invoices', async (req, res) => {
  const { from, to, q } = req.query;
  let query = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (from) { query += ' AND issued_at >= ?'; params.push(from + ' 00:00:00'); }
  if (to) { query += ' AND issued_at <= ?'; params.push(to + ' 23:59:59'); }
  if (q) { query += ' AND (student_name LIKE ? OR parent_email LIKE ? OR invoice_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  query += ' ORDER BY issued_at DESC LIMIT 500';
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// GET /finance/professor-students/:professorId — сите деца доделени кај овoj
// професор (преку групи И индивидуални часови), со статус на плаќање
router.get('/professor-students/:professorId', async (req, res) => {
  try {
    const profId = Number(req.params.professorId);
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : currentYm();

    const [groupStudents] = await pool.query(`
      SELECT c.id AS child_id, c.full_name AS child_name, g.name AS group_name,
             s.id AS subscription_id, s.next_due_date, s.released
      FROM group_members gm
      JOIN children c ON c.id = gm.student_id
      JOIN groups_table g ON g.id = gm.group_id
      LEFT JOIN subscriptions s ON s.student_id = c.id AND (s.group_id = g.id OR s.secondary_group_id = g.id) AND s.released = FALSE
      WHERE g.professor_id = ?
      ORDER BY g.name, c.full_name
    `, [profId]);

    const [indivStudents] = await pool.query(`
      SELECT DISTINCT c.id AS child_id, c.full_name AS child_name, ib.instrument, MAX(ib.booking_date) AS last_lesson
      FROM individual_bookings ib
      JOIN children c ON c.id = ib.student_id
      WHERE ib.professor_id = ?
      GROUP BY c.id, c.full_name, ib.instrument
      ORDER BY c.full_name
    `, [profId]);

    const board = await fetchBoard('', profId);
    const rosterRows = await rosterForProfessor(profId, month);

    // Колку различни деца има кај професорот (платформа + листа, без дупликати по име)
    const keys = new Set();
    const ids = new Set();
    groupStudents.forEach(r => { ids.add(r.child_id); });
    indivStudents.forEach(r => { ids.add(r.child_id); });
    board.forEach(r => { ids.add(r.child_id); });
    const nameOf = {};
    groupStudents.concat(indivStudents, board).forEach(r => { nameOf[r.child_id] = r.child_name; });
    ids.forEach(id => keys.add(roster.nameKey(nameOf[id])));
    let rosterOnly = 0;
    rosterRows.forEach(r => { if (!keys.has(roster.nameKey(r.full_name))) { keys.add(roster.nameKey(r.full_name)); rosterOnly++; } });

    const today = todayStr();
    const groupRows = groupStudents.map(r => ({
      ...r,
      payment_status: !r.subscription_id ? 'нема претплата' : (r.next_due_date && String(r.next_due_date).slice(0, 10) <= today ? 'доспеано' : 'платено')
    }));
    res.json({
      group_students: groupRows, individual_students: indivStudents, board, roster: rosterRows, month,
      counts: { total: keys.size, platform: ids.size, roster_only: rosterOnly }
    });
  } catch (err) {
    console.error('GET /finance/professor-students error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на децата.' });
  }
});

// GET /finance/withdrawn-students — истиот преглед достапен и од Финансии
// (не само Admin), за 3-те со finance_access
router.get('/withdrawn-students', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM withdrawn_students ORDER BY withdrawn_at DESC');
  res.json(rows);
});

// GET /finance/professors — листа на професори (само основни податоци),
// достапна за admin И за 3-те со finance_access (не само admin)
router.get('/professors', async (req, res) => {
  const [rows] = await pool.query(`SELECT id, full_name, instrument FROM users WHERE role = 'professor' ORDER BY full_name ASC`);
  res.json(rows);
});


// =====================================================================
// РАЧНА ЕВИДЕНЦИЈА НА ПЛАЌАЊА (Искра / финансиски пристап)
// За деца што плаќаат кеш/банка или што веќе платиле пред онлајн системот.
// =====================================================================
const MANUAL_METHODS = ['cash', 'bank', 'other'];
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

async function fetchBoard(q, professorId) {
  const params = [];
  let where = 's.released = FALSE';
  if (q) { where += ' AND (c.full_name LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (professorId) {
    where += ' AND (s.group_id IN (SELECT id FROM groups_table WHERE professor_id = ?) OR s.secondary_group_id IN (SELECT id FROM groups_table WHERE professor_id = ?))';
    params.push(professorId, professorId);
  }
  const [subs] = await pool.query(
    `SELECT s.id AS subscription_id, s.payment_plan, p.name AS package_name,
            c.id AS child_id, c.full_name AS child_name, u.email AS parent_email, u.full_name AS parent_name
     FROM subscriptions s
     JOIN children c ON c.id = s.student_id
     JOIN users u ON u.id = c.parent_id
     JOIN packages p ON p.id = s.package_id
     WHERE ${where} ORDER BY c.full_name ASC LIMIT 400`, params
  );
  if (!subs.length) return [];
  const [inst] = await pool.query(
    `SELECT id, subscription_id, installment_number, total_installments, amount, due_date, status, paid_at, paid_method, paid_note
     FROM installments WHERE subscription_id IN (?) ORDER BY subscription_id, installment_number`,
    [subs.map(x => x.subscription_id)]
  );
  const bySub = {};
  inst.forEach(i => { (bySub[i.subscription_id] = bySub[i.subscription_id] || []).push(i); });
  return subs.map(x => ({ ...x, installments: bySub[x.subscription_id] || [] }));
}

// GET /finance/payment-board?q=&professor_id= — активни претплати со сите рати
router.get('/payment-board', async (req, res) => {
  try {
    res.json(await fetchBoard((req.query.q || '').trim(), req.query.professor_id ? Number(req.query.professor_id) : null));
  } catch (err) {
    console.error('GET /finance/payment-board error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на плаќањата.' });
  }
});

// GET /finance/unenrolled-children?q= — деца без активна претплата (при пребарување: и деца што веќе имаат претплата — за втор предмет)
router.get('/unenrolled-children', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [];
    let extra = '';
    if (q) { extra = ' AND (c.full_name LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT c.id, c.full_name, u.email AS parent_email, u.full_name AS parent_name,
              GROUP_CONCAT(DISTINCT g.name SEPARATOR ', ') AS groups_list,
              (SELECT COUNT(*) FROM subscriptions s2 WHERE s2.student_id = c.id AND s2.released = FALSE) AS active_subs
       FROM children c
       JOIN users u ON u.id = c.parent_id
       LEFT JOIN group_members gm ON gm.student_id = c.id
       LEFT JOIN groups_table g ON g.id = gm.group_id
       WHERE ${q ? '1=1' : 'NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE)'} ${extra}
       GROUP BY c.id ORDER BY c.full_name ASC LIMIT 200`, params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /finance/unenrolled-children error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на децата.' });
  }
});


// Дете со две дисциплини (два реда во листата): кој професор одговара на пакетот
async function guessRosterProfessor(db, childName, pkg) {
  if (!pkg) return null;
  const key = roster.nameKey(childName);
  const [rows] = await db.query('SELECT professor_name, full_name, module FROM roster_students WHERE school_year = ?', [schoolYearStr(defaultStartYear())]);
  const mine = rows.filter(r => roster.nameKey(r.full_name) === key);
  if (mine.length < 2) return null;
  const isSing = r => SINGING_RE.test(String(r.module || '').toLowerCase());
  let pick;
  if (pkg.instrument === 'peenje') pick = mine.filter(isSing);
  else { const fam = FAM_OF_PKG[pkg.id]; pick = fam ? mine.filter(r => !isSing(r) && profFamily(r.professor_name) === fam) : []; }
  return pick.length === 1 ? pick[0].professor_name : null;
}

// Колку рати од планот се веќе покриени со уплатите од увезената листа (за дете со истото име)
async function rosterCoverageFor(db, childName, schedule, professorName, cache) {
  const sy = schoolYearStr(defaultStartYear());
  const key = roster.nameKey(childName);
  const rows = cache ? cache.rows : (await db.query('SELECT id, full_name, professor_name, full_price FROM roster_students WHERE school_year = ?', [sy]))[0];
  let matches = rows.filter(r => roster.nameKey(r.full_name) === key);
  if (professorName) {   // дете со две дисциплини: се броат само уплатите кај тој професор
    const pk = String(professorName).trim().toLowerCase();
    const own = matches.filter(r => String(r.professor_name || '').trim().toLowerCase() === pk);
    if (own.length) matches = own;
  }
  if (!matches.length) return { found: false, paid_total: 0, paid_count: 0 };
  matches.sort((a, b) => Number(b.full_price) - Number(a.full_price));
  const st = matches[0];
  const paidTotal = cache ? Number(cache.sums[st.id] || 0)
    : Number((await db.query('SELECT COALESCE(SUM(amount),0) AS total FROM roster_payments WHERE roster_id = ?', [st.id]))[0][0].total);
  let cum = 0, count = 0;
  for (const it of schedule) {
    cum += Number(it.amount);
    if (paidTotal + 1 >= cum - cum * 0.005) count++; else break;   // толеранција ~0.5%
  }
  return { found: true, paid_total: paidTotal, full_price: Number(st.full_price), professor_name: st.professor_name, paid_count: count };
}

// GET /finance/roster-coverage?child_id=&package_id=&payment_plan=&start_date=
router.get('/roster-coverage', async (req, res) => {
  try {
    const { child_id, package_id, payment_plan, start_date } = req.query;
    if (!child_id || !package_id || !['full', 'two', 'eight', 'trial'].includes(payment_plan)) return res.json({ found: false });
    const [[child]] = await pool.query('SELECT full_name FROM children WHERE id = ?', [child_id]);
    const [[pkg]] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!child || !pkg) return res.json({ found: false });
    const start = isDate(start_date) ? start_date : todayStr();
    const schedule = payment_plan === 'trial'
      ? [{ number: 1, total: 1, amount: Number(pkg.price_mkd), offsetDays: 0 }]
      : buildAnnualSchedule(payment_plan, Number(pkg.price_mkd), schoolMonthsLeft(new Date(start + 'T12:00:00')));
    const cov = await rosterCoverageFor(pool, child.full_name, schedule, await guessRosterProfessor(pool, child.full_name, pkg));
    res.json({ ...cov, installments: schedule.length });
  } catch (err) { console.error('roster-coverage error:', err); res.json({ found: false }); }
});

// Заедничка логика (поединечно + масовно запишување)
// body: { child_id, package_id, payment_plan: full|two|eight|trial, paid_count, method, paid_date, start_date, note, send_invoice }
async function doManualEnrollment(body, userId) {
  const { child_id, package_id, payment_plan, paid_count, paid_date, start_date, next_due_date, send_invoice } = body;
  const useRoster = body.use_roster === true;
  let { method, note } = body;
  if (!child_id || !package_id || !['full', 'two', 'eight', 'trial'].includes(payment_plan)) {
    throw { http: 400, message: 'Избери дете, пакет и начин на плаќање.' };
  }
  let paidN = Number(paid_count);
  if (useRoster) { method = MANUAL_METHODS.includes(method) ? method : 'other'; }   // бројот на рати се определува од листата подолу
  else if (!Number.isInteger(paidN) || paidN < 0) throw { http: 400, message: 'Невалиден број на платени рати.' };
  if (!useRoster && paidN > 0 && !MANUAL_METHODS.includes(method)) throw { http: 400, message: 'Избери начин на плаќање (кеш/банка/друго).' };
  const start = isDate(start_date) ? start_date : todayStr();
  const paidOn = isDate(paid_date) ? paid_date : start;

  const conn = await pool.getConnection();
  const toInvoice = [];
  try {
    const [[child]] = await conn.query(
      `SELECT c.id, c.full_name, u.email FROM children c JOIN users u ON u.id = c.parent_id WHERE c.id = ?`, [child_id]);
    const [[pkg]] = await conn.query('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!child) { throw { http: 404, message: 'Детето не постои.' }; }
    if (!pkg) { throw { http: 404, message: 'Пакетот не постои.' }; }

    // Дозволена е втора претплата само за друг инструмент (на пр. пијано + пеење)
    const [[existing]] = await conn.query(
      `SELECT s.id FROM subscriptions s JOIN packages p ON p.id = s.package_id
       WHERE s.student_id = ? AND s.released = FALSE AND (s.package_id = ? OR (? IS NOT NULL AND p.instrument = ?)) LIMIT 1`,
      [child_id, package_id, pkg.instrument || null, pkg.instrument || null]);
    if (existing) { throw { http: 409, message: 'Ова дете веќе има активна претплата за овој инструмент. Означи ги ратите во листата.' }; }

    const customTotal = Number(body.custom_total) > 0 ? Math.round(Number(body.custom_total)) : null;
    const customCount = customTotal ? Math.min(12, Math.max(1, Math.round(Number(body.custom_count)) || 8)) : null;
    let schedule;
    if (customTotal) {   // договорена цена од листата, поделена на рати
      const base = Math.floor(customTotal / customCount);
      schedule = [];
      for (let i = 0; i < customCount; i++) schedule.push({ number: i + 1, total: customCount, amount: i === customCount - 1 ? customTotal - base * (customCount - 1) : base, offsetDays: i * 30 });
    } else {
      schedule = payment_plan === 'trial'
        ? [{ number: 1, total: 1, amount: Number(pkg.price_mkd), offsetDays: 0 }]
        : buildAnnualSchedule(payment_plan, Number(pkg.price_mkd), schoolMonthsLeft(new Date(start + 'T12:00:00')));
    }
    if (useRoster) {
      const cov = await rosterCoverageFor(conn, child.full_name, schedule, body.roster_professor || await guessRosterProfessor(conn, child.full_name, pkg));
      paidN = cov.found ? cov.paid_count : 0;
      if (paidN > 0 && !note) note = 'Платено според школската листа';
    }
    if (paidN > schedule.length) { throw { http: 400, message: `Овој план има само ${schedule.length} рат(и).` }; }

    // групи на детето (ако е веќе вклучено во група)
    let groups;
    if (pkg.instrument) {   // само групи од истиот инструмент (дете со две дисциплини)
      [groups] = await conn.query(
        `SELECT gm.group_id FROM group_members gm JOIN groups_table g ON g.id = gm.group_id
         WHERE gm.student_id = ? AND (g.instrument = ? OR ? = 1) ORDER BY gm.group_id ASC LIMIT 2`,
        [child_id, pkg.instrument, pkg.is_combo ? 1 : 0]);
    } else {
      [groups] = await conn.query('SELECT group_id FROM group_members WHERE student_id = ? ORDER BY group_id ASC LIMIT 2', [child_id]);
    }
    const groupId = groups[0] ? groups[0].group_id : null;
    const secondaryId = pkg.is_combo && groups[1] ? groups[1].group_id : null;

    await conn.beginTransaction();
    const [sub] = await conn.query(
      `INSERT INTO subscriptions (student_id, package_id, group_id, secondary_group_id, next_due_date, released, payment_plan)
       VALUES (?, ?, ?, ?, ?, FALSE, ?)`,
      [child_id, package_id, groupId, secondaryId, start, payment_plan]
    );
    // Рокот на неплатените рати НИКОГАШ не смее да е во минатото (cron би го
    // ослободил детето од групата). Првата неплатена рата доспева на избраниот
    // датум (или најрано за 7 дена од денес), а следните одат на истите растојанија.
    const firstPendingIdx = schedule.findIndex(it => it.number > paidN);
    const minDue = addDays(todayStr(), 7);
    let pendingBase = null;
    if (firstPendingIdx >= 0) {
      const computed = addDays(start, schedule[firstPendingIdx].offsetDays);
      pendingBase = isDate(next_due_date) ? next_due_date : (computed < minDue ? minDue : computed);
    }
    let nextDue = null;
    for (const it of schedule) {
      const paid = it.number <= paidN;
      const due = paid ? addDays(start, it.offsetDays)
        : addDays(pendingBase, it.offsetDays - schedule[firstPendingIdx].offsetDays);
      const [r] = await conn.query(
        `INSERT INTO installments (subscription_id, installment_number, total_installments, amount, due_date, status, paid_at, paid_method, paid_note, marked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [sub.insertId, it.number, it.total, it.amount, due, paid ? 'paid' : 'pending',
         paid ? paidOn + ' 12:00:00' : null, paid ? method : null, paid ? (note || null) : null, userId]
      );
      if (paid) toInvoice.push({ installment_id: r.insertId, number: it.number, total: it.total, amount: it.amount });
      else if (!nextDue) nextDue = due;
    }
    await conn.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?', [nextDue || addDays(start, 365), sub.insertId]);
    await conn.commit();
    conn.release();

    let invoices = 0;
    if (send_invoice && toInvoice.length) {
      for (const t of toInvoice) {
        const inv = await invoiceLib.issueInvoice({
          student_id: child_id, student_name: child.full_name, parent_email: child.email,
          package_name: schedule.length > 1 ? `${pkg.name} — рата ${t.number}/${t.total}` : pkg.name,
          amount: t.amount, payment_method: method, installment_id: t.installment_id, issued_at: paidOn + ' 12:00:00'
        });
        if (inv) { invoices++; await invoiceLib.emailInvoice(await invoiceLib.getInvoice(inv.id)); }
      }
    }
    return { ok: true, subscription_id: sub.insertId, invoices_sent: invoices, group_linked: !!groupId, paid_count: paidN, installments: schedule.length };
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    try { conn.release(); } catch (e) {}
    if (err && err.http) throw err;
    console.error('manual-enrollment error:', err);
    throw { http: 500, message: 'Грешка при запишување: ' + err.message };
  }
}


router.post('/manual-enrollment', async (req, res) => {
  try { res.status(201).json(await doManualEnrollment(req.body, req.user.id)); }
  catch (e) { res.status(e.http || 500).json({ error: e.message || 'Грешка.' }); }
});

// ── Масовно запишување (деца од листата со профил, без претплата) ──
const BULK_PKG = { piano: 10, violin: 11, guitar: 12, drums: 13, izvorce: 29, izvorceCombo: 28 };
const BULK_PROFS = {
  piano: ['Теодора Фазекаш', 'Кристина Ангелова Ановски', 'Мими Дучева', 'Ангела Николовска', 'Филип Наневски', 'Иван Трајковски', 'Анастасија Кочева'],
  violin: ['Тереза Крцоска', 'Крстина Шокароска', 'Александар Војнески'],
  guitar: ['Христијан Тасевски'],
  drums: ['Дамир Ибраимовски'],
  izvorce: ['Ана Ценевска Мучевска']
};
function tokPref(name) { return roster.nameKey(name).split(' ').filter(Boolean).map(t => t.slice(0, 3)); }
function profFamily(profName) {
  const mine = tokPref(profName);
  for (const fam of Object.keys(BULK_PROFS)) {
    for (const p of BULK_PROFS[fam]) {
      if (tokPref(p).filter(x => mine.includes(x)).length >= 2) return fam;
    }
  }
  return null;
}
const FAM_OF_PKG = { 10: 'piano', 11: 'violin', 12: 'guitar', 15: 'guitar', 13: 'drums', 28: 'izvorce', 29: 'izvorce' };
const SINGING_RE = /пеење|певање|pevanje|peenje|sing/;
// custom=false: само стандардни цени; custom=true: и договорени (нестандардни) цени → рати од листата
// Броеви на рати што Искра ги договорила поинаку од стандардните 8 (клуч = фонетски клуч на името)
const BULK_COUNT = new Map([
  ['Petra Miletikj', 7], ['Viktor Lukikj', 7], ['Деа Мерџаноски', 7], ['Siara Ramadani', 7], ['Ajlijana Kadrievska', 4], ['Ајљијана Кадриевска', 4], ['Ајлијана Кадриевска', 4]
].map(([n, c]) => [roster.nameKey(n), c]));
async function planBulk(rows, custom) {
  const [pk] = await pool.query('SELECT * FROM packages WHERE id IN (?)', [Object.values(BULK_PKG)]);
  const pkgs = {}; pk.forEach(p => { pkgs[p.id] = p; });
  const [subs] = await pool.query('SELECT student_id, package_id FROM subscriptions WHERE released = FALSE');
  const have = new Set(subs.map(x => x.student_id + ':' + (FAM_OF_PKG[x.package_id] || 'p' + x.package_id)));
  const ml = schoolMonthsLeft(new Date('2026-09-01T12:00:00'));
  const sy = schoolYearStr(defaultStartYear());
  const [rrows] = await pool.query('SELECT id, full_name, professor_name, full_price FROM roster_students WHERE school_year = ?', [sy]);
  const [rsum] = await pool.query('SELECT roster_id, SUM(amount) t FROM roster_payments GROUP BY roster_id');
  const cache = { rows: rrows, sums: {} }; rsum.forEach(x => { cache.sums[x.roster_id] = Number(x.t); });
  const [gm] = await pool.query('SELECT student_id, COUNT(*) n FROM group_members GROUP BY student_id');
  const inGroup = new Set(gm.map(x => x.student_id));
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const base = { child_id: r.child_id, child_name: r.child_name, roster_name: r.full_name, professor_name: r.professor_name, module: r.module, full_price: Number(r.full_price) };
    const skip = reason => out.push({ ...base, ready: false, reason });
    const mod = String(r.module || '').toLowerCase();
    if (SINGING_RE.test(mod)) { if (!have.has(r.child_id + ':singing')) skip('Пеење — чека договор за цена'); continue; }
    const fam = profFamily(r.professor_name);
    if (!fam) { skip('Непозната група професор — рачно'); continue; }
    if (have.has(r.child_id + ':' + fam)) continue;            // веќе запишано за овој инструмент
    const key = r.child_id + ':' + fam;
    if (seen.has(key)) { skip('Дупликат во листата (исто дете двапати)'); continue; }
    seen.add(key);
    let pkgId = BULK_PKG[fam];
    if (fam === 'izvorce') {
      if (/пијано|пиано|комбин|piano|kombin/.test(mod)) pkgId = BULK_PKG.izvorceCombo;
      else if (/изворче|izvorce/.test(mod) || !mod) pkgId = BULK_PKG.izvorce;
      else { skip('Нејасен модул „' + r.module + '“'); continue; }
    } else if (/електр|electric/.test(mod)) { pkgId = 15; if (!pkgs[15]) { const [[p15]] = await pool.query('SELECT * FROM packages WHERE id = 15'); if (p15) pkgs[15] = p15; } }
    const pkg = pkgs[pkgId];
    if (!pkg) { skip('Пакетот #' + pkgId + ' не постои'); continue; }
    const price = Number(r.full_price);
    let plan = null, schedule = null;
    for (const p of ['eight', 'full', 'two']) {
      const sc = buildAnnualSchedule(p, Number(pkg.price_mkd), ml);
      const total = sc.reduce((sum, it) => sum + Number(it.amount), 0);
      if (Math.abs(total - price) <= 1) { plan = p; schedule = sc; break; }
    }
    const item = { ...base, ready: true, package_id: pkgId, package_name: pkg.name };
    if (plan) { item.payment_plan = plan; item.installments = schedule.length; }
    else if (custom && price > 0) {
      const count = (fam === 'drums' && price === 4500) ? 1 : (BULK_COUNT.get(roster.nameKey(r.full_name)) || BULK_COUNT.get(roster.nameKey(r.child_name || '')) || 8);
      item.custom = true; item.custom_total = price; item.custom_count = count;
      item.payment_plan = count === 1 ? 'trial' : 'eight'; item.installments = count;
      const per = Math.floor(price / count);
      schedule = Array.from({ length: count }, (_, i) => ({ number: i + 1, amount: i === count - 1 ? price - per * (count - 1) : per }));
    } else { skip('Нестандардна цена ' + price + ' (' + pkg.name + ') — рачно'); continue; }
    const cov = await rosterCoverageFor(pool, r.child_name || r.full_name, schedule, r.professor_name, cache);
    item.paid_count = cov.found ? cov.paid_count : 0; item.in_group = inGroup.has(r.child_id);
    out.push(item);
  }
  return out;
}
async function bulkPendingRows() {
  const rows = await loadRoster('school_year = ?', [schoolYearStr(defaultStartYear())], currentYm());
  return rows.filter(r => r.has_profile && r.child_id);
}

// GET /finance/bulk-enroll-preview?custom=1
router.get('/bulk-enroll-preview', async (req, res) => {
  try {
    const items = await planBulk(await bulkPendingRows(), req.query.custom === '1');
    res.json({ ready: items.filter(i => i.ready).length, skipped: items.filter(i => !i.ready).length, items });
  } catch (err) { console.error('bulk-enroll-preview error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

// POST /finance/bulk-enroll  body: { child_ids: [..], custom: bool }  (запишува само „ready“ од прегледот)
router.post('/bulk-enroll', async (req, res) => {
  try {
    const ids = Array.isArray(req.body.child_ids) ? req.body.child_ids.map(Number) : [];
    if (!ids.length) return res.status(400).json({ error: 'Нема избрани деца.' });
    const items = (await planBulk(await bulkPendingRows(), req.body.custom === true)).filter(i => i.ready && ids.includes(Number(i.child_id)));
    const results = [];
    for (const it of items) {
      try {
        const r = await doManualEnrollment({ child_id: it.child_id, package_id: it.package_id, payment_plan: it.payment_plan,
          custom_total: it.custom ? it.custom_total : undefined, custom_count: it.custom ? it.custom_count : undefined,
          roster_professor: it.professor_name, start_date: '2026-09-01', use_roster: true, method: 'other', send_invoice: false }, req.user.id);
        results.push({ child_id: it.child_id, name: it.child_name, ok: true, paid_count: r.paid_count });
      } catch (e) { results.push({ child_id: it.child_id, name: it.child_name, ok: false, error: e.message }); }
    }
    res.json({ done: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
  } catch (err) { console.error('bulk-enroll error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

// GET /finance/name-mismatches — редови од листата без профил + најблиски профили по име
router.get('/name-mismatches', async (req, res) => {
  try {
    const rows = (await loadRoster('school_year = ?', [schoolYearStr(defaultStartYear())], currentYm())).filter(r => !r.has_profile);
    const [kids] = await pool.query(
      `SELECT c.id, c.full_name, u.email AS parent_email,
              EXISTS(SELECT 1 FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE) AS has_sub
       FROM children c JOIN users u ON u.id = c.parent_id`);
    const kidToks = kids.map(k => ({ k, t: roster.nameKey(k.full_name).split(' ').filter(Boolean).map(x => x.slice(0, 3)) }));
    const out = rows.map(r => {
      const rt = roster.nameKey(r.full_name).split(' ').filter(Boolean).map(x => x.slice(0, 3));
      const cands = kidToks.map(({ k, t }) => ({ k, score: t.filter(x => rt.includes(x)).length }))
        .filter(c => c.score >= 1).sort((a, b) => b.score - a.score).slice(0, 4)
        .map(c => ({ child_id: c.k.id, name: c.k.full_name, parent_email: c.k.parent_email, has_sub: !!c.k.has_sub, score: c.score }));
      return { roster_id: r.id, full_name: r.full_name, professor_name: r.professor_name, module: r.module, paid_total: r.paid_total, candidates: cands };
    });
    res.json({ count: out.length, rows: out });
  } catch (err) { console.error('name-mismatches error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

// POST /finance/fix-name  body: { mode: 'child'|'roster', child_id, roster_id }
//  child  → името на профилот станува исто како во листата
//  roster → името во листата станува исто како на профилот
router.post('/fix-name', async (req, res) => {
  try {
    const { mode, child_id, roster_id } = req.body;
    const [[st]] = await pool.query('SELECT * FROM roster_students WHERE id = ?', [roster_id]);
    const [[kid]] = await pool.query('SELECT id, full_name FROM children WHERE id = ?', [child_id]);
    if (!st || !kid) return res.status(404).json({ error: 'Не е пронајдено.' });
    if (mode === 'child') {
      await pool.query('UPDATE children SET full_name = ? WHERE id = ?', [st.full_name, kid.id]);
    } else if (mode === 'roster') {
      const key = roster.nameKey(kid.full_name);
      const [[dup]] = await pool.query('SELECT id FROM roster_students WHERE school_year = ? AND professor_name = ? AND name_key = ? AND id <> ?', [st.school_year, st.professor_name, key, st.id]);
      if (dup) return res.status(409).json({ error: 'Во листата веќе постои ученик со тоа име кај истиот професор.' });
      await pool.query('UPDATE roster_students SET full_name = ?, name_key = ? WHERE id = ?', [kid.full_name, key, st.id]);
    } else return res.status(400).json({ error: 'Невалиден режим.' });
    res.json({ ok: true });
  } catch (err) { console.error('fix-name error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

// POST /finance/installments/:id/mark-paid  body: { method, paid_date, note, send_invoice }
router.post('/installments/:id/mark-paid', async (req, res) => {
  try {
    const { method, paid_date, note } = req.body;
    const sendInvoice = req.body.send_invoice !== false;
    if (!MANUAL_METHODS.includes(method)) return res.status(400).json({ error: 'Избери начин на плаќање (кеш/банка/друго).' });
    const paidOn = isDate(paid_date) ? paid_date : todayStr();

    const [[inst]] = await pool.query(
      `SELECT i.*, c.id AS child_id, c.full_name, u.email, p.name AS package_name
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       JOIN users u ON u.id = c.parent_id
       JOIN packages p ON p.id = s.package_id
       WHERE i.id = ?`, [req.params.id]);
    if (!inst) return res.status(404).json({ error: 'Ратата не постои.' });
    if (inst.status === 'paid') return res.status(409).json({ error: 'Ратата е веќе платена.' });

    const [upd] = await pool.query(
      `UPDATE installments SET status = 'paid', paid_at = ?, paid_method = ?, paid_note = ?, marked_by = ?
       WHERE id = ? AND status <> 'paid'`,
      [paidOn + ' 12:00:00', method, note || null, req.user.id, inst.id]);
    if (!upd.affectedRows) return res.status(409).json({ error: 'Ратата е веќе платена.' });

    const [[nextPending]] = await pool.query(
      `SELECT due_date FROM installments WHERE subscription_id = ? AND status <> 'paid' ORDER BY due_date ASC LIMIT 1`, [inst.subscription_id]);
    await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?',
      [nextPending ? nextPending.due_date : addDays(todayStr(), 365), inst.subscription_id]);

    let invoice_number = null, emailed = false;
    if (sendInvoice) {
      const inv = await invoiceLib.issueInvoice({
        student_id: inst.child_id, student_name: inst.full_name, parent_email: inst.email,
        package_name: inst.total_installments > 1 ? `${inst.package_name} — рата ${inst.installment_number}/${inst.total_installments}` : inst.package_name,
        amount: inst.amount, payment_method: method, installment_id: inst.id, issued_at: paidOn + ' 12:00:00'
      });
      if (inv) {
        invoice_number = inv.invoice_number;
        emailed = await invoiceLib.emailInvoice(await invoiceLib.getInvoice(inv.id));
      }
    }
    res.json({ ok: true, invoice_number, emailed });
  } catch (err) {
    console.error('POST /finance/installments/:id/mark-paid error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});


// POST /finance/installments/:id/mark-unpaid  body: { reason }
// Поништува означена уплата (рачна или онлајн). Парите (ако се враќаат) се враќаат
// рачно од сметка на сметка — системот само ја ослободува ратата и ја сторнира фактурата.
// Фактурата не се брише: се обележува како СТОРНИРАНА (останува во архивата).
router.post('/installments/:id/mark-unpaid', async (req, res) => {
  try {
    const reason = String(req.body.reason || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ error: 'Внеси причина за поништувањето.' });

    const [[inst]] = await pool.query('SELECT * FROM installments WHERE id = ?', [req.params.id]);
    if (!inst) return res.status(404).json({ error: 'Ратата не постои.' });
    if (inst.status !== 'paid') return res.status(409).json({ error: 'Ратата не е означена како платена.' });

    await pool.query(
      `UPDATE installments SET status = 'pending', paid_at = NULL, paid_method = NULL, paid_note = ?, marked_by = ?
       WHERE id = ? AND status = 'paid'`,
      [`Поништено: ${reason}`, req.user.id, inst.id]);
    const [cancelled] = await pool.query(
      `UPDATE invoices SET cancelled_at = NOW(), cancel_reason = ? WHERE installment_id = ? AND cancelled_at IS NULL`,
      [reason, inst.id]);

    const [[nextPending]] = await pool.query(
      `SELECT due_date FROM installments WHERE subscription_id = ? AND status <> 'paid' ORDER BY due_date ASC LIMIT 1`, [inst.subscription_id]);
    await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?',
      [nextPending ? nextPending.due_date : addDays(todayStr(), 365), inst.subscription_id]);

    res.json({ ok: true, invoices_cancelled: cancelled.affectedRows });
  } catch (err) {
    console.error('POST /finance/installments/:id/mark-unpaid error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// GET /finance/invoices/print-all?from&to&q — сите фактури од филтерот во еден документ за печатење
router.get('/invoices/print-all', async (req, res) => {
  const { from, to, q } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (from) { where += ' AND i.issued_at >= ?'; params.push(from + ' 00:00:00'); }
  if (to) { where += ' AND i.issued_at <= ?'; params.push(to + ' 23:59:59'); }
  if (q) { where += ' AND (i.student_name LIKE ? OR i.parent_email LIKE ? OR i.invoice_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = await invoiceLib.queryInvoices(where + ' ORDER BY i.issued_at ASC, i.id ASC LIMIT 500', params);
  if (!rows.length) return res.status(404).json({ error: 'Нема фактури за печатење.' });
  res.json({ html: invoiceLib.renderInvoicesBatchHtml(rows), count: rows.length });
});

// GET /finance/invoices/:id/html — готова HTML фактура за печатење
router.get('/invoices/:id/html', async (req, res) => {
  const inv = await invoiceLib.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Фактурата не постои.' });
  res.json({ html: invoiceLib.renderInvoiceHtml(inv) });
});

// POST /finance/invoices/:id/resend — повторно испраќање на фактурата на родителот
router.post('/invoices/:id/resend', async (req, res) => {
  const inv = await invoiceLib.getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'Фактурата не постои.' });
  const ok = await invoiceLib.emailInvoice(inv);
  if (!ok) return res.status(502).json({ error: 'Мејлот не беше испратен. Провери ја email конфигурацијата.' });
  res.json({ ok: true });
});

// =====================================================================
// ЛИСТА НА ДЕЦА ПО ПРОФЕСОР (увоз од Excel/Sheets) + ПРЕГЛЕДИ
// =====================================================================
const currentYm = () => new Date().toISOString().slice(0, 7);
const monthEndStr = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const defaultStartYear = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1; };
const schoolYearStr = (y) => `${y}/${y + 1}`;
const ymList = (startYear) => {
  const out = [];
  for (let i = 0; i < 12; i++) { const m = ((8 + i) % 12) + 1; const y = m >= 9 ? startYear : startYear + 1; out.push(`${y}-${String(m).padStart(2, '0')}`); }
  return out; // сеп … авг
};

function rosterRowCalc(st, pays, ym) {
  const upTo = pays.filter(p => p.pay_month <= ym).reduce((a, p) => a + Number(p.amount), 0);
  const all = pays.reduce((a, p) => a + Number(p.amount), 0);
  const expected = roster.expectedThrough(st.full_price, ym);
  const owed = Math.max(0, expected - upTo);
  return {
    id: st.id, full_name: st.full_name, module: st.module, full_price: Number(st.full_price),
    half1: st.half1 === null ? null : Number(st.half1), half2: st.half2 === null ? null : Number(st.half2),
    discount: st.discount, professor_name: st.professor_name, professor_id: st.professor_id,
    payments: pays.map(p => ({ pay_month: p.pay_month, amount: Number(p.amount) })),
    paid_total: all, paid_to_month: upTo, expected, owed, status: owed > 0 ? 'unpaid' : 'paid'
  };
}

async function loadRoster(where, params, ym) {
  const [students] = await pool.query(`SELECT * FROM roster_students WHERE ${where} ORDER BY professor_name, full_name`, params);
  if (!students.length) return [];
  const [pays] = await pool.query('SELECT roster_id, pay_month, amount FROM roster_payments WHERE roster_id IN (?)', [students.map(x => x.id)]);
  const by = {};
  pays.forEach(p => { (by[p.roster_id] = by[p.roster_id] || []).push(p); });
  // дали детето веќе има профил на платформата (по име)
  const [kids] = await pool.query('SELECT c.id, c.full_name, EXISTS(SELECT 1 FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE) AS has_sub FROM children c');
  const kidKeys = {};
  kids.forEach(k => { kidKeys[roster.nameKey(k.full_name)] = k; });
  return students.map(st => {
    const row = rosterRowCalc(st, by[st.id] || [], ym);
    const k = kidKeys[roster.nameKey(st.full_name)];
    row.has_profile = !!k; row.has_subscription = !!(k && k.has_sub);
    row.child_id = k ? k.id : null; row.child_name = k ? k.full_name : null;
    return row;
  });
}
async function rosterForProfessor(profId, ym) {
  return loadRoster('school_year = ? AND professor_id = ?', [schoolYearStr(defaultStartYear()), profId], ym);
}

// GET /finance/roster-pending — деца од листата што веќе имаат профил, но сè уште немаат претплата (чекаат запишување)
router.get('/roster-pending', async (req, res) => {
  try {
    const rows = await loadRoster('school_year = ?', [schoolYearStr(defaultStartYear())], currentYm());
    const pending = rows.filter(r => r.has_profile && !r.has_subscription).map(r => ({
      roster_id: r.id, child_id: r.child_id, child_name: r.child_name, full_name: r.full_name,
      professor_name: r.professor_name, module: r.module, full_price: r.full_price, paid_total: r.paid_total
    }));
    res.json({ count: pending.length, rows: pending });
  } catch (err) { console.error('GET /finance/roster-pending error:', err); res.status(500).json({ error: 'Грешка.' }); }
});

// GET /finance/roster?professor_name=...&month=YYYY-MM  (за професори без поврзан профил)
router.get('/roster', async (req, res) => {
  try {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : currentYm();
    const name = (req.query.professor_name || '').trim();
    const rows = await loadRoster('school_year = ? AND professor_name = ? AND professor_id IS NULL', [schoolYearStr(defaultStartYear()), name], ym);
    res.json({ month: ym, roster: rows, counts: { total: rows.length } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Грешка.' }); }
});

// GET /finance/roster/professors — професори од листата што не се поврзани со профил
router.get('/roster/professors', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT professor_name, COUNT(*) AS cnt FROM roster_students WHERE school_year = ? AND professor_id IS NULL GROUP BY professor_name ORDER BY professor_name`,
      [schoolYearStr(defaultStartYear())]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Грешка.' }); }
});

// POST /finance/roster/:id/payment  { pay_month: 'YYYY-MM', amount }  (amount 0 = избриши)
router.post('/roster/:id/payment', async (req, res) => {
  try {
    const { pay_month, amount } = req.body;
    if (!/^\d{4}-\d{2}$/.test(pay_month || '')) return res.status(400).json({ error: 'Избери месец.' });
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return res.status(400).json({ error: 'Невалиден износ.' });
    const [[st]] = await pool.query('SELECT id FROM roster_students WHERE id = ?', [req.params.id]);
    if (!st) return res.status(404).json({ error: 'Ученикот не е пронајден.' });
    if (amt === 0) await pool.query('DELETE FROM roster_payments WHERE roster_id = ? AND pay_month = ?', [req.params.id, pay_month]);
    else await pool.query(
      'INSERT INTO roster_payments (roster_id, pay_month, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)',
      [req.params.id, pay_month, amt]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Грешка при запишување.' }); }
});

// DELETE /finance/roster/:id — отстрани запис од листата (пр. грешка при увоз)
router.delete('/roster/:id', async (req, res) => {
  try { await pool.query('DELETE FROM roster_students WHERE id = ?', [req.params.id]); res.json({ ok: true }); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Грешка.' }); }
});

// POST /finance/roster/import { text, dry_run, start_year }
router.post('/roster/import', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    // Заштита: листа за „нови уплати“ (ред: име TAB ГГГГ-ММ TAB износ) не смее да оди во целосниот увоз — би ги пребришала цените
    if (/\t20\d\d-\d\d\t/.test(req.body.text || '')) {
      conn.release();
      return res.status(400).json({ error: 'Ова се НОВИ УПЛАТИ (имаат колона со месец ГГГГ-ММ). Користи „➕ Додај нови уплати“, не „Увоз на листа“.' });
    }
    const startYear = Number(req.body.start_year) || defaultStartYear();
    const parsed = roster.parseRoster(req.body.text || '', startYear);
    if (!parsed.length) { conn.release(); return res.status(400).json({ error: 'Не пронајдов податоци. Залепи ја целата табела (со имињата на професорите и колоните).' }); }
    const dry = !!req.body.dry_run;
    const sy = schoolYearStr(startYear);

    const [profs] = await conn.query(`SELECT id, full_name FROM users WHERE role = 'professor'`);
    const pk = profs.map(p => ({ id: p.id, name: p.full_name, key: roster.nameKey(p.full_name), toks: new Set(roster.nameKey(p.full_name).split(' ')) }));
    const matchProf = (name) => {
      const k = roster.nameKey(name); const toks = k.split(' ');
      let c = pk.filter(p => p.key === k);
      if (c.length !== 1) c = pk.filter(p => toks.every(t => p.toks.has(t)) || [...p.toks].every(t => toks.includes(t)));
      if (c.length !== 1) { const last = pk.filter(p => toks.filter(t => p.toks.has(t)).length >= 2); if (last.length === 1) c = last; }
      return c.length === 1 ? c[0] : null;
    };
    const [kids] = await conn.query('SELECT full_name FROM children');
    const kidKeys = new Set(kids.map(k => roster.nameKey(k.full_name)));

    const summary = { school_year: sy, professors: [], students: 0, payments: 0, payments_sum: 0, matched_children: 0, dry_run: dry };
    if (!dry) await conn.beginTransaction();
    // постоечки редови: споредба по тековниот клуч на името (не по зачуваниот, кој можеби е од постара верзија)
    const existingMap = new Map();
    if (!dry) {
      const [exRows] = await conn.query('SELECT id, professor_name, full_name FROM roster_students WHERE school_year = ?', [sy]);
      exRows.forEach(r => existingMap.set(r.professor_name + '|' + roster.nameKey(r.full_name), r.id));
    }
    for (const p of parsed) {
      const m = matchProf(p.professor_name);
      summary.professors.push({ name: p.professor_name, students: p.students.length, matched_to: m ? m.name : null, note: p.note });
      for (const st of p.students) {
        summary.students++;
        if (kidKeys.has(roster.nameKey(st.full_name))) summary.matched_children++;
        const pays = Object.entries(st.payments);
        pays.forEach(([, v]) => { summary.payments++; summary.payments_sum += v; });
        if (dry) continue;
        const key = roster.nameKey(st.full_name);
        const exId = existingMap.get(p.professor_name + '|' + key);
        let id;
        if (exId) {
          id = exId;
          await conn.query(`UPDATE roster_students SET professor_id = ?, full_name = ?, name_key = ?, module = ?, full_price = ?, half1 = ?, half2 = ?, discount = ? WHERE id = ?`,
            [m ? m.id : null, st.full_name, key, st.module, st.full_price, st.half1, st.half2, st.discount, id]);
        } else {
          const [r] = await conn.query(
            `INSERT INTO roster_students (school_year, professor_id, professor_name, full_name, name_key, module, full_price, half1, half2, discount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sy, m ? m.id : null, p.professor_name, st.full_name, key, st.module, st.full_price, st.half1, st.half2, st.discount]);
          id = r.insertId;
          existingMap.set(p.professor_name + '|' + key, id);
        }
        for (const [ym, v] of pays) {
          await conn.query('INSERT INTO roster_payments (roster_id, pay_month, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)', [id, ym, v]);
        }
      }
    }
    if (!dry) await conn.commit();
    conn.release();
    res.json(summary);
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    conn.release();
    console.error('POST /finance/roster/import error:', err);
    res.status(500).json({ error: 'Грешка при увоз: ' + err.message });
  }
});

// POST /finance/roster/add-payments { text, dry_run }
// Безбедно додавање на НОВИ уплати (без да се преснимува цената). Формат на редовите (одделени со TAB):
//   ИМЕ ПРЕЗИМЕ <TAB> ГГГГ-ММ <TAB> износ [<TAB> цена за цела година (само за НОВ ученик)] [<TAB> модул]
// Редови со ИМЕ НА ПРОФЕСОР (само големи букви) ги означуваат групите.
router.post('/roster/add-payments', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const dry = !!req.body.dry_run;
    const sy = schoolYearStr(defaultStartYear());
    const toNum = (v) => { const n = Number(String(v || '').replace(/\s+/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && String(v || '').trim() !== '' ? n : null; };
    const lines = String(req.body.text || '').replace(/\r/g, '').split('\n').map(l => l.split('\t'));
    const [rows] = await conn.query('SELECT id, professor_id, professor_name, full_name FROM roster_students WHERE school_year = ?', [sy]);
    const profNames = [...new Set(rows.map(r => r.professor_name))];
    const tokensOf = (n) => new Set(roster.nameKey(n).split(' '));
    const bestProf = (header) => {
      if (!header) return null;
      const ht = tokensOf(header); let best = null, score = 0;
      for (const pn of profNames) { const sc = [...tokensOf(pn)].filter(t => ht.has(t)).length; if (sc > score) { score = sc; best = pn; } }
      return score >= 2 ? best : null;
    };
    const out = { dry_run: dry, school_year: sy, added: 0, updated: 0, created_students: 0, sum: 0, unmatched: [], changed: [], created: [] };
    let header = null, headerProf = null;
    if (!dry) await conn.beginTransaction();
    for (const c of lines) {
      const first = String(c[0] || '').trim();
      if (!first) continue;
      const rest = c.slice(1).map(x => String(x || '').trim());
      if (!rest.some(Boolean)) {
        if (first === first.toUpperCase() && first.length >= 5) { header = first.replace(/^ПРОФ\.?\s*/i, ''); headerProf = bestProf(header); }
        continue;
      }
      const ym = rest[0], amount = toNum(rest[1]), price = toNum(rest[2]), module = rest[3] || null;
      if (!/^\d{4}-\d{2}$/.test(ym) || amount === null || amount <= 0) { out.unmatched.push(first + ' — невалиден ред'); continue; }
      const key = roster.nameKey(first);
      let cand = rows.filter(r => roster.nameKey(r.full_name) === key);
      if (cand.length > 1 && headerProf) { const f = cand.filter(r => r.professor_name === headerProf); if (f.length) cand = f; }
      let st = cand[0];
      if (!st) {
        if (price === null || !headerProf) { out.unmatched.push(first + (price === null ? ' (нема во листата, нема цена)' : ' (непознат професор)')); continue; }
        const refRow = rows.find(r => r.professor_name === headerProf);
        if (!dry) {
          const [r] = await conn.query(
            `INSERT INTO roster_students (school_year, professor_id, professor_name, full_name, name_key, module, full_price, half1, half2, discount)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`, [sy, refRow ? refRow.professor_id : null, headerProf, first, key, module, price]);
          st = { id: r.insertId, professor_id: refRow ? refRow.professor_id : null, professor_name: headerProf, full_name: first };
          rows.push(st);
        } else st = { id: -1, professor_name: headerProf, full_name: first };
        out.created_students++; out.created.push(first + ' (' + headerProf + ', цена ' + price + ')');
      }
      if (st.id > 0) {
        const [[old]] = await conn.query('SELECT amount FROM roster_payments WHERE roster_id = ? AND pay_month = ?', [st.id, ym]);
        if (old) { if (Number(old.amount) !== amount) out.changed.push(`${first} ${ym}: ${Number(old.amount)} → ${amount}`); out.updated++; } else out.added++;
        if (!dry) await conn.query('INSERT INTO roster_payments (roster_id, pay_month, amount) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE amount = VALUES(amount)', [st.id, ym, amount]);
      } else out.added++;
      out.sum += amount;
    }
    if (!dry) await conn.commit();
    conn.release();
    res.json(out);
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    conn.release();
    console.error('POST /finance/roster/add-payments error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// GET /finance/unpaid-overview?month=YYYY-MM — кој не платил до избраниот месец
router.get('/unpaid-overview', async (req, res) => {
  try {
    const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : currentYm();
    const end = monthEndStr(ym);

    const [subsAll] = await pool.query(`SELECT COUNT(*) AS n FROM subscriptions WHERE released = FALSE`);
    const [plat] = await pool.query(
      `SELECT c.id AS child_id, c.full_name AS child_name, pr.full_name AS professor_name, pk.name AS package_name,
              SUM(i.amount) AS owed, COUNT(*) AS inst_count, MIN(i.due_date) AS oldest_due, u.email AS parent_email
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
       JOIN children c ON c.id = s.student_id
       JOIN users u ON u.id = c.parent_id
       JOIN packages pk ON pk.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id
       LEFT JOIN users pr ON pr.id = g.professor_id
       WHERE i.status = 'pending' AND i.due_date <= ?
       GROUP BY c.id, c.full_name, pr.full_name, pk.name, u.email
       ORDER BY oldest_due ASC`, [end]);
    const rosterRows = await loadRoster('school_year = ?', [schoolYearStr(defaultStartYear())], ym);

    const rows = plat.map(r => ({
      source: 'platform', child_name: r.child_name, professor_name: r.professor_name || '—', package_label: r.package_name,
      owed: Number(r.owed), detail: `${r.inst_count} неплатена рата · најстара од ${String(r.oldest_due).slice(0, 10)}`, contact: r.parent_email
    }));
    let rosterTotal = 0, rosterPaid = 0;
    rosterRows.forEach(r => {
      if (r.has_subscription) return; // веќе се брои преку платформата
      rosterTotal++;
      if (r.status === 'paid') { rosterPaid++; return; }
      rows.push({ source: 'roster', child_name: r.full_name, professor_name: r.professor_name, package_label: r.module || 'Од листата',
        owed: r.owed, detail: `платено ${r.paid_to_month.toLocaleString('en')} од очекувани ${r.expected.toLocaleString('en')}`, contact: '' });
    });
    rows.sort((a, b) => b.owed - a.owed);
    const total = Number(subsAll[0].n) + rosterTotal;
    const unpaidCount = rows.length;
    res.json({
      month: ym,
      totals: { students: total, unpaid: unpaidCount, paid_up: Math.max(0, total - unpaidCount), owed_total: rows.reduce((a, r) => a + r.owed, 0) },
      rows
    });
  } catch (err) {
    console.error('GET /finance/unpaid-overview error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на неплатените.' });
  }
});

// GET /finance/annual-forecast?year=2026 — колку пари влегуваат/ќе влезат во фирмата по месец
router.get('/annual-forecast', async (req, res) => {
  try {
    const startYear = Number(req.query.year) || defaultStartYear();
    const months = ymList(startYear);
    const first = months[0], last = months[11];
    const cur = currentYm();
    const clamp = (ym) => (ym < first ? first : ym > last ? last : ym);
    const data = {};
    months.forEach(m => { data[m] = { month: m, paid: 0, expected: 0 }; });

    const [paid] = await pool.query(
      `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS ym, SUM(amount) AS total FROM installments WHERE status = 'paid' AND paid_at IS NOT NULL AND (paid_note IS NULL OR paid_note <> 'Платено според школската листа') GROUP BY ym`);
    paid.forEach(r => { if (r.ym >= first && r.ym <= last) data[r.ym].paid += Number(r.total); });
    const [pend] = await pool.query(
      `SELECT DATE_FORMAT(i.due_date, '%Y-%m') AS ym, SUM(i.amount) AS total FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
       WHERE i.status = 'pending' GROUP BY ym`);
    pend.forEach(r => { const k = clamp(r.ym < cur ? cur : r.ym); if (data[k]) data[k].expected += Number(r.total); });

    // листа: добиени = уплати по месец; идни = преостанато / преостанати месеци
    const sy = schoolYearStr(startYear);
    const [rsAll] = await pool.query('SELECT id, full_price, full_name FROM roster_students WHERE school_year = ?', [sy]);
    const [subKids] = await pool.query('SELECT DISTINCT c.full_name FROM children c JOIN subscriptions s ON s.student_id = c.id AND s.released = FALSE');
    const subKeys = new Set(subKids.map(k => roster.nameKey(k.full_name)));
    const rs = rsAll;   // уплатите од листата се бројат за сите; очекуваното само за незапишаните (запишаните имаат свои рати)
    if (rs.length) {
      const [rp] = await pool.query('SELECT roster_id, pay_month, amount FROM roster_payments WHERE roster_id IN (?)', [rs.map(x => x.id)]);
      const by = {};
      rp.forEach(p => { (by[p.roster_id] = by[p.roster_id] || []).push(p); if (data[p.pay_month]) data[p.pay_month].paid += Number(p.amount); });
      const curIdx = Math.max(0, months.indexOf(clamp(cur)));
      rs.forEach(st => {
        if (subKeys.has(roster.nameKey(st.full_name))) return;   // има претплата — очекуваното е во нејзините рати
        const list = by[st.id] || [];
        const total = list.reduce((a, p) => a + Number(p.amount), 0);
        const remaining = Math.max(0, Number(st.full_price) - total);
        if (remaining <= 0) return;
        const hasCur = list.some(p => p.pay_month === months[curIdx]);
        const startIdx = Math.min(7, curIdx + (hasCur ? 1 : 0));
        const k = Math.max(1, 8 - startIdx);
        for (let i = startIdx; i < 8; i++) data[months[i]].expected += remaining / k;
      });
    }
    const rowsOut = months.map(m => ({ month: m, paid: Math.round(data[m].paid), expected: Math.round(data[m].expected) }));
    const collected = rowsOut.reduce((a, r) => a + r.paid, 0);
    const expected = rowsOut.reduce((a, r) => a + r.expected, 0);
    res.json({ school_year: sy, months: rowsOut, totals: { collected, expected, projected: collected + expected } });
  } catch (err) {
    console.error('GET /finance/annual-forecast error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на годишниот преглед.' });
  }
});

module.exports = router;
