const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ВАЖНО: старата симулирана логика (POST /individual-bookings) е отстранета.
// Новиот тек: POST /payments/init-individual-booking → cPay → /payments/cpay-ok
// (видете src/routes/payments.js). Оваа исто ja поправа старата грешка каде
// student_id погрешно се внесуваше како req.user.id (родител) наместо child_id.

// GET /individual-bookings/professors?instrument=piano
router.get('/professors', requireAuth, async (req, res) => {
  const { instrument } = req.query;
  if (!instrument) return res.status(400).json({ error: 'instrument е задолжителен параметар.' });
  const [rows] = await pool.query(
    `SELECT u.id, u.full_name FROM users u
     JOIN professor_instruments pi ON pi.professor_id = u.id
     WHERE u.role = 'professor' AND pi.instrument = ?`,
    [instrument]
  );
  res.json(rows);
});

// ===================================================================
// ДОСТАПНОСТ ЗА ИНДИВИДУАЛНА НАСТАВА — professor-от ги дефинира
// термините што ги нуди (на секои 15 мин, било кое време во работно
// време), ученикот бира само од понудените.
// ===================================================================
const TIME_15MIN_RE = /^([01]\d|2[0-3]):(00|15|30|45)$/;

// POST /individual-bookings/availability  { instrument, slot_date, start_time, location }
// Само professor додава сопствени термини, само за инструмент(и) на кои е доделен.
router.post('/availability', requireAuth, async (req, res) => {
  if (req.user.role !== 'professor') return res.status(403).json({ error: 'Само професор може да додава термини.' });
  const { instrument, slot_date, start_time, location } = req.body;
  if (!instrument || !slot_date || !start_time) {
    return res.status(400).json({ error: 'instrument, slot_date и start_time се задолжителни.' });
  }
  if (!TIME_15MIN_RE.test(start_time)) {
    return res.status(400).json({ error: 'Времето мора да е на секои 15 минути (пр. 15:00, 15:15, 15:30...).' });
  }
  if (location && !['aerodrom', 'taftalidze'].includes(location)) {
    return res.status(400).json({ error: 'Невалидна локација.' });
  }
  const [[allowed]] = await pool.query('SELECT 1 FROM professor_instruments WHERE professor_id = ? AND instrument = ?', [req.user.id, instrument]);
  if (!allowed) return res.status(403).json({ error: 'Не си доделен за тоj инструмент.' });

  const dateObj = new Date(slot_date + 'T00:00:00');
  const day = dateObj.getDay();
  if (day === 0 || day === 6) return res.status(400).json({ error: 'Не работиме за викенд.' });
  if (dateObj < new Date(new Date().toDateString())) return res.status(400).json({ error: 'Не можеш да понудиш термин во минатото.' });

  // Провери дали овoj термин преклопува со веќе РЕЗЕРВИРАН час на истиот
  // ден (секој час трае 45 мин) — за да не понудиш нешто што физички не
  // може да се одржи.
  const [bookedSlots] = await pool.query(
    'SELECT start_time FROM individual_availability WHERE professor_id = ? AND slot_date = ? AND is_booked = 1',
    [req.user.id, slot_date]
  );
  const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
  const newStart = toMinutes(start_time);
  const newEnd = newStart + 45;
  const overlapsBooked = bookedSlots.some(s => { const st = toMinutes(s.start_time); return st < newEnd && (st + 45) > newStart; });
  if (overlapsBooked) {
    return res.status(409).json({ error: 'Овoj термин преклопува со веќе резервиран час (секој час трае 45 мин).' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO individual_availability (professor_id, instrument, slot_date, start_time, location) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, instrument, slot_date, start_time, location || null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Веќе имаш понудено овoj термин.' });
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// GET /individual-bookings/availability?professor_id=X&instrument=Y
// За ученици — само НЕзафатени идни термини на конкретен professor.
router.get('/availability', requireAuth, async (req, res) => {
  const { professor_id, instrument } = req.query;
  if (!professor_id || !instrument) return res.status(400).json({ error: 'professor_id и instrument се задолжителни.' });
  const [rows] = await pool.query(
    `SELECT id, slot_date, start_time, location FROM individual_availability
     WHERE professor_id = ? AND instrument = ? AND is_booked = 0 AND slot_date >= CURDATE()
     ORDER BY slot_date ASC, start_time ASC`,
    [professor_id, instrument]
  );
  res.json(rows);
});

// GET /individual-bookings/my-instruments — сопствените доделени инструменти (за dropdown при додавање термин)
router.get('/my-instruments', requireAuth, async (req, res) => {
  if (req.user.role !== 'professor') return res.status(403).json({ error: 'Само за професори.' });
  const [rows] = await pool.query('SELECT instrument FROM professor_instruments WHERE professor_id = ?', [req.user.id]);
  res.json(rows.map(r => r.instrument));
});

// GET /individual-bookings/my-availability — сопствен преглед на professor-от (сите, вклучувajќи зафатени)
router.get('/my-availability', requireAuth, async (req, res) => {
  if (req.user.role !== 'professor') return res.status(403).json({ error: 'Само за професори.' });
  const [rows] = await pool.query(
    `SELECT * FROM individual_availability WHERE professor_id = ? AND slot_date >= CURDATE() ORDER BY slot_date ASC, start_time ASC`,
    [req.user.id]
  );
  res.json(rows);
});

// DELETE /individual-bookings/availability/:id — professor ja отстранува сопствената понуда (ако сè уште не е зафатена)
router.delete('/availability/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'professor') return res.status(403).json({ error: 'Само за професори.' });
  const [[slot]] = await pool.query('SELECT * FROM individual_availability WHERE id = ? AND professor_id = ?', [req.params.id, req.user.id]);
  if (!slot) return res.status(404).json({ error: 'Терминот не постои.' });
  if (slot.is_booked) return res.status(409).json({ error: 'Овoj термин веќе е резервиран — не може да се отстрани.' });
  await pool.query('DELETE FROM individual_availability WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// GET /individual-bookings — сопствени (ученик) или на своите ученици (професор/admin)
router.get('/', requireAuth, async (req, res) => {
  let query, params;
  if (req.user.role === 'student') {
    query = `SELECT b.*, u.full_name AS professor_name, c.full_name AS student_name FROM individual_bookings b
              JOIN users u ON u.id = b.professor_id
              JOIN children c ON c.id = b.student_id
              WHERE c.parent_id = ? ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [req.user.id];
  } else if (req.user.role === 'professor') {
    query = `SELECT b.*, c.full_name AS student_name FROM individual_bookings b
              JOIN children c ON c.id = b.student_id
              WHERE b.professor_id = ? ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [req.user.id];
  } else {
    query = `SELECT b.*, c.full_name AS student_name, up.full_name AS professor_name FROM individual_bookings b
              JOIN children c ON c.id = b.student_id
              JOIN users up ON up.id = b.professor_id
              ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [];
  }
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// DELETE /individual-bookings/:id — откажува закажан час (ученик/професор/admin)
router.delete('/:id', requireAuth, async (req, res) => {
  const [[booking]] = await pool.query('SELECT * FROM individual_bookings WHERE id = ?', [req.params.id]);
  if (!booking) return res.status(404).json({ error: 'Часот не постои.' });

  let isOwner = req.user.id === booking.professor_id;
  if (!isOwner && req.user.role === 'student') {
    const [[child]] = await pool.query('SELECT id FROM children WHERE id = ? AND parent_id = ?', [booking.student_id, req.user.id]);
    isOwner = !!child;
  }
  if (!isOwner && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Немаш пристап до овoj час.' });
  }

  await pool.query("UPDATE individual_bookings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
