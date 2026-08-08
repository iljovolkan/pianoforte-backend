const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const GRACE_DAYS = 5; // колку дена по рокот терминот сè уште стои пред да се ослободи

// GET /subscriptions
// Ученик гледа само своја претплата. Професор/админ гледаат за сите ученици
// во СВОИТЕ групи (професорот) или за сите (админ).
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const [rows] = await pool.query(
      `SELECT s.*, p.name AS package_name, p.instrument, g.name AS group_name, g.professor_id
       FROM subscriptions s
       JOIN packages p ON p.id = s.package_id
       JOIN groups_table g ON g.id = s.group_id
       WHERE s.student_id = ?
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  }

  const whereClause = req.user.role === 'admin' ? '1=1' : 'g.professor_id = ?';
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  const [rows] = await pool.query(
    `SELECT s.*, u.full_name AS student_name, p.name AS package_name, g.name AS group_name
     FROM subscriptions s
     JOIN users u ON u.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     JOIN groups_table g ON g.id = s.group_id
     WHERE ${whereClause}
     ORDER BY s.next_due_date ASC`,
    params
  );
  res.json(rows);
});

// Помошна функција — статус на плаќање врз основа на датумот
function paymentState(sub) {
  if (sub.released) return 'released';
  const today = new Date();
  const due = new Date(sub.next_due_date);
  const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'late';
  if (diffDays <= 5) return 'due_soon';
  return 'paid';
}

// POST /subscriptions/:id/renew  — рачно продолжување рок (по нова уплата)
router.post('/:id/renew', requireAuth, async (req, res) => {
  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: 'Претплатата не постои.' });
  if (req.user.role === 'student' && req.user.id !== sub.student_id) {
    return res.status(403).json({ error: 'Немаш пристап до туѓа претплата.' });
  }

  const newDue = new Date();
  newDue.setDate(newDue.getDate() + 30);
  await pool.query(
    'UPDATE subscriptions SET next_due_date = ?, released = FALSE WHERE id = ?',
    [newDue.toISOString().slice(0, 10), req.params.id]
  );
  res.json({ ok: true, next_due_date: newDue.toISOString().slice(0, 10) });
});

// Автоматско ослободување задоцнети термини (повикано периодично — засега рачно/по барање)
router.post('/check-overdue', requireAuth, async (req, res) => {
  const [subs] = await pool.query('SELECT * FROM subscriptions WHERE released = FALSE');
  let releasedCount = 0;
  for (const sub of subs) {
    const state = paymentState(sub);
    const today = new Date();
    const due = new Date(sub.next_due_date);
    const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
    if (diffDays < -GRACE_DAYS) {
      await pool.query('UPDATE subscriptions SET released = TRUE WHERE id = ?', [sub.id]);
      await pool.query('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [sub.group_id, sub.student_id]);
      releasedCount++;
    }
  }
  res.json({ ok: true, released: releasedCount });
});

module.exports = router;
