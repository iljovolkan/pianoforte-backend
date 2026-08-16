const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();
const VALID_TIMES = ['14:30','15:15','16:00','16:45','17:30','18:15','19:00','19:45'];

// GET /individual-bookings/professors?instrument=piano
// Листа на професори за даден инструмент (за да ученикот избере кај кого да закаже)
router.get('/professors', requireAuth, async (req, res) => {
  const { instrument } = req.query;
  if (!instrument) return res.status(400).json({ error: 'instrument е задолжителен параметар.' });
  const [rows] = await pool.query(
    "SELECT id, full_name FROM users WHERE role = 'professor' AND instrument = ?",
    [instrument]
  );
  res.json(rows);
});

// GET /individual-bookings — сопствени (ученик) или на своите ученици (професор/admin)
router.get('/', requireAuth, async (req, res) => {
  let query, params;
  if (req.user.role === 'student') {
    query = `SELECT b.*, u.full_name AS professor_name FROM individual_bookings b
              JOIN users u ON u.id = b.professor_id
              WHERE b.student_id = ? ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [req.user.id];
  } else if (req.user.role === 'professor') {
    query = `SELECT b.*, u.full_name AS student_name FROM individual_bookings b
              JOIN users u ON u.id = b.student_id
              WHERE b.professor_id = ? ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [req.user.id];
  } else {
    query = `SELECT b.*, us.full_name AS student_name, up.full_name AS professor_name FROM individual_bookings b
              JOIN users us ON us.id = b.student_id
              JOIN users up ON up.id = b.professor_id
              ORDER BY b.booking_date ASC, b.start_time ASC`;
    params = [];
  }
  const [rows] = await pool.query(query, params);
  res.json(rows);
});

// POST /individual-bookings  { package_id, professor_id, instrument, booking_date, start_time, payment_method_id }
router.post('/', requireAuth, requireRole('student'), async (req, res) => {
  const { package_id, professor_id, instrument, booking_date, start_time, payment_method_id } = req.body;

  if (!package_id || !professor_id || !instrument || !booking_date || !start_time || !payment_method_id) {
    return res.status(400).json({ error: 'Сите полиња се задолжителни.' });
  }
  if (!VALID_TIMES.includes(start_time)) {
    return res.status(400).json({ error: 'Невалиден термин.' });
  }
  const dateObj = new Date(booking_date + 'T00:00:00');
  const day = dateObj.getDay();
  if (day === 0 || day === 6) {
    return res.status(400).json({ error: 'Не работиме за викенд — избери работен ден.' });
  }
  if (dateObj < new Date(new Date().toDateString())) {
    return res.status(400).json({ error: 'Не можеш да закажеш во минатото.' });
  }

  const [[pkg]] = await pool.query(
    "SELECT * FROM packages WHERE id = ? AND package_type = 'individual'", [package_id]
  );
  if (!pkg) return res.status(404).json({ error: 'Пакетот не постои.' });

  const [[prof]] = await pool.query(
    "SELECT id, full_name, email FROM users WHERE id = ? AND role = 'professor' AND instrument = ?",
    [professor_id, instrument]
  );
  if (!prof) return res.status(404).json({ error: 'Професорот не постои или не го предава овој инструмент.' });

  try {
    const fakeProviderRef = 'SIMULATED-' + Date.now();
    const [result] = await pool.query(
      `INSERT INTO individual_bookings (student_id, professor_id, instrument, booking_date, start_time, amount, payment_provider_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, professor_id, instrument, booking_date, start_time, pkg.price_mkd, fakeProviderRef]
    );

    await sendMail({
      to: req.user.email,
      subject: 'Потврда за индивидуален час — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Часот е закажан!</h2>
          <p>Инструмент: <strong>${instrument}</strong></p>
          <p>Професор: <strong>${prof.full_name}</strong></p>
          <p>Датум: <strong>${new Date(booking_date).toLocaleDateString('mk-MK')}</strong> во <strong>${start_time}</strong></p>
          <p>Износ: <strong>${pkg.price_mkd} ден.</strong></p>
        </div>
      `
    });
    await sendMail({
      to: prof.email,
      subject: 'Нов индивидуален час закажан — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Нов час е закажан кај тебе</h2>
          <p>Датум: <strong>${new Date(booking_date).toLocaleDateString('mk-MK')}</strong> во <strong>${start_time}</strong></p>
          <p>Инструмент: <strong>${instrument}</strong></p>
        </div>
      `
    });

    res.status(201).json({ id: result.insertId, ok: true, provider_ref: fakeProviderRef });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Овoj термин веќе е зафатен кај тoj професор.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
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
    return res.status(403).json({ error: 'Немаш пристап до овоj час.' });
  }

  await pool.query("UPDATE individual_bookings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
