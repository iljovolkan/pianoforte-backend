const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

// GET /children — сите деца на најавениот родител
router.get('/', requireAuth, requireRole('student'), async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, full_name, age, photo_consent, access_code, created_at FROM children WHERE parent_id = ? ORDER BY created_at ASC',
    [req.user.id]
  );
  res.json(rows);
});

// POST /children  { full_name, age }
router.post('/', requireAuth, requireRole('student'), async (req, res) => {
  const { full_name, age, photo_consent } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Името е задолжително.' });
  }
  const [result] = await pool.query(
    'INSERT INTO children (parent_id, full_name, age, photo_consent) VALUES (?, ?, ?, ?)',
    [req.user.id, full_name.trim(), age || null, photo_consent ? 1 : 0]
  );
  res.status(201).json({ id: result.insertId, full_name: full_name.trim(), age: age || null, photo_consent: !!photo_consent });
});

// PUT /children/:id  { full_name, age }
router.put('/:id', requireAuth, requireRole('student'), async (req, res) => {
  const { full_name, age, photo_consent } = req.body;
  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Името е задолжително.' });
  }
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }
  await pool.query('UPDATE children SET full_name = ?, age = ?, photo_consent = ? WHERE id = ?',
    [full_name.trim(), age || null, photo_consent ? 1 : 0, req.params.id]);
  res.json({ ok: true });
});

// DELETE /children/:id — брише дете и сите негови поврзани записи (материјали,
// членства во групи, претплати...) преку истиот id механизам
router.delete('/:id', requireAuth, requireRole('student'), async (req, res) => {
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }
  const [[countRow]] = await pool.query('SELECT COUNT(*) AS cnt FROM children WHERE parent_id = ?', [req.user.id]);
  if (countRow.cnt <= 1) {
    return res.status(400).json({ error: 'Мора да имаш барем едно дете на профилот.' });
  }

  await pool.query('DELETE FROM group_members WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM materials WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM installments WHERE subscription_id IN (SELECT id FROM subscriptions WHERE student_id = ?)', [req.params.id]);
  await pool.query('DELETE FROM subscriptions WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM purchases WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM individual_bookings WHERE student_id = ?', [req.params.id]);
  await pool.query('DELETE FROM children WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

// POST /children/:id/access-code — генерира (или регенерира) краток пристапен
// код за детето, за да може само да се логира без email/лозинка на родителот.
router.post('/:id/access-code', requireAuth, requireRole('student'), async (req, res) => {
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без лесно-збркливи карактери (0/O, 1/I)
  let code;
  let attempts = 0;
  while (attempts < 10) {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const [[existing]] = await pool.query('SELECT id FROM children WHERE access_code = ?', [code]);
    if (!existing) break;
    attempts++;
  }
  await pool.query('UPDATE children SET access_code = ? WHERE id = ?', [code, req.params.id]);
  res.json({ access_code: code });
});

// POST /children/:id/withdraw  { reason } — "Прекинување на услугата".
// Ja бришe од сите групи/претплати, ja архивира во withdrawn_students, и
// испраќа email до родителот за потврда.
router.post('/:id/withdraw', requireAuth, requireRole('student'), async (req, res) => {
  const { reason } = req.body;
  const [[child]] = await pool.query('SELECT * FROM children WHERE id = ?', [req.params.id]);
  if (!child || child.parent_id !== req.user.id) {
    return res.status(404).json({ error: 'Детето не постои.' });
  }

  const [[parent]] = await pool.query('SELECT full_name, email FROM users WHERE id = ?', [req.user.id]);

  // земи го професорот од активна претплата/група (ако постои)
  const [[activeSub]] = await pool.query(
    `SELECT g.professor_id, u.full_name AS professor_name
     FROM subscriptions s
     LEFT JOIN groups_table g ON g.id = s.group_id
     LEFT JOIN users u ON u.id = g.professor_id
     WHERE s.student_id = ? AND s.released = FALSE
     ORDER BY s.id DESC LIMIT 1`,
    [req.params.id]
  );

  await pool.query(
    `INSERT INTO withdrawn_students (student_id, student_name, parent_id, parent_name, parent_email, professor_id, professor_name, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [child.id, child.full_name, req.user.id, parent.full_name, parent.email,
     activeSub ? activeSub.professor_id : null, activeSub ? activeSub.professor_name : null, reason || null]
  );

  await pool.query('DELETE FROM group_members WHERE student_id = ?', [req.params.id]);
  await pool.query("UPDATE subscriptions SET released = TRUE WHERE student_id = ?", [req.params.id]);

  try {
    await sendMail({
      to: parent.email,
      subject: 'Потврда за прекин на услугата — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Услугата е прекината</h2>
          <p>Здраво ${parent.full_name},</p>
          <p>Ja потврдуваме дека услугата за <strong>${child.full_name}</strong> е прекината, согласно твojot барање.</p>
          <p style="color:#888; font-size:13px; margin-top:20px;">Ако ова е грешка, или сакаш повторно да се запишеш, jaви ни се на info@pianoforte.edu.mk.</p>
        </div>
      `
    });
  } catch (e) { console.error('Withdraw email error:', e); }

  res.json({ ok: true });
});

// ---- Телефон на родител: професорот ги внесува за родителите од неговите групи; admin/финансиски пристап за сите ----
const PHONE_RE = /^[+0-9][0-9 ()\/.-]{5,24}$/;
async function canManageParentOf(user, childId) {
  if (user.role === 'admin') return true;
  const [[u]] = await pool.query('SELECT finance_access FROM users WHERE id = ?', [user.id]);
  if (u && u.finance_access === 1) return true;
  if (user.role !== 'professor') return false;
  const [[ok]] = await pool.query(
    `SELECT 1 AS ok FROM children c
     WHERE c.id = ? AND (
       EXISTS (SELECT 1 FROM group_members gm JOIN groups_table g ON g.id = gm.group_id WHERE gm.student_id = c.id AND g.professor_id = ?)
       OR EXISTS (SELECT 1 FROM subscriptions s JOIN groups_table g ON g.id = s.group_id WHERE s.student_id = c.id AND g.professor_id = ? AND s.released = FALSE))
     LIMIT 1`, [childId, user.id, user.id]);
  return !!ok;
}

// GET /children/my-group-parents — за професор: деца од неговите групи со родител и телефон
router.get('/my-group-parents', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT c.id AS child_id, c.full_name AS child_name, u.id AS parent_id, u.full_name AS parent_name, u.phone AS parent_phone, g.id AS group_id, g.name AS group_name
       FROM groups_table g
       JOIN group_members gm ON gm.group_id = g.id
       JOIN children c ON c.id = gm.student_id
       JOIN users u ON u.id = c.parent_id
       WHERE g.professor_id = ?
       ORDER BY g.name, c.full_name`, [req.user.id]);
    res.json(rows);
  } catch (err) { console.error('GET /children/my-group-parents error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

// PUT /children/:id/parent-phone { phone } — поставува телефон на родителот на детето
router.put('/:id/parent-phone', requireAuth, requireRole('professor', 'admin'), async (req, res) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Внеси валиден телефонски број.' });
    if (!(await canManageParentOf(req.user, req.params.id))) return res.status(403).json({ error: 'Можеш да менуваш телефон само за родители на деца од твоите групи.' });
    const [[c]] = await pool.query('SELECT parent_id FROM children WHERE id = ?', [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Детето не постои.' });
    await pool.query('UPDATE users SET phone = ? WHERE id = ?', [phone, c.parent_id]);
    res.json({ ok: true, phone });
  } catch (err) { console.error('PUT /children/:id/parent-phone error:', err); res.status(500).json({ error: 'Грешка: ' + err.message }); }
});

module.exports = router;
