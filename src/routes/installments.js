const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ВАЖНО: старата симулирана логика (POST /installments/:id/pay) е отстранета.
// Новиот тек: POST /payments/init-installment → cPay → /payments/cpay-ok
// (видете src/routes/payments.js).

// GET /installments — сите рати за ученик (свои) или за професор (неговите ученици)
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const base = (extra) => `SELECT i.*, s.payment_plan, s.group_id, p.name AS package_name, g.name AS group_name, c.full_name AS student_name${extra}
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       JOIN packages p ON p.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id
       WHERE c.parent_id = ?
       ORDER BY i.due_date ASC`;
    let rows;
    try {
      [rows] = await pool.query(base(`,
        (SELECT r.status FROM payment_reports r WHERE r.installment_id = i.id ORDER BY r.id DESC LIMIT 1) AS report_status,
        (SELECT r.reject_reason FROM payment_reports r WHERE r.installment_id = i.id ORDER BY r.id DESC LIMIT 1) AS report_reject_reason,
        (SELECT r.paid_date FROM payment_reports r WHERE r.installment_id = i.id ORDER BY r.id DESC LIMIT 1) AS report_paid_date`), [req.user.id]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;   // миграцијата 37 уште не е извршена — старо однесување
      [rows] = await pool.query(base(''), [req.user.id]);
    }
    return res.json(rows);
  }

  const whereClause = req.user.role === 'admin' ? '1=1' : 'g.professor_id = ?';
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  const [rows] = await pool.query(
    `SELECT i.*, s.payment_plan, c.full_name AS student_name, p.name AS package_name, g.name AS group_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN children c ON c.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     LEFT JOIN groups_table g ON g.id = s.group_id
     WHERE ${whereClause}
     ORDER BY i.due_date ASC`,
    params
  );
  res.json(rows);
});

// POST /installments/:id/report-paid  { method, paid_date, note } — родителот пријавува дека платил надвор од платформата.
// Ратата НЕ се менува додека Искра/админ не потврди (Школа → Уплати → Пријавени плаќања).
router.post('/:id/report-paid', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Само родител може да пријави уплата.' });
  try {
    const method = ['cash', 'bank', 'other'].includes(req.body.method) ? req.body.method : 'cash';
    const paidDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.paid_date || '')) ? req.body.paid_date : new Date().toISOString().slice(0, 10);
    if (paidDate > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Датумот на уплата не може да биде во иднина.' });
    const note = String(req.body.note || '').trim().slice(0, 255) || null;
    const [[inst]] = await pool.query(
      `SELECT i.id, i.status FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       WHERE i.id = ? AND c.parent_id = ?`, [req.params.id, req.user.id]);
    if (!inst) return res.status(404).json({ error: 'Ратата не е пронајдена.' });
    if (inst.status === 'paid') return res.status(409).json({ error: 'Ратата е веќе платена.' });
    const [[open]] = await pool.query("SELECT id FROM payment_reports WHERE installment_id = ? AND status = 'pending' LIMIT 1", [inst.id]);
    if (open) return res.status(409).json({ error: 'Веќе си ја пријавил оваа уплата — чека потврда.' });
    const [r] = await pool.query(
      'INSERT INTO payment_reports (installment_id, parent_id, method, paid_date, note) VALUES (?, ?, ?, ?, ?)',
      [inst.id, req.user.id, method, paidDate, note]);
    res.status(201).json({ ok: true, id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Функцијата уште не е активирана (недостасува миграција 37).' });
    console.error('POST /installments/:id/report-paid error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// DELETE /installments/:id/report-paid — родителот ја повлекува својата пријава (само ако уште чека)
router.delete('/:id/report-paid', requireAuth, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Недозволено.' });
  try {
    const [r] = await pool.query(
      "UPDATE payment_reports SET status = 'withdrawn', reviewed_at = NOW() WHERE installment_id = ? AND parent_id = ? AND status = 'pending'",
      [req.params.id, req.user.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Нема пријава што чека.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /installments/:id/report-paid error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

module.exports = router;
