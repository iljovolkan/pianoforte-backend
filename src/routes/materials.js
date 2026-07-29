const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Дозволени премини на статус (спречува "скокање" од queued директно во done итн.)
const ALLOWED_TRANSITIONS = {
  queued: ['delivered'],
  delivered: ['opened'],
  opened: ['done']
};

// POST /materials  { student_id, title, type, note }  — професор испраќа материјал
router.post('/', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  const { student_id, title, type, note } = req.body;
  if (!student_id || !title || !['note', 'audio', 'task'].includes(type)) {
    return res.status(400).json({ error: 'Невалидни податоци за материјал.' });
  }

  const [result] = await pool.query(
    `INSERT INTO materials (student_id, sent_by, title, type, note, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`,
    [student_id, req.user.id, title, type, note || null]
  );
  res.status(201).json({ id: result.insertId, status: 'queued' });
});

// GET /materials/:studentId — целиот дигитален индекс на ученикот
// Ученик смее да го гледа само својот; професор/админ гледаат секаде.
router.get('/:studentId', requireAuth, async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (req.user.role === 'student' && req.user.id !== studentId) {
    return res.status(403).json({ error: 'Немаш пристап до туѓ индекс.' });
  }

  const [rows] = await pool.query(
    'SELECT * FROM materials WHERE student_id = ? ORDER BY sent_at DESC',
    [studentId]
  );
  res.json(rows);
});

// PUT /materials/:id/status  { status }
// "queued -> delivered" се повикува кога ученикот "влегува во училница" (bulk на клиент, по потреба).
router.put('/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  const [[material]] = await pool.query('SELECT * FROM materials WHERE id = ?', [req.params.id]);
  if (!material) return res.status(404).json({ error: 'Материјалот не постои.' });

  if (req.user.role === 'student' && req.user.id !== material.student_id) {
    return res.status(403).json({ error: 'Немаш пристап до овој материјал.' });
  }

  const allowedNext = ALLOWED_TRANSITIONS[material.status] || [];
  if (!allowedNext.includes(status)) {
    return res.status(400).json({ error: `Не може да се премине од "${material.status}" во "${status}".` });
  }

  await pool.query('UPDATE materials SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ ok: true, status });
});

module.exports = router;
