const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

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
  const { professor_id, month, amount, notes } = req.body;
  if (!professor_id || !month || amount === undefined) {
    return res.status(400).json({ error: 'professor_id, month и amount се задолжителни.' });
  }
  const monthDate = month.length === 7 ? month + '-01' : month;
  await pool.query(
    `INSERT INTO staff_salaries (professor_id, month, amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE amount = VALUES(amount), notes = VALUES(notes)`,
    [professor_id, monthDate, amount, notes || null, req.user.id]
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
    `SELECT COALESCE(SUM(amount),0) AS total FROM staff_salaries WHERE DATE_FORMAT(month, '%Y-%m') = ?`, [month]
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

module.exports = router;
