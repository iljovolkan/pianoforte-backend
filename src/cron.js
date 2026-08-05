const cron = require('node-cron');
const pool = require('./db');
const { sendMail } = require('./mailer');

const GRACE_DAYS = 5;          // колку дена по рокот пред терминот да се ослободи
const REMINDER_DAYS_BEFORE = 3; // потсетник точно 3 дена пред рокот

/**
 * Дневна проверка на сите активни претплати:
 * 1. Испраќа email потсетник кога рокот доспева за REMINDER_DAYS_BEFORE дена
 * 2. Автоматски го ослободува терминот ако уплатата задоцнува повеќе од GRACE_DAYS
 *    дена, и известува по email
 */
async function runDailyMaintenance() {
  const [subs] = await pool.query(
    `SELECT s.*, u.email, u.full_name, p.name AS package_name, g.name AS group_name
     FROM subscriptions s
     JOIN users u ON u.id = s.student_id
     JOIN packages p ON p.id = s.package_id
     JOIN groups_table g ON g.id = s.group_id
     WHERE s.released = FALSE`
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let remindersSent = 0;
  let released = 0;

  for (const sub of subs) {
    const due = new Date(sub.next_due_date);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

    if (diffDays === REMINDER_DAYS_BEFORE) {
      await sendMail({
        to: sub.email,
        subject: `Потсетник — рата за ${sub.package_name} доспева наскоро`,
        html: `
          <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
            <h2>Твojata рата доспева за ${REMINDER_DAYS_BEFORE} дена</h2>
            <p>Здраво, ${sub.full_name}!</p>
            <p>Пакет: <strong>${sub.package_name}</strong></p>
            <p>Група: <strong>${sub.group_name}</strong></p>
            <p>Рок за плаќање: <strong>${due.toLocaleDateString('mk-MK')}</strong></p>
            <p style="color:#B3555F;">Ако не платиш до тогаш, терминот ти се ослободува и постои ризик при следна уплата да бидеш префрлен кај друг професор.</p>
          </div>
        `
      });
      remindersSent++;
    }

    if (diffDays < -GRACE_DAYS) {
      await pool.query('UPDATE subscriptions SET released = TRUE WHERE id = ?', [sub.id]);
      await pool.query('DELETE FROM group_members WHERE group_id = ? AND student_id = ?', [sub.group_id, sub.student_id]);
      await sendMail({
        to: sub.email,
        subject: 'Терминот ти е ослободен — задоцнета уплата',
        html: `
          <div style="font-family:sans-serif; max-width:480px; margin:0 auto;">
            <h2>Терминот ти е ослободен</h2>
            <p>Здраво, ${sub.full_name}.</p>
            <p>Поради задоцнета уплата за пакетот <strong>${sub.package_name}</strong>, местото во групата <strong>${sub.group_name}</strong> веќе не е резервирано за тебе.</p>
            <p>За да продолжиш, направи нова уплата од апликацијата. Имај предвид дека при нова резервација не е гарантирано дека ќе останеш кај истиот професор.</p>
          </div>
        `
      });
      released++;
    }
  }

  console.log(`[cron] Дневна проверка завршена — потсетници: ${remindersSent}, ослободени термини: ${released}`);
  return { remindersSent, released, checked: subs.length };
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
