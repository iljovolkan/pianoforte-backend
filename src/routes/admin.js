const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runDailyMaintenance } = require('../cron');

const router = express.Router();
const SALT_ROUNDS = 12;
const VALID_INSTRUMENTS = ['piano', 'gitara', 'el-gitara', 'bas-gitara', 'tapani', 'peenje', 'violina', 'ran-razvoj'];

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

// GET /admin/professors — листа на сите професори, со број групи/ученици (само admin)
router.get('/professors', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT u.id, u.email, u.full_name, u.instrument, u.created_at,
           COUNT(DISTINCT g.id) AS group_count,
           COUNT(DISTINCT gm.student_id) AS student_count
    FROM users u
    LEFT JOIN groups_table g ON g.professor_id = u.id
    LEFT JOIN group_members gm ON gm.group_id = g.id
    WHERE u.role = 'professor'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  res.json(rows);
});

// GET /admin/students — листа на сите деца (со податоци за родителот), само admin
router.get('/students', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.id, c.full_name, c.age, c.created_at,
            u.id AS parent_id, u.email AS parent_email, u.email_verified AS parent_email_verified
     FROM children c JOIN users u ON u.id = c.parent_id
     ORDER BY c.created_at DESC`
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

// GET /admin/overview — севкупна статистика за целиот систем (само admin)
router.get('/overview', requireAuth, requireRole('admin'), async (req, res) => {
  const [[childrenCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM children');
  const [[parentCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE role = 'student'");
  const [[profCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM users WHERE role = 'professor'");
  const [[groupCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM groups_table');
  const [[activeSubCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM subscriptions WHERE released = FALSE');
  const [[releasedSubCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM subscriptions WHERE released = TRUE');
  const [[pendingGroupCount]] = await pool.query('SELECT COUNT(*) AS cnt FROM subscriptions WHERE group_id IS NULL AND released = FALSE');
  const [[revenue]] = await pool.query("SELECT COALESCE(SUM(amount),0) AS total FROM installments WHERE status = 'paid'");
  const [[lateCount]] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM installments WHERE status = 'pending' AND due_date < CURDATE()"
  );
  const [[indivCount]] = await pool.query("SELECT COUNT(*) AS cnt FROM individual_bookings WHERE status = 'confirmed'");

  res.json({
    children: childrenCount.cnt,
    parents: parentCount.cnt,
    professors: profCount.cnt,
    groups: groupCount.cnt,
    active_subscriptions: activeSubCount.cnt,
    released_subscriptions: releasedSubCount.cnt,
    pending_group_selection: pendingGroupCount.cnt,
    total_revenue: revenue.total,
    late_installments: lateCount.cnt,
    individual_bookings: indivCount.cnt
  });
});

// GET /admin/purchases — последните 50 купувања (за преглед на активноста) (само admin)
router.get('/purchases', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(`
    SELECT p.id, p.payment_status, p.purchased_at, p.payment_provider_ref,
           c.full_name AS student_name, pk.name AS package_name, pk.price_mkd, pk.instrument,
           g.name AS group_name
    FROM purchases p
    JOIN children c ON c.id = p.student_id
    JOIN packages pk ON pk.id = p.package_id
    LEFT JOIN groups_table g ON g.id = p.group_id
    ORDER BY p.purchased_at DESC
    LIMIT 50
  `);
  res.json(rows);
});

// GET /admin/staff-list — сите professor/admin сметки, со тековен finance_access статус
// (за да admin избере на кого да ja довери дозволата)
router.get('/staff-list', requireAuth, requireRole('admin'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, full_name, email, role, instrument, finance_access
     FROM users WHERE role IN ('professor','admin') ORDER BY full_name ASC`
  );
  res.json(rows);
});

// PUT /admin/staff/:id/finance-access — доделува/отповикува пристап до финансиите.
// Ограничено на МАКСИМУМ 3 членови на персоналот (покрај admin сметките, кои секогаш имаат пристап).
router.put('/staff/:id/finance-access', requireAuth, requireRole('admin'), async (req, res) => {
  const { grant } = req.body; // true/false
  const staffId = Number(req.params.id);

  if (grant) {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE finance_access = 1 AND role != 'admin'`
    );
    if (cnt >= 3) {
      return res.status(409).json({ error: 'Веќе имаш доделено финансиски пристап на 3 членови од персоналот (максимум).' });
    }
  }

  const [result] = await pool.query(
    'UPDATE users SET finance_access = ? WHERE id = ? AND role IN ("professor","admin")',
    [grant ? 1 : 0, staffId]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Корисникот не е пронајден.' });
  res.json({ ok: true });
});

module.exports = router;
