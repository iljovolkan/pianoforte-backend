const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();
const SALT_ROUNDS = 12;
const APP_URL = process.env.APP_BASE_URL || 'https://app.pianoforte.edu.mk';

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
    const verifyToken = crypto.randomBytes(32).toString('hex');

    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, role, full_name, verify_token, email_verified) VALUES (?, ?, ?, ?, ?, FALSE)',
      [email, passwordHash, role, full_name, verifyToken]
    );

    const verifyLink = `${APP_URL}/auth/verify?token=${verifyToken}`;
    await sendMail({
      to: email,
      subject: 'Потврди го твojот профил на PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Здраво, ${full_name}!</h2>
          <p>Само уште еден чекор — кликни на копчето подолу за да го потврдиш твojот профил на PianoForte.</p>
          <p style="margin:24px 0;">
            <a href="${verifyLink}" style="background:#A97E33; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600;">Потврди го профилот</a>
          </p>
          <p style="color:#888; font-size:13px;">Ако копчето не работи, копирај го линкот: ${verifyLink}</p>
        </div>
      `
    });

    res.status(201).json({ id: result.insertId, email, role, full_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// GET /auth/verify?token=...  — линкот од email-от (се отвора во browser, враќа HTML)
router.get('/verify', async (req, res) => {
  const { token } = req.query;
  const okPage = (title, msg) => `
    <html><body style="font-family:sans-serif; text-align:center; padding:60px 20px; background:#FBF7F1;">
      <h2 style="color:#3B3142;">${title}</h2>
      <p style="color:#8A8290;">${msg}</p>
      <a href="${APP_URL}" style="display:inline-block; margin-top:20px; background:#6B4E8E; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none;">Оди на PianoForte</a>
    </body></html>
  `;

  if (!token) return res.status(400).send(okPage('Невалиден линк', 'Недостасува токен за потврда.'));

  const [rows] = await pool.query('SELECT id FROM users WHERE verify_token = ?', [token]);
  if (rows.length === 0) {
    return res.status(400).send(okPage('Линкот не важи', 'Овој линк веќе е искористен или е невалиден.'));
  }

  await pool.query('UPDATE users SET email_verified = TRUE, verify_token = NULL WHERE id = ?', [rows[0].id]);
  res.send(okPage('✓ Профилот е потврден!', 'Сега можеш да се најавиш и да продолжиш со користење на PianoForte.'));
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

    // Учениците мора прво да го потврдат email-от (линк од регистрацискиот email)
    // пред да можат да се најават. Професорски/admin сметки се создаваат рачно
    // од admin-от, кој веќе го потврдил идентитетот, па тие не се блокираат овде.
    if (user.role === 'student' && !user.email_verified) {
      return res.status(403).json({ error: 'Прво потврди го email-от — провери го твojot inbox и кликни на линкот што ти го испративме.' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name, email_verified: !!user.email_verified }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// GET /auth/me  — сопствен профил, потврдува дека токенот работи
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, email, role, full_name, email_verified, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Корисникот не постои.' });
  res.json(rows[0]);
});

module.exports = router;
