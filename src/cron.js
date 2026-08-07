const cron = require('node-cron');
const pool = require('./db');
const { sendMail } = require('./mailer');

const GRACE_DAYS = 5;          // колку дена по рокот пред терминот да се ослободи
const REMINDER_DAYS_BEFORE = 3; // потсетник точно 3 дена пред рокот

/**
 * Дневна проверка на сите чекачки рати:
 * 1. Испраќа email потсетник кога рата доспева за REMINDER_DAYS_BEFORE дена
 * 2. Автоматски го ослободува терминот ако некоја рата задоцнува повеќе од
 *    GRACE_DAYS дена — ги откажува и преостанатите чекачки рати, и известува
 */
async function runDailyMaintenance() {
  const [installments] = await pool.query(
    `SELECT i.*, s.id AS subscription_id, s.student_id, s.group_id, s.released AS sub_released,
            u.email, u.full_name, p.name AS package_name, g.name AS group_name
     FROM installments i
     JOIN subscriptions s ON s.id = i.subscription_id
     JOIN users u ON u.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     JOIN groups_table g ON g.id = s.group_id
     WHERE i.status = 'pending' AND s.released = FALSE AND s.payment_plan != 'trial'`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let remindersSent = 0;
  let released = 0;

  for (const inst of installments) {
    const due = new Date(inst.due_date);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

    if (diffDays === REMINDER_DAYS_BEFORE) {
      await sendMail({
        to: inst.email,
        subject: `Потсетник — рата ${inst.installment_number}/${inst.total_installments} доспева наскоро`,
        html: `
          <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
            <h2>Твojata рата доспева за ${REMINDER_DAYS_BEFORE} дена</h2>
            <p>Здраво, ${inst.full_name}!</p>
            <p>Пакет: <strong>${inst.package_name}</strong></p>
            <p>Група: <strong>${inst.group_name}</strong></p>
            <p>Рата: <strong>${inst.installment_number}/${inst.total_installments}</strong> — <strong>${inst.amount} ден.</strong></p>
            <p>Рок за плаќање: <strong>${due.toLocaleDateString('mk-MK')}</strong></p>
            <p style="color:#B3555F;">Ако не платиш до тогаш, терминот ти се ослободува и постои ризик при следна уплата да бидеш префрлен кај друг професор.</p>
          </div>
        `
      });
      remindersSent++;
    }

    if (diffDays < -GRACE_DAYS) {
      // ослободи го терминот целосно — ja означуваме претплатата и сите нејзини
      // преостанати чекачки рати како 'released'
      await pool.query('UPDATE subscriptions SET released = TRUE WHERE id = ?', [inst.subscription_id]);
      await pool.query(
        `UPDATE installments SET status = 'released' WHERE subscription_id = ? AND status = 'pending'`,
        [inst.subscription_id]
      );
      await pool.query('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [inst.group_id, inst.student_id]);

      await sendMail({
        to: inst.email,
        subject: 'Терминот ти е ослободен — задоцнета уплата',
        html: `
          <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
            <h2>Терминот ти е ослободен</h2>
            <p>Здраво, ${inst.full_name}.</p>
            <p>Поради задоцнета рата (${inst.installment_number}/${inst.total_installments}) за пакетот <strong>${inst.package_name}</strong>, местото во групата <strong>${inst.group_name}</strong> веќе не е резервирано за тебе.</p>
            <p>Преостанатите рати се откажани. За да продолжиш, направи нова уплата од апликацијата — имај предвид дека не е гарантирано дека ќе останеш кај истиот професор.</p>
          </div>
        `
      });
      released++;
    }
  }

  console.log(`[cron] Дневна проверка завршена — потсетници: ${remindersSent}, ослободени термини: ${released}`);
  return { remindersSent, released, checked: installments.length };
}

/**
 * Закажува дневно извршување во 08:00 (сервер timezone — Railway стандардно UTC).
 */
function startCronJobs() {
  cron.schedule('0 8 * * *', () => {
    runDailyMaintenance().catch(err => console.error('[cron] Грешка при извршување:', err));
  });
  console.log('[cron] Закажана дневна задача (08:00).');
}

module.exports = { startCronJobs, runDailyMaintenance };
