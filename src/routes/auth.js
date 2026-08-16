const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();
const SALT_ROUNDS = 12;
const APP_URL = process.env.APP_BASE_URL || 'https://app.pianoforte.edu.mk';
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '2h';
const REFRESH_TOKEN_DAYS = 30;

// Спречува brute-force обиди за најава/регистрација — макс. 10 обиди на 15 мин по IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Премногу обиди за најава. Пробај повторно за 15 минути.' }
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Премногу обиди за регистрација. Пробај повторно подоцна.' }
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Премногу обиди. Пробај повторно за еден час.' }
});

function issueTokens(user) {
  const accessToken = jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
  const refreshToken = crypto.randomBytes(40).toString('hex');
  return { accessToken, refreshToken };
}

// POST /auth/register  { email, password, full_name, role }
router.post('/register', registerLimiter, async (req, res) => {
  const { email, password, full_name, role, child_name, child_age } = req.body;

  if (!email || !password || !full_name || !role) {
    return res.status(400).json({ error: 'Сите полиња се задолжителни.' });
  }
  if (!['admin', 'professor', 'student'].includes(role)) {
    return res.status(400).json({ error: 'Невалидна улога.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Лозинката мора да има барем 8 карактери.' });
  }
  if (role === 'student' && (!child_name || !child_name.trim())) {
    return res.status(400).json({ error: 'Името на детето е задолжително.' });
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

    // за родителски (student) сметки, автоматски креирај го првото дете —
    // родителот подоцна може да додаде уште деца од профилот
    if (role === 'student') {
      await pool.query(
        'INSERT INTO children (parent_id, full_name, age) VALUES (?, ?, ?)',
        [result.insertId, child_name.trim(), child_age || null]
      );
    }

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
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email и лозинка се задолжителни.' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Погрешен email или лозинка.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Погрешен email или лозинка.' });
    }

    if (user.role === 'student' && !user.email_verified) {
      return res.status(403).json({ error: 'Прво потврди го email-от — провери го твojot inbox и кликни на линкот што ти го испративме.' });
    }

    const { accessToken, refreshToken } = issueTokens(user);
    const expires = new Date();
    expires.setDate(expires.getDate() + REFRESH_TOKEN_DAYS);
    await pool.query('UPDATE users SET refresh_token = ?, refresh_token_expires = ? WHERE id = ?',
      [refreshToken, expires, user.id]);

    res.json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name, email_verified: !!user.email_verified, instrument: user.instrument }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Грешка на серверот.' });
  }
});

// POST /auth/refresh  { refreshToken }  — издава нов пристапен токен без повторна лозинка
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'Недостасува refreshToken.' });

  const [rows] = await pool.query(
    'SELECT * FROM users WHERE refresh_token = ? AND refresh_token_expires > NOW()',
    [refreshToken]
  );
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Сесијата истечe — најави се повторно.' });

  const { accessToken, refreshToken: newRefreshToken } = issueTokens(user);
  const expires = new Date();
  expires.setDate(expires.getDate() + REFRESH_TOKEN_DAYS);
  await pool.query('UPDATE users SET refresh_token = ?, refresh_token_expires = ? WHERE id = ?',
    [newRefreshToken, expires, user.id]);

  res.json({
    token: accessToken,
    refreshToken: newRefreshToken,
    user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name, email_verified: !!user.email_verified, instrument: user.instrument }
  });
});

// POST /auth/logout — го поништува refresh токенот (одјава на серверска страна)
router.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET refresh_token = NULL, refresh_token_expires = NULL WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
});

// GET /auth/me  — сопствен профил, потврдува дека токенот работи
router.get('/me', requireAuth, async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, email, role, full_name, email_verified, instrument, created_at FROM users WHERE id = ?',
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Корисникот не постои.' });
  res.json(rows[0]);
});

// POST /auth/forgot-password  { email }
// Секогаш враќа успех (без разлика дали email-от постои) — да не откриваме
// дали некоја адреса е регистрирана во системот.
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email е задолжителен.' });

  const [rows] = await pool.query('SELECT id, full_name FROM users WHERE email = ?', [email]);
  const user = rows[0];

  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 час
    await pool.query('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
      [resetToken, expires, user.id]);

    const resetLink = `${APP_URL}/?reset_token=${resetToken}`;
    await sendMail({
      to: email,
      subject: 'Ресетирање лозинка — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Заборави ja лозинката?</h2>
          <p>Здраво, ${user.full_name}!</p>
          <p>Кликни на копчето подолу за да поставиш нова лозинка. Линкот важи 1 час.</p>
          <p style="margin:24px 0;">
            <a href="${resetLink}" style="background:#A97E33; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600;">Постави нова лозинка</a>
          </p>
          <p style="color:#888; font-size:13px;">Ако не си го побарал ова, слободно игнорирај го email-от — лозинката останува непроменета.</p>
        </div>
      `
    });
  }

  res.json({ ok: true, message: 'Ако email-от постои во системот, испративме линк за ресетирање.' });
});

// POST /auth/reset-password  { token, password }
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Токенот и новата лозинка се задолжителни.' });
  if (password.length < 8) return res.status(400).json({ error: 'Лозинката мора да има барем 8 карактери.' });

  const [rows] = await pool.query(
    'SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > NOW()',
    [token]
  );
  const user = rows[0];
  if (!user) return res.status(400).json({ error: 'Линкот не важи или е истечен. Побарај нов.' });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await pool.query(
    'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, refresh_token = NULL, refresh_token_expires = NULL WHERE id = ?',
    [passwordHash, user.id]
  );

  res.json({ ok: true, message: 'Лозинката е успешно променета. Најави се со новата лозинка.' });
});

// PUT /auth/profile  { full_name, email }
// Ако email-от се смени за ученик, се бара повторна потврда (email_verified
// се враќа на FALSE и се испраќа нов линк) — за professor/admin не е потребно.
router.put('/profile', requireAuth, async (req, res) => {
  const { full_name, email } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Името е задолжително.' });
  }

  const [[me]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!me) return res.status(404).json({ error: 'Корисникот не постои.' });

  let emailChanged = false;
  if (email && email !== me.email) {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Веќе постои друг корисник со овoj email.' });
    }
    emailChanged = true;
  }

  if (emailChanged && me.role === 'student') {
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await pool.query(
      'UPDATE users SET full_name = ?, email = ?, email_verified = FALSE, verify_token = ? WHERE id = ?',
      [full_name.trim(), email, verifyToken, req.user.id]
    );
    const verifyLink = `${APP_URL}/auth/verify?token=${verifyToken}`;
    await sendMail({
      to: email,
      subject: 'Потврди го новиот email — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Потврди го новиот email</h2>
          <p>Здраво, ${full_name}! Го смени email-от на твojot профил — кликни подолу за да го потврдиш.</p>
          <p style="margin:24px 0;">
            <a href="${verifyLink}" style="background:#A97E33; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600;">Потврди го email-от</a>
          </p>
        </div>
      `
    });
    return res.json({ ok: true, email_changed: true, requires_verification: true });
  }

  await pool.query('UPDATE users SET full_name = ?, email = ? WHERE id = ?',
    [full_name.trim(), email || me.email, req.user.id]);
  res.json({ ok: true, email_changed: emailChanged, requires_verification: false });
});

// POST /auth/change-password  { current_password, new_password }
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Тековната и новата лозинка се задолжителни.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Новата лозинка мора да има барем 8 карактери.' });
  }

  const [[me]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const match = await bcrypt.compare(current_password, me.password_hash);
  if (!match) return res.status(401).json({ error: 'Тековната лозинка не е точна.' });

  const passwordHash = await bcrypt.hash(new_password, SALT_ROUNDS);
  await pool.query(
    'UPDATE users SET password_hash = ?, refresh_token = NULL, refresh_token_expires = NULL WHERE id = ?',
    [passwordHash, req.user.id]
  );
  res.json({ ok: true });
});

module.exports = router;
