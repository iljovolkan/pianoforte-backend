const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

// GET /installments — сите рати за ученик (свои) или за професор (неговите ученици)
router.get('/', requireAuth, async (req, res) => {
  if (req.user.role === 'student') {
    const [rows] = await pool.query(
      `SELECT i.*, s.payment_plan, s.group_id, p.name AS package_name, g.name AS group_name
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN packages p ON p.id = s.package_id
       JOIN groups_table g ON g.id = s.group_id
       WHERE s.student_id = ?
       ORDER BY i.due_date ASC`,
      [req.user.id]
    );
    return res.json(rows);
  }

  const whereClause = req.user.role === 'admin' ? '1=1' : 'g.professor_id = ?';
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  const [rows] = await pool.query(
    `SELECT i.*, s.payment_plan, u.full_name AS student_name, p.name AS package_name, g.name AS group_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN users u ON u.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     JOIN groups_table g ON g.id = s.group_id
     WHERE ${whereClause}
     ORDER BY i.due_date ASC`,
    params
  );
  res.json(rows);
});

// POST /installments/:id/pay — симулирано плаќање на чекачка рата (само ученик, само своја)
router.post('/:id/pay', requireAuth, requireRole('student'), async (req, res) => {
  const { payment_method_id } = req.body;
  if (!payment_method_id) {
    return res.status(400).json({ error: 'payment_method_id е задолжителен.' });
  }

  const [[inst]] = await pool.query(
    `SELECT i.*, s.student_id, s.id AS subscription_id, s.released, u.email, u.full_name, p.name AS package_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN users u ON u.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     WHERE i.id = ?`,
    [req.params.id]
  );
  if (!inst) return res.status(404).json({ error: 'Ратата не постои.' });
  if (inst.student_id !== req.user.id) return res.status(403).json({ error: 'Немаш пристап до туѓа рата.' });
  if (inst.status === 'paid') return res.status(409).json({ error: 'Оваа рата е веќе платена.' });
  if (inst.status === 'released') return res.status(409).json({ error: 'Терминот е веќе ослободен — потребна е нова резервација.' });

  // Овде оди реалниот повик до платежниот процесор (симулирано засега)
  await pool.query(`UPDATE installments SET status = 'paid', paid_at = NOW() WHERE id = ?`, [inst.id]);

  // ажурирај next_due_date на претплатата кон следната неплатена рата;
  // ако немa повеќе рати (последната беше платена), терминот е сигурен цела година
  const [[nextPending]] = await pool.query(
    `SELECT due_date FROM installments WHERE subscription_id = ? AND status = 'pending' ORDER BY due_date ASC LIMIT 1`,
    [inst.subscription_id]
  );
  if (nextPending) {
    await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?', [nextPending.due_date, inst.subscription_id]);
  } else {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 365);
    await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?',
      [farFuture.toISOString().slice(0, 10), inst.subscription_id]);
  }

  await sendMail({
    to: inst.email,
    subject: `Потврда за рата ${inst.installment_number}/${inst.total_installments} — PianoForte`,
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>Ратата е успешно платена!</h2>
        <p>Пакет: <strong>${inst.package_name}</strong></p>
        <p>Рата: <strong>${inst.installment_number}/${inst.total_installments}</strong></p>
        <p>Износ: <strong>${inst.amount} ден.</strong></p>
        ${nextPending ? `<p>Следна рата доспева на: <strong>${new Date(nextPending.due_date).toLocaleDateString('mk-MK')}</strong></p>` : '<p>Ова беше последната рата — целиот пакет е платен!</p>'}
      </div>
    `
  });

  res.json({ ok: true, next_due_date: nextPending ? nextPending.due_date : null });
});

module.exports = router;
