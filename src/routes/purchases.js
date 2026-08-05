const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

const SCHOOL_YEAR_MONTHS = 8;   // училишна година = 8 месеци настава
const FULL_PLAN_DISCOUNT = 0.05; // 5% попуст ако се плаќа наеднаш

/**
 * Пресметува распоред на рати според избраниот план.
 * Враќа низа { number, total, amount, offsetDays }.
 */
function buildInstallmentSchedule(plan, monthlyPrice) {
  const annualTotal = monthlyPrice * SCHOOL_YEAR_MONTHS;

  if (plan === 'full') {
    const amount = Math.round(annualTotal * (1 - FULL_PLAN_DISCOUNT));
    return [{ number: 1, total: 1, amount, offsetDays: 0 }];
  }

  if (plan === 'two') {
    const first = Math.round(annualTotal / 2);
    const second = annualTotal - first;
    return [
      { number: 1, total: 2, amount: first, offsetDays: 0 },
      { number: 2, total: 2, amount: second, offsetDays: 150 } // ~5 месеци подоцна
    ];
  }

  // 'eight' — стандардно, монтено, без попуст
  const schedule = [];
  for (let i = 0; i < SCHOOL_YEAR_MONTHS; i++) {
    schedule.push({ number: i + 1, total: SCHOOL_YEAR_MONTHS, amount: monthlyPrice, offsetDays: i * 30 });
  }
  return schedule;
}

/**
 * POST /purchases
 * body: { package_id, group_id, payment_method_id, payment_plan }
 * payment_plan: 'full' | 'two' | 'eight' (стандардно 'eight' ако не е внесено)
 *
 * ВАЖНО: "payment_method_id" е tokenized референца добиена на клиентска страна
 * од платежниот процесор (пр. Stripe.js "PaymentMethod" или CPay/NestPay hosted
 * fields). Бројот на картичка, CVV и датумот на истек НИКОГАШ не поминуваат
 * низ нашиот сервер.
 */
router.post('/', requireAuth, requireRole('student'), async (req, res) => {
  const { package_id, group_id, payment_method_id, payment_plan } = req.body;
  const plan = ['full', 'two', 'eight'].includes(payment_plan) ? payment_plan : 'eight';

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
    // Овде оди реалниот повик до платежниот процесор за ПРВАТА рата, пр.:
    //   const charge = await stripe.paymentIntents.create({ amount: schedule[0].amount * 100, ... });
    const fakeProviderRef = 'SIMULATED-' + Date.now();

    await pool.query(
      `UPDATE purchases SET payment_status = 'paid', payment_provider_ref = ? WHERE id = ?`,
      [fakeProviderRef, purchaseResult.insertId]
    );
    await pool.query(
      'INSERT INTO group_members (group_id, student_id) VALUES (?, ?)',
      [group_id, req.user.id]
    );

    const schedule = buildInstallmentSchedule(plan, Number(pkg.price_mkd));
    const today = new Date();
    const firstDueDate = today.toISOString().slice(0, 10);

    const [subResult] = await pool.query(
      `INSERT INTO subscriptions (student_id, package_id, group_id, next_due_date, released, payment_plan)
       VALUES (?, ?, ?, ?, FALSE, ?)`,
      [req.user.id, package_id, group_id, firstDueDate, plan]
    );

    let nextPendingDueDate = null;
    for (const inst of schedule) {
      const dueDate = new Date(today);
      dueDate.setDate(dueDate.getDate() + inst.offsetDays);
      const isFirst = inst.number === 1;
      await pool.query(
        `INSERT INTO installments (subscription_id, installment_number, total_installments, amount, due_date, status, paid_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [subResult.insertId, inst.number, inst.total, inst.amount, dueDate.toISOString().slice(0, 10),
         isFirst ? 'paid' : 'pending', isFirst ? new Date() : null]
      );
      if (!isFirst && !nextPendingDueDate) nextPendingDueDate = dueDate;
    }

    // ако има повеќе од 1 рата, ажурирај next_due_date на следната неплатена;
    // ако сите рати се веќе платени (пр. "целосно" план), нема причина за
    // предупредување — терминот се смета за сигурен цела учебна година
    if (nextPendingDueDate) {
      await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?',
        [nextPendingDueDate.toISOString().slice(0, 10), subResult.insertId]);
    } else {
      const farFuture = new Date(today);
      farFuture.setDate(farFuture.getDate() + 365);
      await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?',
        [farFuture.toISOString().slice(0, 10), subResult.insertId]);
    }

    const planLabel = { full: 'Целосно (1 уплата)', two: '2 рати', eight: '8 месечни рати' }[plan];
    const remainingHtml = schedule.length > 1
      ? `<p>Останати рати: <strong>${schedule.length - 1}</strong>. Следна рата: <strong>${nextPendingDueDate ? nextPendingDueDate.toLocaleDateString('mk-MK') : '—'}</strong> (${schedule[1].amount} ден.)</p>`
      : '';

    await sendMail({
      to: req.user.email,
      subject: 'Потврда за уплата — PianoForte',
      html: `
        <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
          <h2>Плаќањето е успешно!</h2>
          <p>Пакет: <strong>${pkg.name}</strong></p>
          <p>Група: <strong>${group.name}</strong></p>
          <p>План на плаќање: <strong>${planLabel}</strong></p>
          <p>Прва рата (платена сега): <strong>${schedule[0].amount} ден.</strong></p>
          ${remainingHtml}
          <p style="color:#888; font-size:13px; margin-top:20px;">Референца: ${fakeProviderRef}</p>
        </div>
      `
    });

    res.status(201).json({
      purchase_id: purchaseResult.insertId,
      subscription_id: subResult.insertId,
      status: 'paid',
      provider_ref: fakeProviderRef,
      payment_plan: plan,
      installments: schedule.length,
      next_due_date: nextPendingDueDate ? nextPendingDueDate.toISOString().slice(0, 10) : null
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
