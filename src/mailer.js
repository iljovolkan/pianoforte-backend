// Email преку Brevo HTTP API (не SMTP) — SMTP портите (465/587) честопати се
// блокирани на cloud хостинг платформи (Railway, Render, Heroku итн.) заради
// спречување спам злоупотреба. HTTP API оди преку порта 443 (HTTPS), која
// никогаш не се блокира.

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.EMAIL_FROM;
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'PianoForte';

/**
 * Испраќа email преку Brevo. Ако BREVO_API_KEY не е поставен
 * (пр. локален development), само логира во конзола наместо да пропадне —
 * така апликацијата продолжува да работи додека не се конфигурира email.
 */
async function sendMail({ to, subject, html }) {
  if (!BREVO_API_KEY || !FROM_EMAIL) {
    console.log(`[mailer] Brevo не е конфигуриран — прескокнато. До: ${to} | Наслов: ${subject}`);
    return { skipped: true };
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        sender: { email: FROM_EMAIL, name: FROM_NAME },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('[mailer] Brevo грешка:', res.status, errText);
      return { sent: false, error: errText };
    }
    return { sent: true };
  } catch (err) {
    console.error('[mailer] Грешка при испраќање email:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail };
