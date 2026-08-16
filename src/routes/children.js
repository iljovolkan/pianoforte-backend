const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /children — сите деца на најавениот родител
router.get('/', requireAuth, requireRole('student'), async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, full_name, age, created_at FROM children WHERE parent_id = ? ORDER BY created_at ASC',
    [req.user.id]
  );
  res.json(rows);
});

// POST /children  { full_name, age }
router.post('/', requireAuth, requireRole('student'), async (req, res) => {
  const { full_name, age } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Името е задолжително.' });
  }
  const [result] = await pool.query(
    'INSERT INTO children (parent_id, full_name, age) VALUES (?, ?, ?)',
    [req.user.id, full_name.trim(), age || null]
  );
  res.status(201).json({ id: result.insertId, full_name: full_name.trim(), age: age || null });
});

// PUT /children/:id  { full_name, age }
router.put('/:id', requireAuth, requireRole('student'), async (req, res) => {
  const { full_name, age } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Името е задолжително.' });
  }
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }
  await pool.query('UPDATE children SET full_name = ?, age = ? WHERE id = ?', [full_name.trim(), age || null, req.params.id]);
  res.json({ ok: true });
});

// DELETE /children/:id — брише дете и сите негови поврзани записи (материјали,
// членства во групи, претплати...) преку истиот id механизам
router.delete('/:id', requireAuth, requireRole('student'), async (req, res) => {
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }
  const [[countRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM children WHERE parent_id = ?', [req.user.id]);
  if (countRow.cnt <= 1) {
    return res.status(400).json({ error: 'Мора да имаш барем едно дете на профилот.' });
  }

  await pool.query('DELETE FROM group_members WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM materials WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM installments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE student_id = ?)', [req.params.id]);
  await pool.query('DELETE FROM subscriptions WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM purchases WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM individual_bookings WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM children WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
