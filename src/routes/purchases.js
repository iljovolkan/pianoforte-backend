const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

/**
 * POST /purchases
 * body: { package_id, group_id, payment_method_id }
 *
 * ВАЖНО: "payment_method_id" е tokenized референца добиена на клиентска страна
 * од платежниот процесор (пр. Stripe.js "PaymentMethod" или CPay/NestPay hosted
 * fields). Бројот на картичка, CVV и датумот на истек НИКОГАШ не поминуваат
 * низ нашиот сервер — тоа би значело PCI-DSS обврска што сакаме да ја избегнеме.
 * Клиентската апликација (сајтот) комуницира директно со процесорот, добива
 * token, и само токенот стигнува овде.
 */
router.post('/', requireAuth, requireRole('student'), async (req, res) => {
  const { package_id, group_id, payment_method_id } = req.body;

  if (!package_id || !group_id || !payment_method_id) {
    return res.status(400).json({ error: 'package_id, group_id и payment_method_id се задолжителни.' });
  }

  const [[pkg]] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
  if (!pkg) return res.status(404).json({ error: 'Пакетот не постои.' });

  const [[group]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [group_id]);
  if (!group) return res.status(404).json({ error: 'Групата не постои.' });

  const [members] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [group_id]);
  if (members.length >= group.capacity) {
    return res.status(409).json({ error: 'Групата е веќе пополнета.' });
  }
  if (members.some(m => m.student_id === req.user.id)) {
    return res.status(409).json({ error: 'Веќе си во оваа група.' });
  }

  const [purchaseResult] = await pool.query(
    `INSERT INTO purchases (student_id, package_id, group_id, payment_status)
     VALUES (?, ?, ?, 'pending')`,
    [req.user.id, package_id, group_id]
  );

  try {
    // Овде оди реалниот повик до платежниот процесор, пр.:
    //   const charge = await stripe.paymentIntents.create({
    //     amount: pkg.price_mkd * 100,
    //     currency: 'mkd',
    //     payment_method: payment_method_id,
    //     confirm: true
    //   });
    // За сега симулираме успешна трансакција додека не се интегрира вистинскиот процесор.
    const fakeProviderRef = 'SIMULATED-' + Date.now();

    await pool.query(
      `UPDATE purchases SET payment_status = 'paid', payment_provider_ref = ? WHERE id = ?`,
      [fakeProviderRef, purchaseResult.insertId]
    );
    await pool.query(
      'INSERT INTO group_members (group_id, student_id) VALUES (?, ?)',
      [group_id, req.user.id]
    );

    // Создава/продолжува претплата — следна рата за 30 дена
    const nextDue = new Date();
    nextDue.setDate(nextDue.getDate() + 30);
    await pool.query(
      `INSERT INTO subscriptions (student_id, package_id, group_id, next_due_date, released)
       VALUES (?, ?, ?, ?, FALSE)`,
      [req.user.id, package_id, group_id, nextDue.toISOString().slice(0, 10)]
    );

    await sendMail({
      to: req.user.email,
      subject: 'Потврда за уплата — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Плаќањето е успешно!</h2>
          <p>Пакет: <strong>${pkg.name}</strong></p>
          <p>Група: <strong>${group.name}</strong></p>
          <p>Износ: <strong>${pkg.price_mkd} ден.</strong></p>
          <p>Следна рата доспева на: <strong>${nextDue.toLocaleDateString('mk-MK')}</strong></p>
          <p style="color:#888; font-size:13px; margin-top:20px;">Референца: ${fakeProviderRef}</p>
        </div>
      `
    });

    res.status(201).json({
      purchase_id: purchaseResult.insertId,
      status: 'paid',
      provider_ref: fakeProviderRef,
      next_due_date: nextDue.toISOString().slice(0, 10)
    });
  } catch (err) {
    await pool.query(`UPDATE purchases SET payment_status = 'failed' WHERE id = ?`, [purchaseResult.insertId]);
    console.error(err);
    res.status(502).json({ error: 'Плаќањето не успеа. Обиди се повторно.' });
  }
});

// GET /purchases/history/:studentId — историја на купувања
router.get('/history/:studentId', requireAuth, async (req, res) => {
  const studentId = Number(req.params.studentId);
  if (req.user.role === 'student' && req.user.id !== studentId) {
    return res.status(403).json({ error: 'Немаш пристап до туѓи купувања.' });
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
