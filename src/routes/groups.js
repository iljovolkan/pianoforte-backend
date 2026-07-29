const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /groups — листа на групи со членови и капацитет
router.get('/', requireAuth, async (req, res) => {
  const [groups] = await pool.query(
    'SELECT id, name, capacity, professor_id FROM groups_table'
  );

  for (const g of groups) {
    const [members] = await pool.query(
      `SELECT u.id, u.full_name FROM group_members gm
       JOIN users u ON u.id = gm.student_id
       WHERE gm.group_id = ?`,
      [g.id]
    );
    g.members = members;
    g.spots_left = g.capacity - members.length;
  }

  res.json(groups);
});

// POST /groups  { name, capacity }  — само професор/админ
router.post('/', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  const { name, capacity } = req.body;
  if (!name) return res.status(400).json({ error: 'Името на групата е задолжително.' });
  const cap = capacity || 6;
  if (cap < 1 || cap > 6) return res.status(400).json({ error: 'Капацитетот мора да биде помеѓу 1 и 6.' });

  const [result] = await pool.query(
    'INSERT INTO groups_table (name, capacity, professor_id) VALUES (?, ?, ?)',
    [name, cap, req.user.id]
  );
  res.status(201).json({ id: result.insertId, name, capacity: cap });
});

// POST /groups/:id/members  { student_id }  — додава дете во група, проверува капацитет
router.post('/:id/members', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  const groupId = req.params.id;
  const { student_id } = req.body;

  const [[group]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'Групата не постои.' });

  const [members] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [groupId]);
  if (members.length >= group.capacity) {
    return res.status(409).json({ error: 'Групата е веќе пополнета.' });
  }
  if (members.some(m => m.student_id === Number(student_id))) {
    return res.status(409).json({ error: 'Ученикот веќе е во оваа група.' });
  }

  await pool.query('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [groupId, student_id]);
  res.status(201).json({ ok: true });
});

// DELETE /groups/:id/members/:studentId
router.delete('/:id/members/:studentId', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  await pool.query('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [req.params.id, req.params.studentId]);
  res.json({ ok: true });
});

module.exports = router;
