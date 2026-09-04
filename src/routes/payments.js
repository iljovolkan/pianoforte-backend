const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendMail } = require('../mailer');

const router = express.Router();

// ===== cPay поставки (Casys) =====
// ВАЖНО: твojata сметка (Merchant ID 1000001529) е поставена на ПОСТАРИОТ
// MD5-базиран checksum алгоритам (не HMAC-SHA256 од новата официјална
// спецификација) — ова е потврдено директно од твojot вистински, веќе
// работечки WordPress/WooCommerce плагин код (wp-content/plugins/casis/admin.php).
const CPAY_PAYMENT_URL = process.env.CPAY_PAYMENT_URL || 'https://www.cpay.com.mk/client/Page/default.aspx?xml_id=/mk-MK/.loginToPay/.simple/';
const CPAY_MERCHANT_ID = process.env.CPAY_MERCHANT_ID;       // PayToMerchant — 1000001529
const CPAY_MERCHANT_NAME = process.env.CPAY_MERCHANT_NAME || 'PIJANO FORTE SKOPJE'; // точно како во живиот плагин
const CPAY_CHECKSUM_KEY = process.env.CPAY_CHECKSUM_KEY;     // вистинскиот клуч од стариот плагин
const APP_URL = process.env.APP_BASE_URL || 'https://app.pianoforte.edu.mk';

const HALF_YEAR_DISCOUNT = 0.03;
const FULL_YEAR_DISCOUNT = 0.05;

function buildAnnualSchedule(plan, monthlyPrice) {
  const annualTotal = monthlyPrice * 8;
  if (plan === 'full') {
    const amount = Math.round(annualTotal * (1 - FULL_YEAR_DISCOUNT));
    return [{ number: 1, total: 1, amount, offsetDays: 0 }];
  }
  if (plan === 'two') {
    const halfPrice = Math.round((annualTotal / 2) * (1 - HALF_YEAR_DISCOUNT));
    return [
      { number: 1, total: 2, amount: halfPrice, offsetDays: 0 },
      { number: 2, total: 2, amount: halfPrice, offsetDays: 150 }
    ];
  }
  const schedule = [];
  for (let i = 0; i < 8; i++) {
    schedule.push({ number: i + 1, total: 8, amount: monthlyPrice, offsetDays: i * 30 });
  }
  return schedule;
}

// ===================================================================
// CheckSum — точно реконструиран и ПОТВРДЕН со реален успешен тест против
// нашиот вистински WordPress плагин (wp-content/plugins/casis/admin.php)
// И реалниот cPay одговор (ReturnCheckSum совпадна точно). CheckSum =
// MD5(Header + СитеВредностиСпоени + Клуч).
// ===================================================================
const REQUEST_FIELD_ORDER = [
  'AmountToPay', 'PayToMerchant', 'MerchantName', 'AmountCurrency', 'Details1', 'Details2',
  'PaymentOKURL', 'PaymentFailURL', 'FirstName', 'LastName', 'Address', 'City', 'Zip',
  'Country', 'Telephone', 'Email', 'OriginalAmount', 'OriginalCurrency'
];

// Враќачкиот checksum ги менува местата на првите два параметри
// (PayToMerchant, AmountToPay наместо AmountToPay, PayToMerchant),
// и додава cPayPaymentRef на крајот. Потврдено со реален тест.
const RETURN_FIELD_ORDER = [
  'PayToMerchant', 'AmountToPay', 'MerchantName', 'AmountCurrency', 'Details1', 'Details2',
  'PaymentOKURL', 'PaymentFailURL', 'FirstName', 'LastName', 'Address', 'City', 'Zip',
  'Country', 'Telephone', 'Email', 'OriginalAmount', 'OriginalCurrency', 'cPayPaymentRef'
];

function buildLegacyChecksum(fields, order) {
  const count = String(order.length).padStart(2, '0');
  const names = order.join(',');
  const lengths = order.map(name => {
    const val = String(fields[name] ?? '');
    return String([...val].length).padStart(3, '0'); // UTF-8-безбедно броење карактери
  }).join('');
  const header = `${count}${names},${lengths}`;
  const values = order.map(name => String(fields[name] ?? '')).join('');
  const checksum = crypto.createHash('md5').update(header + values + CPAY_CHECKSUM_KEY, 'utf8').digest('hex');
  return { header, checksum };
}

function buildRequestChecksum(fields) {
  return buildLegacyChecksum(fields, REQUEST_FIELD_ORDER);
}

function verifyReturnChecksum(data) {
  if (!data.ReturnCheckSum) {
    console.warn('cPay: ReturnCheckSum не е присутен во одговорот.');
    return true;
  }
  const { checksum } = buildLegacyChecksum(data, RETURN_FIELD_ORDER);
  return checksum.toLowerCase() === String(data.ReturnCheckSum).toLowerCase();
}

// Details1 макс. 32 карактери според спецификацијата
function truncateDetails1(text) {
  return String(text).slice(0, 32);
}

// Прикажува HTML страница со статус 200 (важно за push notifications), која
// ИСТОВРЕМЕНО веднаш го пренасочува browser-от кон апликацијата — работи
// правилно и за browser redirect и за server-to-server push повици.
function respondAndRedirect(res, targetPath) {
  const url = `${APP_URL}${targetPath}`;
  res.status(200).send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${url}"></head><body>OK<script>location.href=${JSON.stringify(url)};</script></body></html>`);
}

// ===================================================================
// POST /payments/init-subscription
// ===================================================================
router.post('/init-subscription', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const { package_id, group_id, child_id } = req.body;
    let { payment_plan } = req.body;

    if (!package_id || !child_id) {
      return res.status(400).json({ error: 'package_id и child_id се задолжителни.' });
    }
    if (!CPAY_MERCHANT_ID || !CPAY_CHECKSUM_KEY) {
      return res.status(500).json({ error: 'CPay сè уште не е целосно конфигуриран на серверот.' });
    }

    const [[child]] = await pool.query('SELECT id, full_name FROM children WHERE id = ? AND parent_id = ?', [child_id, req.user.id]);
    if (!child) return res.status(403).json({ error: 'Ова дете не е поврзано со твojot профил.' });

    const [[pkg]] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
    if (!pkg) return res.status(404).json({ error: 'Пакетот не постои.' });
    if (pkg.package_type === 'individual') {
      return res.status(400).json({ error: 'Индивидуалните часови се закажуваат преку /individual-bookings.' });
    }

    if (group_id) {
      const [[g]] = await pool.query('SELECT * FROM groups_table WHERE id = ?', [group_id]);
      if (!g) return res.status(404).json({ error: 'Групата не постои.' });
      if (g.instrument !== pkg.instrument) {
        return res.status(400).json({ error: 'Пакетот и групата се за различни инструменти.' });
      }
      const [members] = await pool.query('SELECT student_id FROM group_members WHERE group_id = ?', [group_id]);
      if (members.length >= g.capacity) return res.status(409).json({ error: 'Групата е веќе пополнета.' });
      if (members.some(m => m.student_id === child_id)) return res.status(409).json({ error: 'Детето е веќе во оваа група.' });
    }

    const plan = pkg.package_type === 'trial' ? 'trial' : (['full', 'two', 'eight'].includes(payment_plan) ? payment_plan : 'eight');
    const schedule = plan === 'trial'
      ? [{ number: 1, total: 1, amount: Number(pkg.price_mkd), offsetDays: 0 }]
      : buildAnnualSchedule(plan, Number(pkg.price_mkd));
    const firstAmount = Math.round(schedule[0].amount); // цели денари — AmountToPay мора да завршува на 00

    const payload = { child_id, package_id, group_id: group_id || null, payment_plan: plan };
    const [result] = await pool.query(
      `INSERT INTO payment_intents (kind, user_id, payload, amount, status) VALUES ('subscription', ?, ?, ?, 'pending')`,
      [req.user.id, JSON.stringify(payload), firstAmount]
    );

    const fields = {
      AmountToPay: String(firstAmount * 100),
      AmountCurrency: 'MKD',
      Details1: truncateDetails1(`${pkg.name} ${child.full_name}`),
      Details2: String(result.insertId),
      PayToMerchant: CPAY_MERCHANT_ID,
      MerchantName: CPAY_MERCHANT_NAME,
      PaymentOKURL: `${APP_URL}/payments/cpay-ok`,
      PaymentFailURL: `${APP_URL}/payments/cpay-fail`,
      FirstName: '', LastName: '', Address: '', City: '', Zip: '', Country: '', Telephone: '',
      Email: req.user.email,
      OriginalAmount: '', OriginalCurrency: ''
    };
    const { header, checksum } = buildRequestChecksum(fields);
    fields.CheckSumHeader = header;
    fields.CheckSum = checksum;

    res.json({ intent_id: result.insertId, cpay_url: CPAY_PAYMENT_URL, fields });
  } catch (err){
    console.error('POST /payments/init-subscription error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// ===================================================================
// POST /payments/init-individual-booking
// ===================================================================
const VALID_TIMES = ['14:30','15:15','16:00','16:45','17:30','18:15','19:00','19:45'];

// ===================================================================
// POST /payments/init-installment — плаќање на идна (закажана) рата
// од веќе постоечка претплата, исто преку вистински cPay (не веќе
// симулирано).
// ===================================================================
router.post('/init-installment', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const { installment_id } = req.body;
    if (!installment_id) return res.status(400).json({ error: 'installment_id е задолжителен.' });
    if (!CPAY_MERCHANT_ID || !CPAY_CHECKSUM_KEY) {
      return res.status(500).json({ error: 'CPay сè уште не е целосно конфигуриран на серверот.' });
    }

    const [[inst]] = await pool.query(
      `SELECT i.*, s.student_id, s.package_id, c.full_name AS child_name, c.parent_id, p.name AS package_name
       FROM installments i
       JOIN subscriptions s ON s.id = i.subscription_id
       JOIN children c ON c.id = s.student_id
       JOIN packages p ON p.id = s.package_id
       WHERE i.id = ?`,
      [installment_id]
    );
    if (!inst) return res.status(404).json({ error: 'Ратата не постои.' });
    if (inst.parent_id !== req.user.id) return res.status(403).json({ error: 'Немаш пристап до оваа рата.' });
    if (inst.status === 'paid') return res.status(409).json({ error: 'Ратата е веќе платена.' });

    const amount = Math.round(Number(inst.amount));
    const payload = { installment_id: inst.id };
    const [result] = await pool.query(
      `INSERT INTO payment_intents (kind, user_id, payload, amount, status) VALUES ('installment', ?, ?, ?, 'pending')`,
      [req.user.id, JSON.stringify(payload), amount]
    );

    const fields = {
      AmountToPay: String(amount * 100),
      AmountCurrency: 'MKD',
      Details1: truncateDetails1(`Рата ${inst.installment_number}/${inst.total_installments} ${inst.child_name}`),
      Details2: String(result.insertId),
      PayToMerchant: CPAY_MERCHANT_ID,
      MerchantName: CPAY_MERCHANT_NAME,
      PaymentOKURL: `${APP_URL}/payments/cpay-ok`,
      PaymentFailURL: `${APP_URL}/payments/cpay-fail`,
      FirstName: '', LastName: '', Address: '', City: '', Zip: '', Country: '', Telephone: '',
      Email: req.user.email,
      OriginalAmount: '', OriginalCurrency: ''
    };
    const { header, checksum } = buildRequestChecksum(fields);
    fields.CheckSumHeader = header;
    fields.CheckSum = checksum;

    res.json({ intent_id: result.insertId, cpay_url: CPAY_PAYMENT_URL, fields });
  } catch (err) {
    console.error('POST /payments/init-installment error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

router.post('/init-individual-booking', requireAuth, requireRole('student'), async (req, res) => {
  try {
    const { package_id, availability_id, child_id } = req.body;
    if (!package_id || !availability_id || !child_id) {
      return res.status(400).json({ error: 'package_id, availability_id и child_id се задолжителни.' });
    }
    if (!CPAY_MERCHANT_ID || !CPAY_CHECKSUM_KEY) {
      return res.status(500).json({ error: 'CPay сè уште не е целосно конфигуриран на серверот.' });
    }

    const [[slot]] = await pool.query(
      'SELECT * FROM individual_availability WHERE id = ?', [availability_id]
    );
    if (!slot) return res.status(404).json({ error: 'Терминот повеќе не постои.' });
    if (slot.is_booked) return res.status(409).json({ error: 'Овoj термин веќе е резервиран од некого друг. Избери друг.' });

    const professor_id = slot.professor_id;
    const instrument = slot.instrument;
    const booking_date = slot.slot_date;
    const start_time = slot.start_time;

    const [[child]] = await pool.query('SELECT id, full_name FROM children WHERE id = ? AND parent_id = ?', [child_id, req.user.id]);
    if (!child) return res.status(403).json({ error: 'Ова дете не е поврзано со твojot профил.' });

    const [[pkg]] = await pool.query("SELECT * FROM packages WHERE id = ? AND package_type = 'individual'", [package_id]);
    if (!pkg) return res.status(404).json({ error: 'Пакетот не постои.' });

    const [[prof]] = await pool.query(
      "SELECT id, full_name FROM users WHERE id = ? AND role = 'professor' AND instrument = ?",
      [professor_id, instrument]
    );
    if (!prof) return res.status(404).json({ error: 'Професорот не постои или не го предава овoj инструмент.' });

    const amount = Math.round(Number(pkg.price_mkd));
    const payload = { child_id, professor_id, instrument, booking_date, start_time, availability_id };
    const [result] = await pool.query(
      `INSERT INTO payment_intents (kind, user_id, payload, amount, status) VALUES ('individual_booking', ?, ?, ?, 'pending')`,
      [req.user.id, JSON.stringify(payload), amount]
    );

    const fields = {
      AmountToPay: String(amount * 100),
      AmountCurrency: 'MKD',
      Details1: truncateDetails1(`Инд. час ${instrument} ${child.full_name}`),
      Details2: String(result.insertId),
      PayToMerchant: CPAY_MERCHANT_ID,
      MerchantName: CPAY_MERCHANT_NAME,
      PaymentOKURL: `${APP_URL}/payments/cpay-ok`,
      PaymentFailURL: `${APP_URL}/payments/cpay-fail`,
      FirstName: '', LastName: '', Address: '', City: '', Zip: '', Country: '', Telephone: '',
      Email: req.user.email,
      OriginalAmount: '', OriginalCurrency: ''
    };
    const { header, checksum } = buildRequestChecksum(fields);
    fields.CheckSumHeader = header;
    fields.CheckSum = checksum;

    res.json({ intent_id: result.insertId, cpay_url: CPAY_PAYMENT_URL, fields });
  } catch (err) {
    console.error('POST /payments/init-individual-booking error:', err);
    res.status(500).json({ error: 'Грешка: ' + err.message });
  }
});

// ===================================================================
// cPay ги повикува следните ДВЕ рути на 3 различни начини (според спец.):
// 1) HTTP redirect преку browser-от на клиентот
// 2) Директен HTTP POST (push notification) од cPay-овиот сервер
// И двата пристигнуваат тука со истите параметри — затоа истата логика
// работи за двата случаи. За push повици враќаме чист 200 OK; за browser
// redirect, истата страница веднаш пренасочува кон апликацијата.
// ===================================================================
router.all('/cpay-ok', async (req, res) => {
  const data = { ...req.query, ...req.body };
  const intentId = Number(data.Details2);
  const cpayRef = data.cPayPaymentRef || null;

  try {
    if (!intentId) throw new Error('Недостасува референца на плаќањето (Details2).');
    // Алгоритамот е потврден со реален успешен тест (совпадна точно со
    // ReturnCheckSum од вистински cPay одговор) — сега сигурно блокираме
    // ако не се совпаѓа, бидejќи тоa значи реален обид за измама.
    if (!verifyReturnChecksum(data)) {
      throw new Error('ReturnCheckSum не се совпаѓа — можен обид за измама.');
    }

    const [[intent]] = await pool.query('SELECT * FROM payment_intents WHERE id = ?', [intentId]);
    if (!intent) throw new Error('Плаќањето не е пронајдено.');
    if (intent.status === 'completed') {
      return respondAndRedirect(res, '/app/#payment-success');
    }

    const paidAmount = Number(data.AmountToPay) / 100;
    if (Math.abs(paidAmount - Number(intent.amount)) > 1) {
      throw new Error('Износот на плаќањето не се совпаѓа со очекуваниот.');
    }

    const payload = typeof intent.payload === 'string' ? JSON.parse(intent.payload) : intent.payload;

    if (intent.kind === 'subscription') {
      await completeSubscriptionPurchase(intent, payload, cpayRef);
    } else if (intent.kind === 'individual_booking') {
      await completeIndividualBooking(intent, payload, cpayRef);
    } else if (intent.kind === 'installment') {
      await completeInstallmentPayment(intent, payload, cpayRef);
    }

    await pool.query(
      `UPDATE payment_intents SET status='completed', cpay_payment_ref=?, completed_at=NOW() WHERE id=?`,
      [cpayRef, intentId]
    );

    respondAndRedirect(res, '/app/#payment-success');
  } catch (err) {
    console.error('cPay OK handler error:', err);
    try { if (intentId) await pool.query(`UPDATE payment_intents SET status='failed' WHERE id=?`, [intentId]); } catch (e) {}
    respondAndRedirect(res, '/app/#payment-error');
  }
});

router.all('/cpay-fail', async (req, res) => {
  const data = { ...req.query, ...req.body };
  const intentId = Number(data.Details2);
  if (intentId) {
    try { await pool.query(`UPDATE payment_intents SET status='failed' WHERE id=?`, [intentId]); } catch (e) {}
  }
  respondAndRedirect(res, '/app/#payment-failed');
});

router.get('/status/:intentId', requireAuth, async (req, res) => {
  const [[intent]] = await pool.query('SELECT status FROM payment_intents WHERE id = ? AND user_id = ?', [req.params.intentId, req.user.id]);
  if (!intent) return res.status(404).json({ error: 'Не постои.' });
  res.json({ status: intent.status });
});

// ===================================================================
async function completeSubscriptionPurchase(intent, payload, cpayRef) {
  const { child_id, package_id, group_id, payment_plan } = payload;

  const [[pkg]] = await pool.query('SELECT * FROM packages WHERE id = ?', [package_id]);
  const [[child]] = await pool.query('SELECT full_name FROM children WHERE id = ?', [child_id]);
  const [[userRow]] = await pool.query('SELECT email FROM users WHERE id = ?', [intent.user_id]);

  await pool.query(
    `INSERT INTO purchases (student_id, package_id, group_id, payment_status, payment_provider_ref)
     VALUES (?, ?, ?, 'paid', ?)`,
    [child_id, package_id, group_id, cpayRef]
  );

  if (group_id) {
    await pool.query('INSERT INTO group_members (group_id, student_id) VALUES (?, ?)', [group_id, child_id]);
  }

  const schedule = payment_plan === 'trial'
    ? [{ number: 1, total: 1, amount: Number(pkg.price_mkd), offsetDays: 0 }]
    : buildAnnualSchedule(payment_plan, Number(pkg.price_mkd));

  const today = new Date();
  const firstDueDate = today.toISOString().slice(0, 10);

  const [subResult] = await pool.query(
    `INSERT INTO subscriptions (student_id, package_id, group_id, next_due_date, released, payment_plan)
     VALUES (?, ?, ?, ?, FALSE, ?)`,
    [child_id, package_id, group_id, firstDueDate, payment_plan]
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

  await pool.query('UPDATE subscriptions SET next_due_date = ? WHERE id = ?', [
    (nextPendingDueDate || new Date(today.getTime() + 365 * 86400000)).toISOString().slice(0, 10),
    subResult.insertId
  ]);

  const planLabel = { full: 'Целосно (1 уплата)', two: '2 полугодишни рати', eight: '8 месечни рати', trial: 'Пробен пакет (1 уплата)' }[payment_plan];
  const groupNoteHtml = !group_id
    ? '<p style="color:#B3555F;">Уплатата е примена — сега влези во апликацијата и избери термин (група) за твojot пакет.</p>' : '';

  await sendMail({
    to: userRow.email,
    subject: 'Потврда за уплата — PianoForte',
    html: `
      <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
        <h2>Плаќањето е успешно!</h2>
        <p>Пакет: <strong>${pkg.name}</strong></p>
        <p>Дете: <strong>${child.full_name}</strong></p>
        <p>План на плаќање: <strong>${planLabel}</strong></p>
        <p>Прва рата (платена сега): <strong>${schedule[0].amount} ден.</strong></p>
        ${groupNoteHtml}
        <p style="color:#888; font-size:13px; margin-top:20px;">Референца (cPay): ${cpayRef || '—'}</p>
      </div>
    `
  });
}

async function completeInstallmentPayment(intent, payload, cpayRef) {
  const { installment_id } = payload;

  const [[inst]] = await pool.query(
    `SELECT i.*, s.id AS subscription_id, u.email, c.full_name, p.name AS package_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN children c ON c.id = s.student_id
     JOIN users u ON u.id = c.parent_id
     JOIN packages p ON p.id = s.package_id
     WHERE i.id = ?`,
    [installment_id]
  );
  if (!inst) return;

  await pool.query(`UPDATE installments SET status = 'paid', paid_at = NOW() WHERE id = ?`, [installment_id]);

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
        <p>Дете: <strong>${inst.full_name}</strong></p>
        <p>Рата: <strong>${inst.installment_number}/${inst.total_installments}</strong></p>
        <p>Износ: <strong>${inst.amount} ден.</strong></p>
        ${nextPending ? `<p>Следна рата доспева на: <strong>${new Date(nextPending.due_date).toLocaleDateString('mk-MK')}</strong></p>` : '<p>Ова беше последната рата — целиот пакет е платен!</p>'}
      </div>
    `
  });
}

async function completeIndividualBooking(intent, payload, cpayRef) {
  const { child_id, professor_id, instrument, booking_date, start_time, availability_id } = payload;

  if (availability_id) {
    const [updateResult] = await pool.query(
      'UPDATE individual_availability SET is_booked = 1 WHERE id = ? AND is_booked = 0',
      [availability_id]
    );
    if (updateResult.affectedRows === 0) {
      // некој друг веќе го зазел истиот термин во меѓувреме — плаќањето сепак
      // помина кај cPay, па го бележиме резервацијата (админ треба рачно да
      // ja разреши колизијата и по потреба да врати пари), наместо тивко да
      // ja изгубиме уплатата.
      console.error(`Колизија: availability_id ${availability_id} веќе е зафатена, но плаќање помина (intent ${intent.id}).`);
    }
  }

  await pool.query(
    `INSERT INTO individual_bookings (student_id, professor_id, instrument, booking_date, start_time, amount, payment_provider_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [child_id, professor_id, instrument, booking_date, start_time, intent.amount, cpayRef]
  );
  const [[userRow]] = await pool.query('SELECT email FROM users WHERE id = ?', [intent.user_id]);
  const [[prof]] = await pool.query('SELECT full_name FROM users WHERE id = ?', [professor_id]);
  await sendMail({
    to: userRow.email,
    subject: 'Потврда за индивидуален час — PianoForte',
    html: `<div style="font-family:sans-serif;"><h2>Часот е закажан!</h2><p>Професор: <strong>${prof.full_name}</strong></p><p>Датум: <strong>${booking_date}</strong> во <strong>${start_time}</strong></p></div>`
  });
}

module.exports = router;
