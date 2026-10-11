const pool = require('./db');
const { sendMail } = require('./mailer');

// Податоци за издавачот (училиштето) — се менуваат преку Railway променливи
const SCHOOL = {
  name: process.env.SCHOOL_LEGAL_NAME || 'PianoForte — музичко училиште',
  address: process.env.SCHOOL_ADDRESS || 'Скопје, Македонија',
  taxId: process.env.SCHOOL_TAX_ID || '',        // ЕДБ / ЕМБС
  bank: process.env.SCHOOL_BANK_ACCOUNT || '',   // жиро сметка
  phone: process.env.SCHOOL_PHONE || '',
  email: process.env.SCHOOL_EMAIL || process.env.EMAIL_FROM || 'info@pianoforte.edu.mk',
  web: 'www.pianoforte.edu.mk',
  vatNote: process.env.SCHOOL_VAT_NOTE || '' // пр. „Ослободено од ДДВ согласно ...“ — го дава сметководителот
};

const METHOD_LABELS = {
  card: 'Картичка (онлајн, cPay)',
  cash: 'Готовина',
  bank: 'Банкарска уплата',
  other: 'Друго'
};

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n) => Number(n || 0).toLocaleString('mk-MK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ден.';
const dateMk = (d) => {
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}.${String(x.getMonth() + 1).padStart(2, '0')}.${x.getFullYear()}`;
};

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const [[row]] = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number, 9) AS UNSIGNED)), 0) AS m
     FROM invoices WHERE invoice_number LIKE ?`, [`PF-${year}-%`]
  );
  return `PF-${year}-${String(Number(row.m) + 1).padStart(5, '0')}`;
}

/** Издава и архивира фактура. Враќа { id, invoice_number } или null. */
async function issueInvoice({ student_id, student_name, parent_email, package_name, amount, cpay_ref, payment_method, installment_id, issued_at }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const invoiceNumber = await nextInvoiceNumber();
      const [r] = await pool.query(
        `INSERT INTO invoices (student_id, student_name, parent_email, package_name, amount, cpay_ref, invoice_number, payment_method, installment_id, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [student_id || null, student_name, parent_email, package_name, amount, cpay_ref || null, invoiceNumber,
         payment_method || 'card', installment_id || null, issued_at || new Date()]
      );
      return { id: r.insertId, invoice_number: invoiceNumber };
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') continue;
      console.error('issueInvoice error:', e);
      return null;
    }
  }
  return null;
}

/** Комплетна HTML фактура (за печатење и за email). */
function renderInvoiceHtml(inv) {
  const method = METHOD_LABELS[inv.payment_method || 'card'] || esc(inv.payment_method);
  return `<!doctype html>
<html lang="mk"><head><meta charset="utf-8"><title>Фактура ${esc(inv.invoice_number)}</title>
<style>@media print{body{margin:0}.noprint{display:none}}</style></head>
<body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#2b2b2b;">
<div style="max-width:720px;margin:0 auto;padding:24px;">
 <div style="background:#fff;border:1px solid #e3ddd3;border-radius:6px;padding:36px;">
  <table width="100%" cellspacing="0" cellpadding="0"><tr>
   <td style="vertical-align:top;">
    <div style="font-size:26px;font-weight:700;letter-spacing:.5px;color:#7a2e3a;">PianoForte</div>
    <div style="font-size:12px;color:#666;line-height:1.6;margin-top:6px;">
     ${esc(SCHOOL.name)}<br>${esc(SCHOOL.address)}
     ${SCHOOL.taxId ? `<br>ЕДБ/ЕМБС: ${esc(SCHOOL.taxId)}` : ''}
     ${SCHOOL.bank ? `<br>Жиро сметка: ${esc(SCHOOL.bank)}` : ''}
     ${SCHOOL.phone ? `<br>Тел: ${esc(SCHOOL.phone)}` : ''}
     <br>${esc(SCHOOL.email)} · ${esc(SCHOOL.web)}
    </div>
   </td>
   <td style="vertical-align:top;text-align:right;">
    <div style="font-size:20px;font-weight:700;">ФАКТУРА</div>
    <div style="font-size:14px;margin-top:6px;">Бр. <strong>${esc(inv.invoice_number)}</strong></div>
    <div style="font-size:13px;color:#666;margin-top:2px;">Датум: ${dateMk(inv.issued_at)}</div>
   </td>
  </tr></table>
  ${inv.cancelled_at ? `<div style="margin:16px 0 0;padding:10px 14px;border:2px solid #b3262e;color:#b3262e;font-weight:700;text-align:center;border-radius:4px;">СТОРНИРАНА ФАКТУРА${inv.cancel_reason ? ' — ' + esc(inv.cancel_reason) : ''} (${dateMk(inv.cancelled_at)})</div>` : ''}
  <hr style="border:none;border-top:2px solid #7a2e3a;margin:22px 0;">
  <div style="font-size:12px;color:#888;text-transform:uppercase;letter-spacing:1px;">Купувач</div>
  <div style="font-size:14px;line-height:1.6;margin:4px 0 22px;">
   ${inv.parent_name ? `Име и презиме: <strong>${esc(inv.parent_name)}</strong><br>` : ''}
   Email: ${esc(inv.parent_email)}<br>
   Ученик: <strong>${esc(inv.student_name)}</strong>
  </div>
  <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;">
   <thead><tr style="background:#f4f1ec;">
    <th align="left" style="padding:10px;border-bottom:1px solid #ddd;">Опис на услугата</th>
    <th align="right" style="padding:10px;border-bottom:1px solid #ddd;width:150px;">Износ</th></tr></thead>
   <tbody><tr>
    <td style="padding:14px 10px;border-bottom:1px solid #eee;">${esc(inv.package_name)}</td>
    <td align="right" style="padding:14px 10px;border-bottom:1px solid #eee;">${money(inv.amount)}</td></tr></tbody>
   <tfoot><tr>
    <td align="right" style="padding:14px 10px;font-weight:700;">ВКУПНО ПЛАТЕНО</td>
    <td align="right" style="padding:14px 10px;font-weight:700;font-size:16px;">${money(inv.amount)}</td></tr></tfoot>
  </table>
  <div style="font-size:13px;line-height:1.7;margin-top:18px;color:#444;">
   Датум на уплата/услуга: <strong>${dateMk(inv.issued_at)}</strong><br>
   Начин на плаќање: <strong>${method}</strong><br>
   ${inv.cpay_ref ? `Референца на трансакција (cPay): <strong>${esc(inv.cpay_ref)}</strong><br>` : ''}
   Статус: ${inv.cancelled_at ? '<strong style="color:#b3262e;">СТОРНИРАНА</strong>' : '<strong style="color:#2f7d4f;">ПЛАТЕНО</strong>'}
   ${SCHOOL.vatNote ? `<br><span style="font-size:12px;color:#666;">${esc(SCHOOL.vatNote)}</span>` : ''}
  </div>
  <hr style="border:none;border-top:1px solid #e3ddd3;margin:26px 0 14px;">
  <div style="font-size:11px;color:#888;line-height:1.6;">
   Ви благодариме што го избравте PianoForte. За прашања во врска со оваа фактура пишете ни на ${esc(SCHOOL.email)}.
  </div>
 </div>
</div></body></html>`;
}

async function getInvoice(id) {
  const [[inv]] = await pool.query(
    `SELECT i.*, (SELECT u.full_name FROM users u WHERE u.email = i.parent_email LIMIT 1) AS parent_name
     FROM invoices i WHERE i.id = ?`, [id]);
  return inv || null;
}

async function emailInvoice(inv) {
  if (!inv || !inv.parent_email) return false;
  const r = await sendMail({
    to: inv.parent_email,
    subject: `Фактура ${inv.invoice_number} — PianoForte`,
    html: renderInvoiceHtml(inv)
  });
  if (!r || r.sent !== true) return false;
  await pool.query('UPDATE invoices SET last_emailed_at = NOW() WHERE id = ?', [inv.id]).catch(() => {});
  return true;
}

module.exports = { issueInvoice, renderInvoiceHtml, getInvoice, emailInvoice, METHOD_LABELS };
