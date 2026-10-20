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
    WHERE status = 'paid' AND paid_at IS NOT NULL`;
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
     WHERE status='paid' AND DATE_FORMAT(paid_at, '%Y-%m') = ?`, [month]
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
    LEFT JOIN installments i ON i.subscription_id = s.id AND i.status = 'paid'`;
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

// GET /finance/unenrolled-children?q= — деца без активна претплата
router.get('/unenrolled-children', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [];
    let extra = '';
    if (q) { extra = ' AND (c.full_name LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const [rows] = await pool.query(
      `SELECT c.id, c.full_name, u.email AS parent_email, u.full_name AS parent_name,
              GROUP_CONCAT(DISTINCT g.name SEPARATOR ', ') AS groups_list
       FROM children c
       JOIN users u ON u.id = c.parent_id
       LEFT JOIN group_members gm ON gm.student_id = c.id
       LEFT JOIN groups_table g ON g.id = gm.group_id
       WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.student_id = c.id AND s.released = FALSE) ${extra}
       GROUP BY c.id ORDER BY c.full_name ASC LIMIT 200`, params
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /finance/unenrolled-children error:', err);
    res.status(500).json({ error: 'Грешка при вчитување на децата.' });
  }
});

// POST /finance/manual-enrollment
// body: { child_id, package_id, payment_plan: full|two|eight|trial, paid_count, method, paid_date, start_date, note, send_invoice }
router.post('/manual-enrollment', async (req, res) => {
  const { child_id, package_id, payment_plan, paid_count, method, paid_date, start_date, next_due_date, note, send_invoice } = req.body;
  if (!child_id || !package_id || !['full', 'two', 'eight', 'trial'].includes(payment_plan)) {
    return res.status(400).json({ error: 'Избери дете, пакет и начин на плаќање.' });
  }
  const paidN = Number(paid_count);
  if (!Number.isInteger(paidN) || paidN < 0) return res.status(400).json({ error: 'Невалиден број на платени рати.' });
  if (paidN > 0 && !MANUAL_METHODS.includes(method)) return res.status(400).json({ error: 'Избери начин на плаќање (кеш/банка/друго).' });
  const start = isDate(start_date) ? start_date : todayStr();
  const paidOn = isDate(paid_date) ? paid_date : start;

  const conn = await pool.getConnection();
  const toInvoice = [];
  try {
    const [[child]] = await conn.query(
      `SELECT c.id, c.full_name, u.email FROM children c JOIN users u ON u.id = c.parent_id WHERE c.id = ?`, [child_id]);
    const [[pkg]] = await conn.query('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!child) { conn.release(); return res.status(404).json({ error: 'Детето не постои.' }); }
    if (!pkg) { conn.release(); return res.status(404).json({ error: 'Пакетот не постои.' }); }

    const [[existing]] = await conn.query('SELECT id FROM subscriptions WHERE student_id = ? AND released = FALSE LIMIT 1', [child_id]);
    if (existing) { conn.release(); return res.status(409).json({ error: 'Ова дете веќе има активна претплата. Означи ги ратите во листата.' }); }

    const schedule = payment_plan === 'trial'
      ? [{ number: 1, total: 1, amount: Number(pkg.price_mkd), offsetDays: 0 }]
      : buildAnnualSchedule(payment_plan, Number(pkg.price_mkd), schoolMonthsLeft(new Date(start + 'T12:00:00')));
    if (paidN > schedule.length) { conn.release(); return res.status(400).json({ error: `Овој план има само ${schedule.length} рат(и).` }); }

    // групи на детето (ако е веќе вклучено во група)
    const [groups] = await conn.query('SELECT group_id FROM group_members WHERE student_id = ? ORDER BY group_id ASC LIMIT 2', [child_id]);
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
         paid ? paidOn + ' 12:00:00' : null, paid ? method : null, paid ? (note || null) : null, req.user.id]
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
    res.status(201).json({ ok: true, subscription_id: sub.insertId, invoices_sent: invoices, group_linked: !!groupId });
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    conn.release();
    console.error('POST /finance/manual-enrollment error:', err);
    res.status(500).json({ error: 'Грешка при запишување: ' + err.message });
  }
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
    return row;
  });
}
async function rosterForProfessor(profId, ym) {
  return loadRoster('school_year = ? AND professor_id = ?', [schoolYearStr(defaultStartYear()), profId], ym);
}

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
        const [[ex]] = await conn.query('SELECT id FROM roster_students WHERE school_year = ? AND professor_name = ? AND name_key = ?', [sy, p.professor_name, key]);
        let id;
        if (ex) {
          id = ex.id;
          await conn.query(`UPDATE roster_students SET professor_id = ?, full_name = ?, module = ?, full_price = ?, half1 = ?, half2 = ?, discount = ? WHERE id = ?`,
            [m ? m.id : null, st.full_name, st.module, st.full_price, st.half1, st.half2, st.discount, id]);
        } else {
          const [r] = await conn.query(
            `INSERT INTO roster_students (school_year, professor_id, professor_name, full_name, name_key, module, full_price, half1, half2, discount)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [sy, m ? m.id : null, p.professor_name, st.full_name, key, st.module, st.full_price, st.half1, st.half2, st.discount]);
          id = r.insertId;
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
      `SELECT DATE_FORMAT(paid_at, '%Y-%m') AS ym, SUM(amount) AS total FROM installments WHERE status = 'paid' AND paid_at IS NOT NULL GROUP BY ym`);
    paid.forEach(r => { if (r.ym >= first && r.ym <= last) data[r.ym].paid += Number(r.total); });
    const [pend] = await pool.query(
      `SELECT DATE_FORMAT(i.due_date, '%Y-%m') AS ym, SUM(i.amount) AS total FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id AND s.released = FALSE
       WHERE i.status = 'pending' GROUP BY ym`);
    pend.forEach(r => { const k = clamp(r.ym < cur ? cur : r.ym); if (data[k]) data[k].expected += Number(r.total); });

    // листа: добиени = уплати по месец; идни = преостанато / преостанати месеци
    const sy = schoolYearStr(startYear);
    const [rsAll] = await pool.query('SELECT id, full_price, name_key FROM roster_students WHERE school_year = ?', [sy]);
    const [subKids] = await pool.query('SELECT DISTINCT c.full_name FROM children c JOIN subscriptions s ON s.student_id = c.id AND s.released = FALSE');
    const subKeys = new Set(subKids.map(k => roster.nameKey(k.full_name)));
    const rs = rsAll.filter(r => !subKeys.has(r.name_key)); // веќе броени преку платформата
    if (rs.length) {
      const [rp] = await pool.query('SELECT roster_id, pay_month, amount FROM roster_payments WHERE roster_id IN (?)', [rs.map(x => x.id)]);
      const by = {};
      rp.forEach(p => { (by[p.roster_id] = by[p.roster_id] || []).push(p); if (data[p.pay_month]) data[p.pay_month].paid += Number(p.amount); });
      const curIdx = Math.max(0, months.indexOf(clamp(cur)));
      rs.forEach(st => {
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
