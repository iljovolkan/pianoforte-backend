const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

// POST /auth/register  { email, password, full_name, role }
// role треба во пракса да е ограничено (пр. само admin/професор смее да создава professor акаунти).
router.post('/register', async (req, res) => {
  const { email, password, full_name, role } = req.body;

  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: 'Сите полиња се задолжителни.' });
  }
  if (!['admin', 'professor', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Невалидна улога.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Лозинката мора да има барем 8 карактери.' });
  }

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Веќе постои корисник со овој email.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
      [email, passwordHash, role, full_name]
    );

    res.status(201).json({ id: result.insertId, email, role, full_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email и лозинка се задолжителни.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];

    // Намерно иста порака за "непостоечки email" и "погрешна лозинка" —
    // да не откриваме дали email-от постои во системот.
    if (!user) {
      return res.status(401).json({ error: 'Погрешен email или лозинка.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Погрешен email или лозинка.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// GET /auth/me  — сопствен профил, потврдува дека токенот работи
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, email, role, full_name, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Корисникот не постои.' });
  res.json(rows[0]);
});

module.exports = router;
