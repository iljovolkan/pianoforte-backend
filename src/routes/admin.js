const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

function generateTempPassword(){
  // 12-карактерна случајна лозинка (hex), доволно силна за привремена употреба
  return crypto.randomBytes(6).toString('hex');
}

// POST /admin/professors  { email, full_name }  — само admin
// Создава professor сметка со генерирана привремена лозинка.
// Лозинката се враќа САМО во овој одговор (еднаш) — админот ја споделува рачно
// со професорот (телефон/порака), додека не се додаде реален email сервис.
router.post('/professors', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, full_name } = req.body;
  if (!email || !full_name) {
    return res.status(400).json({ error: 'Email и име се задолжителни.' });
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    return res.status(409).json({ error: 'Веќе постои корисник со овој email.' });
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const [result] = await pool.query(
    'INSERT INTO users (email, password_hash, role, full_name) VALUES (?, ?, ?, ?)',
    [email, passwordHash, 'professor', full_name]
  );

  res.status(201).json({
    id: result.insertId,
    email,
    full_name,
    role: 'professor',
    temp_password: tempPassword // еднократно во одговорот, не се чува никаде во чист текст
  });
});

// GET /admin/professors — листа на сите професори (само admin)
router.get('/professors', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, email, full_name, created_at FROM users WHERE role = 'professor' ORDER BY created_at DESC"
  );
  res.json(rows);
});

module.exports = router;
