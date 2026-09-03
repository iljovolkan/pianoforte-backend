const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ВАЖНО: старата симулирана логика (POST /installments/:id/pay) е отстранета.
// Новиот тек: POST /payments/init-installment → cPay → /payments/cpay-ok
// (видете src/routes/payments.js).

// GET /installments — сите рати за ученик (свои) или за професор (неговите ученици)
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const [rows] = await pool.query(
      `SELECT i.*, s.payment_plan, s.group_id, p.name AS package_name, g.name AS group_name, c.full_name AS student_name
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       JOIN packages p ON p.id = s.package_id
       LEFT JOIN groups_table g ON g.id = s.group_id
       WHERE c.parent_id = ?
       ORDER BY i.due_date ASC`,
      [req.user.id]
    );
    return res.json(rows);
  }

  const whereClause = req.user.role === 'admin' ? '1=1' : 'g.professor_id = ?';
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  const [rows] = await pool.query(
    `SELECT i.*, s.payment_plan, c.full_name AS student_name, p.name AS package_name, g.name AS group_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN children c ON c.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     LEFT JOIN groups_table g ON g.id = s.group_id
     WHERE ${whereClause}
     ORDER BY i.due_date ASC`,
    params
  );
  res.json(rows);
});

module.exports = router;
