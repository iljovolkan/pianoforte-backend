const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const GRACE_DAYS = 5; // колку дена по рокот терминот сè уште стои пред да се ослободи

// GET /subscriptions
// Родител гледа претплати на СИТЕ свои деца. Професор/админ гледаат за сите
// ученици во СВОИТЕ групи (професорот) или за сите (админ).
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const [rows] = await pool.query(
      `SELECT s.*, p.name AS package_name, p.instrument, g.name AS group_name, g.professor_id, c.full_name AS student_name
       FROM subscriptions s
       JOIN packages p ON p.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id
       JOIN children c ON c.id = s.student_id
       WHERE c.parent_id = ?
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    return res.json(rows);
  }

  const whereClause = req.user.role === 'admin' ? '1=1' : 'g.professor_id = ?';
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  const [rows] = await pool.query(
    `SELECT s.*, c.full_name AS student_name, p.name AS package_name, g.name AS group_name
     FROM subscriptions s
     JOIN children c ON c.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     LEFT JOIN groups_table g ON g.id = s.group_id
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
  if (req.user.role === 'student') {
    const [[child]] = await pool.query('SELECT id FROM children WHERE id = ? AND parent_id = ?', [sub.student_id, req.user.id]);
    if (!child) return res.status(403).json({ error: 'Немаш пристап до туѓа претплата.' });
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

// POST /subscriptions/:id/choose-group  { group_id, secondary_group_id? }
// Го доделува терминот (групата) за веќе платена претплата којa немала
// избрано термин при купувањето. Само еднаш — ако веќе има група, се одбива.
// За комбо пакети (пр. Изворче), задолжителен е и secondary_group_id
// (солфеж група).
router.post('/:id/choose-group', requireAuth, requireRole('student'), async (req, res) => {
  const { group_id, secondary_group_id } = req.body;
  if (!group_id) return res.status(400).json({ error: 'group_id \u0435 \u0437\u0430\u0434\u043e\u043b\u0436\u0438\u0442\u0435\u043b\u0435\u043d.' });

  const [[sub]] = await pool.query('SELECT * FROM subscriptions WHERE id = ?', [req.params.id]);
  if (!sub) return res.status(404).json({ error: '\u041f\u0440\u0435\u0442\u043f\u043b\u0430\u0442\u0430\u0442\u0430 \u043d\u0435 \u043f\u043e\u0441\u0442\u043e\u0438.' });

  const [[child]] = await pool.query('SELECT id FROM children WHERE id = ? AND parent_id = ?', [sub.student_id, req.user.id]);
  if (!child) return res.status(403).json({ error: '\u041d\u0435\u043c\u0430\u0448 \u043f\u0440\u0438\u0441\u0442\u0430\u043f \u0434\u043e \u043e\u0432aa \u043f\u0440\u0435\u0442\u043f\u043b\u0430\u0442\u0430.' });

  if (sub.group_id) {
    return res.status(409).json({ error: '\u0412\u0435\u045c\u0435 \u0438\u043c\u0430\u0448 \u0438\u0437\u0431\u0440\u0430\u043d \u0442\u0435\u0440\u043c\u0438\u043d \u0437\u0430 \u043e\u0432oj \u043f\u0430\u043a\u0435\u0442.' });
  }
  if (sub.released) {
    return res.status(409).json({ error: '\u041e\u0432aa \u043f\u0440\u0435\u0442\u043f\u043b\u0430\u0442\u0430 \u0435 \u043e\u0441\u043b\u043e\u0431\u043e\u0434\u0435\u043d\u0430 \u2014 \u043f\u043e\u0442\u0440\u0435\u0431\u043d\u0430 \u0435 \u043d\u043e\u0432\u0430 \u0443\u043f\u043b\u0430\u0442\u0430.' });
  }

  const [[pkg]] = await pool.query('SELECT * FROM packages WHERE id = ?', [sub.package_id]);
  if (pkg.is_combo && !secondary_group_id) {
    return res.status(400).json({ error: '\u041e\u0432oj \u043f\u0430\u043a\u0435\u0442 \u0435 \u043a\u043e\u043c\u0431\u0438\u043d\u0438\u0440\u0430\u043d \u2014 \u0438\u0437\u0431\u0435\u0440\u0438 \u0438 \u0441\u043e\u043b\u0444\u0435\u0436 \u0433\u0440\u0443\u043f\u0430.' });
  }

  const [[group]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [group_id]);
  if (!group) return res.status(404).json({ error: '\u0413\u0440\u0443\u043f\u0430\u0442\u0430 \u043d\u0435 \u043f\u043e\u0441\u0442\u043e\u0438.' });
  if (group.instrument !== pkg.instrument) {
    return res.status(400).json({ error: '\u041f\u0430\u043a\u0435\u0442\u043e\u0442 \u0438 \u0433\u0440\u0443\u043f\u0430\u0442\u0430 \u0441\u0435 \u0437\u0430 \u0440\u0430\u0437\u043b\u0438\u0447\u043d\u0438 \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u0438.' });
  }

  const [members] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [group_id]);
  if (members.length >= group.capacity) {
    return res.status(409).json({ error: '\u0413\u0440\u0443\u043f\u0430\u0442\u0430 \u0435 \u0432\u0435\u045c\u0435 \u043f\u043e\u043f\u043e\u043b\u043d\u0435\u0442\u0430.' });
  }
  if (members.some(m => m.student_id === sub.student_id)) {
    return res.status(409).json({ error: '\u0414\u0435\u0442\u0435\u0442\u043e \u0435 \u0432\u0435\u045c\u0435 \u0432\u043e \u043e\u0432aa \u0433\u0440\u0443\u043f\u0430.' });
  }

  if (secondary_group_id) {
    const [[sg]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [secondary_group_id]);
    if (!sg) return res.status(404).json({ error: '\u0421\u043e\u043b\u0444\u0435\u0436 \u0433\u0440\u0443\u043f\u0430\u0442\u0430 \u043d\u0435 \u043f\u043e\u0441\u0442\u043e\u0438.' });
    if (sg.instrument !== 'solfez') return res.status(400).json({ error: '\u0412\u0442\u043e\u0440\u0430\u0442\u0430 \u0433\u0440\u0443\u043f\u0430 \u043c\u043e\u0440\u0430 \u0434\u0430 \u0435 \u043f\u043e \u0441\u043e\u043b\u0444\u0435\u0436.' });
    const [members2] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [secondary_group_id]);
    if (members2.length >= sg.capacity) return res.status(409).json({ error: '\u0421\u043e\u043b\u0444\u0435\u0436 \u0433\u0440\u0443\u043f\u0430\u0442\u0430 \u0435 \u0432\u0435\u045c\u0435 \u043f\u043e\u043f\u043e\u043b\u043d\u0435\u0442\u0430.' });
    if (members2.some(m => m.student_id === sub.student_id)) return res.status(409).json({ error: '\u0414\u0435\u0442\u0435\u0442\u043e \u0435 \u0432\u0435\u045c\u0435 \u0432\u043e taa \u0441\u043e\u043b\u0444\u0435\u0436 \u0433\u0440\u0443\u043f\u0430.' });
  }

  await pool.query('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [group_id, sub.student_id]);
  if (secondary_group_id) {
    await pool.query('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [secondary_group_id, sub.student_id]);
  }
  await pool.query('UPDATE subscriptions SET group_id = ?, secondary_group_id = ? WHERE id = ?', [group_id, secondary_group_id || null, req.params.id]);
  await pool.query(
    `UPDATE purchases SET group_id = ? WHERE student_id = ? AND package_id = ? AND group_id IS NULL
     ORDER BY purchased_at DESC LIMIT 1`,
    [group_id, sub.student_id, sub.package_id]
  );

  res.json({ ok: true, group_name: group.name });
});

module.exports = router;
