const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const invoiceLib = require('../invoice');
const payments = require('./payments');

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

  const income = Number(incomeRow.total);
  const salaries = Number(salaryRow.total);
  const trosoci = Number(expenseRow.trosoci);
  const marketing = Number(expenseRow.marketing);
  const remainder = income - salaries - trosoci - marketing;

  res.json({ month, income, salaries, trosoci, marketing, total_expenses: trosoci + marketing, remainder });
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
// professor (преку групи И индивидуални часови), со статус на плаќање
router.get('/professor-students/:professorId', async (req, res) => {
  const profId = req.params.professorId;

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

  const today = new Date().toISOString().slice(0, 10);
  const groupRows = groupStudents.map(r => ({
    ...r,
    payment_status: !r.subscription_id ? 'нема претплата' : (r.next_due_date && r.next_due_date <= today ? 'доспеано' : 'платено')
  }));

  res.json({ group_students: groupRows, individual_students: indivStudents });
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

// GET /finance/payment-board?q= — активни претплати со сите рати
router.get('/payment-board', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const params = [];
    let where = 's.released = FALSE';
    if (q) { where += ' AND (c.full_name LIKE ? OR u.email LIKE ? OR u.full_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const [subs] = await pool.query(
      `SELECT s.id AS subscription_id, s.payment_plan, p.name AS package_name,
              c.id AS child_id, c.full_name AS child_name, u.email AS parent_email, u.full_name AS parent_name
       FROM subscriptions s
       JOIN children c ON c.id = s.student_id
       JOIN users u ON u.id = c.parent_id
       JOIN packages p ON p.id = s.package_id
       WHERE ${where} ORDER BY c.full_name ASC LIMIT 300`, params
    );
    if (!subs.length) return res.json([]);
    const [inst] = await pool.query(
      `SELECT id, subscription_id, installment_number, total_installments, amount, due_date, status, paid_at, paid_method, paid_note
       FROM installments WHERE subscription_id IN (?) ORDER BY subscription_id, installment_number`,
      [subs.map(x => x.subscription_id)]
    );
    const bySub = {};
    inst.forEach(i => { (bySub[i.subscription_id] = bySub[i.subscription_id] || []).push(i); });
    res.json(subs.map(x => ({ ...x, installments: bySub[x.subscription_id] || [] })));
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
      : payments.buildAnnualSchedule(payment_plan, Number(pkg.price_mkd));
    if (paidN > schedule.length) { conn.release(); return res.status(400).json({ error: `Овој план има само ${schedule.length} рат(и).` }); }

    // групи на детето (ако е веќе вклучено во група)
    const [groups] = await conn.query('SELECT group_id FROM group_members WHERE student_id = ? ORDER BY id ASC LIMIT 2', [child_id]);
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

module.exports = router;
