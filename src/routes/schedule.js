const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const VALID_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri']; // саботите/неделите се секогаш неработни
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // формат "HH:MM"

// GET /schedule — целиот неделен распоред со група + членови по термин
router.get('/', requireAuth, async (req, res) => {
  const [slots] = await pool.query(
    `SELECT s.id, s.day_of_week, s.start_time, s.note, g.id AS group_id, g.name AS group_name,
            g.capacity, g.instrument, g.age_range, g.level
     FROM schedule_slots s
     JOIN groups_table g ON g.id = s.group_id`
  );

  for (const slot of slots) {
    const [members] = await pool.query(
      `SELECT u.id, u.full_name FROM group_members gm
       JOIN users u ON u.id = gm.student_id
       WHERE gm.group_id = ?`,
      [slot.group_id]
    );
    slot.members = members;
  }

  res.json(slots);
});

// POST /schedule  { group_id, day_of_week, start_time, note }  — доделува термин на група
// Секоја група обично добива ДВА термини неделно (пр. вто+чет), со по два повика.
router.post('/', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  const { group_id, day_of_week, start_time, note } = req.body;

  if (!group_id || !VALID_DAYS.includes(day_of_week) || !TIME_RE.test(start_time || '')) {
    return res.status(400).json({ error: 'Невалидни податоци за термин (ден или време HH:MM).' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO schedule_slots (group_id, day_of_week, start_time, note) VALUES (?, ?, ?, ?)',
      [group_id, day_of_week, start_time, note || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Веќе постои термин во ова време.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// PUT /schedule/:id  { note }  — ажурира белешка од часот
router.put('/:id', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  const { note } = req.body;
  await pool.query('UPDATE schedule_slots SET note = ? WHERE id = ?', [note || null, req.params.id]);
  res.json({ ok: true });
});

// DELETE /schedule/:id — го ослободува терминот
router.delete('/:id', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  await pool.query('DELETE FROM schedule_slots WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
