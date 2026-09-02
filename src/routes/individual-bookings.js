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
    "SELECT id, full_name FROM users WHERE role = 'professor' AND instrument = ?",
    [instrument]
  );
  res.json(rows);
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
