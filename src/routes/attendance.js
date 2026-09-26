const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

async function requireFinanceOrAdmin(req, res, next) {
  if (req.user.role === 'admin') return next();
  const [[u]] = await pool.query('SELECT finance_access FROM users WHERE id = ?', [req.user.id]);
  if (u && u.finance_access) return next();
  return res.status(403).json({ error: 'Немаш пристап до финансиски податоци.' });
}

// POST /attendance/log
// { group_id? , individual_booking_id?, lesson_date, was_held, notes?, attendance?: [{child_id, attended}] }
// Ако веќе постои евиденција за истиот час/датум, ja ажурира (upsert).
router.post('/log', requireAuth, requireRole('professor'), async (req, res) => {
  const { group_id, individual_booking_id, lesson_date, was_held, notes, attendance } = req.body;
  if (!lesson_date || (!group_id && !individual_booking_id)) {
    return res.status(400).json({ error: 'lesson_date и (group_id или individual_booking_id) се задолжителни.' });
  }
  try {
    if (group_id) {
      const [[g]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [group_id]);
      if (!g || g.professor_id !== req.user.id) return res.status(403).json({ error: 'Оваа група не е твoja.' });
    }
    if (individual_booking_id) {
      const [[b]] = await pool.query('SELECT * FROM individual_bookings WHERE id = ?', [individual_booking_id]);
      if (!b || b.professor_id !== req.user.id) return res.status(403).json({ error: 'Овoj час не е твoj.' });
    }

    const [[existing]] = await pool.query(
      group_id
        ? 'SELECT id FROM lesson_logs WHERE group_id = ? AND lesson_date = ?'
        : 'SELECT id FROM lesson_logs WHERE individual_booking_id = ? AND lesson_date = ?',
      [group_id || individual_booking_id, lesson_date]
    );

    let logId;
    if (existing) {
      logId = existing.id;
      await pool.query('UPDATE lesson_logs SET was_held = ?, notes = ? WHERE id = ?', [was_held ? 1 : 0, notes || null, logId]);
      await pool.query('DELETE FROM lesson_attendance WHERE lesson_log_id = ?', [logId]);
    } else {
      const [result] = await pool.query(
        `INSERT INTO lesson_logs (professor_id, group_id, individual_booking_id, lesson_date, was_held, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [req.user.id, group_id || null, individual_booking_id || null, lesson_date, was_held ? 1 : 0, notes || null]
      );
      logId = result.insertId;
    }

    if (group_id && Array.isArray(attendance)) {
      for (const a of attendance) {
        await pool.query('INSERT INTO lesson_attendance (lesson_log_id, child_id, attended) VALUES (?, ?, ?)', [logId, a.child_id, a.attended ? 1 : 0]);
      }
    }

    res.status(201).json({ id: logId });
  } catch (err) {
    console.error('POST /attendance/log error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// GET /attendance/my-logs?from=YYYY-MM-DD&to=YYYY-MM-DD — professor ги гледа сопствените евиденции
router.get('/my-logs', requireAuth, requireRole('professor'), async (req, res) => {
  const { from, to } = req.query;
  let query = `
    SELECT l.*, g.name AS group_name, ib.instrument AS indiv_instrument, c.full_name AS indiv_student_name
    FROM lesson_logs l
    LEFT JOIN groups_table g ON g.id = l.group_id
    LEFT JOIN individual_bookings ib ON ib.id = l.individual_booking_id
    LEFT JOIN children c ON c.id = ib.student_id
    WHERE l.professor_id = ?`;
  const params = [req.user.id];
  if (from) { query += ' AND l.lesson_date >= ?'; params.push(from); }
  if (to) { query += ' AND l.lesson_date <= ?'; params.push(to); }
  query += ' ORDER BY l.lesson_date DESC';
  const [rows] = await pool.query(query, params);

  for (const row of rows) {
    if (row.group_id) {
      const [att] = await pool.query(
        `SELECT la.child_id, la.attended, c.full_name AS child_name
         FROM lesson_attendance la JOIN children c ON c.id = la.child_id
         WHERE la.lesson_log_id = ?`, [row.id]
      );
      row.attendance = att;
    }
  }
  res.json(rows);
});

// GET /attendance/group/:groupId/roster?lesson_date=YYYY-MM-DD — ja враќа листата
// на деца во групата + постоечка евиденција (ако веќе е одбележана за тoj датум)
router.get('/group/:groupId/roster', requireAuth, requireRole('professor'), async (req, res) => {
  const [[g]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [req.params.groupId]);
  if (!g || g.professor_id !== req.user.id) return res.status(403).json({ error: 'Оваа група не е твoja.' });

  const [members] = await pool.query(
    `SELECT c.id, c.full_name FROM group_members gm JOIN children c ON c.id = gm.student_id WHERE gm.group_id = ?`,
    [req.params.groupId]
  );

  const { lesson_date } = req.query;
  let existing = null;
  if (lesson_date) {
    const [[log]] = await pool.query('SELECT * FROM lesson_logs WHERE group_id = ? AND lesson_date = ?', [req.params.groupId, lesson_date]);
    if (log) {
      const [att] = await pool.query('SELECT child_id, attended FROM lesson_attendance WHERE lesson_log_id = ?', [log.id]);
      existing = { was_held: !!log.was_held, notes: log.notes, attendance: att };
    }
  }
  res.json({ members, existing });
});

// GET /attendance/all?from=&to=&professor_id= — за финансискиот тим (admin + 3-те со finance_access)
router.get('/all', requireAuth, requireFinanceOrAdmin, async (req, res) => {
  const { from, to, professor_id } = req.query;
  let query = `
    SELECT l.*, u.full_name AS professor_name, g.name AS group_name, g.instrument AS group_instrument,
           ib.instrument AS indiv_instrument, c.full_name AS indiv_student_name
    FROM lesson_logs l
    JOIN users u ON u.id = l.professor_id
    LEFT JOIN groups_table g ON g.id = l.group_id
    LEFT JOIN individual_bookings ib ON ib.id = l.individual_booking_id
    LEFT JOIN children c ON c.id = ib.student_id
    WHERE 1=1`;
  const params = [];
  if (from) { query += ' AND l.lesson_date >= ?'; params.push(from); }
  if (to) { query += ' AND l.lesson_date <= ?'; params.push(to); }
  if (professor_id) { query += ' AND l.professor_id = ?'; params.push(professor_id); }
  query += ' ORDER BY l.lesson_date DESC';
  const [rows] = await pool.query(query, params);

  for (const row of rows) {
    if (row.group_id) {
      const [att] = await pool.query(
        `SELECT la.child_id, la.attended, c.full_name AS child_name
         FROM lesson_attendance la JOIN children c ON c.id = la.child_id
         WHERE la.lesson_log_id = ?`, [row.id]
      );
      row.attendance = att;
    }
  }
  res.json(rows);
});

module.exports = router;
