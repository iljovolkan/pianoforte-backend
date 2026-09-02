const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// GET /groups — листа на групи со членови, капацитет, инструмент, возраст, ниво, professor
router.get('/', requireAuth, async (req, res) => {
  try {
    const [groups] = await pool.query(
      `SELECT g.id, g.name, g.capacity, g.professor_id, g.instrument, g.age_range, g.level, u.full_name AS professor_name
       FROM groups_table g JOIN users u ON u.id = g.professor_id`
    );

    for (const g of groups) {
      const [members] = await pool.query(
        `SELECT c.id, c.full_name, c.age, u.full_name AS parent_name
         FROM group_members gm
         JOIN children c ON c.id = gm.student_id
         JOIN users u ON u.id = c.parent_id
         WHERE gm.group_id = ?`,
        [g.id]
      );
      g.members = members;
      g.spots_left = g.capacity - members.length;
    }

    res.json(groups);
  } catch (err) {
    console.error('GET /groups error:', err);
    res.status(500).json({ error: 'Грешка при вчитување групи: ' + err.message });
  }
});

// POST /groups  { name, capacity, age_range, level }  — само професор/админ
// Инструментот НЕ доаѓа од телото на барањето — секогаш се презема од
// сопствениот профил на professor-от (кого admin-от го "заклучил" на еден
// инструмент при создавање на сметката). Ова спречува professor по пијано
// случајно (или намерно) да создаде група за гитара.
router.post('/', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const { name, capacity, age_range, level } = req.body;
    if (!name) return res.status(400).json({ error: 'Името на групата е задолжително.' });
    const cap = capacity || 6;
    if (cap < 1 || cap > 6) return res.status(400).json({ error: 'Капацитетот мора да биде помеѓу 1 и 6.' });
    if (level && !['pocetnik', 'napreden'].includes(level)) {
      return res.status(400).json({ error: 'Невалидно ниво.' });
    }

    const [[me]] = await pool.query('SELECT instrument FROM users WHERE id = ?', [req.user.id]);
    const instrument = me && me.instrument ? me.instrument : req.body.instrument;
    if (!instrument) {
      return res.status(400).json({ error: 'Твojot профил нема доделен инструмент — контактирај admin.' });
    }

    const [result] = await pool.query(
      'INSERT INTO groups_table (name, capacity, professor_id, instrument, age_range, level) VALUES (?, ?, ?, ?, ?, ?)',
      [name, cap, req.user.id, instrument, age_range || '7-10', level || 'pocetnik']
    );
    res.status(201).json({ id: result.insertId, name, capacity: cap, instrument, age_range, level });
  } catch (err) {
    console.error('POST /groups error:', err);
    res.status(500).json({ error: 'Грешка при создавање група: ' + err.message });
  }
});

// POST /groups/:id/members  { student_id }  — рачно додава дете во група (без купување),
// проверува капацитет и дека детето постои. Professor може да додава само во сопствени групи.
router.post('/:id/members', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const groupId = req.params.id;
    const { student_id } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id е задолжителен.' });

    const [[group]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [groupId]);
    if (!group) return res.status(404).json({ error: 'Групата не постои.' });
    if (req.user.role === 'professor' && group.professor_id !== req.user.id) {
      return res.status(403).json({ error: 'Можеш да додаваш ученици само во сопствените групи.' });
    }

    const [[child]] = await pool.query('SELECT id, full_name FROM children WHERE id = ?', [student_id]);
    if (!child) return res.status(404).json({ error: 'Ученикот не постои.' });

    const [members] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [groupId]);
    if (members.length >= group.capacity) {
      return res.status(409).json({ error: 'Групата е веќе пополнета.' });
    }
    if (members.some(m => m.student_id === Number(student_id))) {
      return res.status(409).json({ error: 'Ученикот веќе е во оваа група.' });
    }

    await pool.query('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [groupId, student_id]);
    res.status(201).json({ ok: true, student_name: child.full_name });
  } catch (err) {
    console.error('POST /groups/:id/members error:', err);
    res.status(500).json({ error: 'Грешка при додавање ученик: ' + err.message });
  }
});

// DELETE /groups/:id/members/:studentId
router.delete('/:id/members/:studentId', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [req.params.id, req.params.studentId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /groups/:id/members error:', err);
    res.status(500).json({ error: 'Грешка при отстранување ученик: ' + err.message });
  }
});

// GET /groups/search-students?q=име — пребарува деца по име (за рачно додавање во група).
// Достапно и за professor и за admin — professor мора да може да најде ученик за да го додаде.
router.get('/search-students', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const [rows] = await pool.query(
      `SELECT c.id, c.full_name, c.age, u.email AS parent_email
       FROM children c JOIN users u ON u.id = c.parent_id
       WHERE c.full_name LIKE ? LIMIT 15`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /groups/search-students error:', err);
    res.status(500).json({ error: 'Грешка при пребарување: ' + err.message });
  }
});

// DELETE /groups/:id — бришe цела група (за грешки при креирање). Members се
// бришат автоматски (ON DELETE CASCADE). Professor може да брише само сопствени групи.
router.delete('/:id', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const [[group]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [req.params.id]);
    if (!group) return res.status(404).json({ error: 'Групата не постои.' });
    if (req.user.role === 'professor' && group.professor_id !== req.user.id) {
      return res.status(403).json({ error: 'Можеш да бришеш само сопствени групи.' });
    }
    await pool.query('DELETE FROM groups_table WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /groups/:id error:', err);
    res.status(500).json({ error: 'Грешка при бришење група: ' + err.message });
  }
});

module.exports = router;
