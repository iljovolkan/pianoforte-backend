const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || 465;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.EMAIL_FROM || SMTP_USER;

let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true за порта 465 (SSL), false за 587 (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
}

/**
 * Испраќа email преку SMTP на cPanel хостингот. Ако SMTP не е конфигуриран
 * (пр. локален development), само логира во конзола наместо да пропадне —
 * така апликацијата продолжува да работи додека не се конфигурира email.
 */
async function sendMail({ to, subject, html }) {
  if (!transporter) {
    console.log(`[mailer] SMTP не е конфигуриран — прескокнато. До: ${to} | Наслов: ${subject}`);
    return { skipped: true };
  }
  try {
    await transporter.sendMail({ from: FROM_EMAIL, to, subject, html });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Грешка при испраќање email:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail };
