const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ВАЖНО: старата симулирана логика за плаќање (POST /purchases) е отстранета.
// Вистинскиот тек сега е:
//   1. POST /payments/init-subscription — креира payment_intent, враќа cPay параметри
//   2. Frontend автоматски поднесува форма кон cPay
//   3. cPay редиректира кон /payments/cpay-ok — ТАМУ навистина се создава
//      претплатата (не порано)
// Видете src/routes/payments.js за целата логика.

// GET /purchases/history/:studentId — историја на купувања (studentId = id на детето)
router.get('/history/:studentId', requireAuth, async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (req.user.role === 'student') {
    const [[child]] = await pool.query('SELECT id FROM children WHERE id = ? AND parent_id = ?', [studentId, req.user.id]);
    if (!child) return res.status(403).json({ error: 'Немаш пристап до туѓи купувања.' });
  }
  const [rows] = await pool.query(
    `SELECT p.*, pk.name AS package_name FROM purchases p
     JOIN packages pk ON pk.id = p.package_id
     WHERE p.student_id = ? ORDER BY p.purchased_at DESC`,
    [studentId]
  );
  res.json(rows);
});

module.exports = router;
