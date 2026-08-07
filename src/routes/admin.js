const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runDailyMaintenance } = require('../cron');

const router = express.Router();
const SALT_ROUNDS = 12;
const VALID_INSTRUMENTS = ['piano', 'gitara', 'el-gitara', 'tapani', 'peenje', 'violina'];

function generateTempPassword(){
  // 12-карактерна случајна лозинка (hex), доволно силна за привремена употреба
  return crypto.randomBytes(6).toString('hex');
}

// POST /admin/professors  { email, full_name, instrument }  — само admin
// Создава professor сметка со генерирана привремена лозинка, "заклучена" на
// еден инструмент — тоj professor понатаму смее да создава групи само за
// тоj инструмент (проверено на серверска страна во groups.js).
router.post('/professors', requireAuth, requireRole('admin'), async (req, res) => {
  const { email, full_name, instrument } = req.body;
  if (!email || !full_name || !instrument) {
    return res.status(400).json({ error: 'Email, име и инструмент се задолжителни.' });
  }
  if (!VALID_INSTRUMENTS.includes(instrument)) {
    return res.status(400).json({ error: 'Невалиден инструмент.' });
  }

  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    return res.status(409).json({ error: 'Веќе постои корисник со овој email.' });
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const [result] = await pool.query(
    'INSERT INTO users (email, password_hash, role, full_name, email_verified, instrument) VALUES (?, ?, ?, ?, TRUE, ?)',
    [email, passwordHash, 'professor', full_name, instrument]
  );

  res.status(201).json({
    id: result.insertId,
    email,
    full_name,
    role: 'professor',
    instrument,
    temp_password: tempPassword // еднократно во одговорот, не се чува никаде во чист текст
  });
});

// GET /admin/professors — листа на сите професори (само admin)
router.get('/professors', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, email, full_name, instrument, created_at FROM users WHERE role = 'professor' ORDER BY created_at DESC"
  );
  res.json(rows);
});

// GET /admin/students — листа на сите ученици кои се регистрирале (само admin)
router.get('/students', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, email, full_name, email_verified, created_at FROM users WHERE role = 'student' ORDER BY created_at DESC"
  );
  res.json(rows);
});

// DELETE /admin/users/:id — бришe сметка (ученик/професор). Само admin.
router.delete('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Не можеш да ja избришеш сопствената сметка.' });
  }
  const [[user]] = await pool.query('SELECT id, role FROM users WHERE id = ?', [targetId]);
  if (!user) return res.status(404).json({ error: 'Корисникот не постои.' });

  await pool.query('DELETE FROM users WHERE id = ?', [targetId]);
  res.json({ ok: true });
});

// POST /admin/run-maintenance — рачно активирање на дневната задача
router.post('/run-maintenance', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await runDailyMaintenance();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка при извршување на задачата.' });
  }
});

module.exports = router;
