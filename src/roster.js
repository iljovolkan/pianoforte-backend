// Увоз на постоечката Excel/Sheets листа (деца по професор + кои платиле).
// Се залепува текстот директно од табелата (колоните се одделени со TAB).

const CYR = { а:'a',б:'b',в:'v',г:'g',д:'d',ѓ:'g',е:'e',ж:'z',з:'z',ѕ:'z',и:'i',ј:'j',к:'k',л:'l',љ:'l',м:'m',н:'n',њ:'n',о:'o',п:'p',р:'r',с:'s',т:'t',ќ:'k',у:'u',ф:'f',х:'h',ц:'c',ч:'c',џ:'z',ш:'s' };

// Фонетски клуч: „Матеј Митевски“ и „Matej Mitevski“ даваат ист клуч.
function nameKey(name) {
  let s = String(name || '').toLowerCase().replace(/[*()]/g, ' ');
  s = s.replace(/[Ѐ-ӿ]/g, ch => CYR[ch] !== undefined ? CYR[ch] : '');
  s = s.replace(/sh|zh/g, m => (m === 'sh' ? 's' : 'z')).replace(/ch/g, 'c').replace(/kj/g, 'k').replace(/gj/g, 'g').replace(/dj|dz/g, 'z')
       .replace(/y/g, 'j').replace(/w/g, 'v').replace(/q/g, 'k').replace(/x/g, 'ks');
  s = s.replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.split(' ').filter(Boolean).sort().join(' ').replace(/(.)\1+/g, '$1');
}

const MONTHS = { 'СЕПТЕМВРИ': 9, 'ОКТОМВРИ': 10, 'НОЕМВРИ': 11, 'ДЕКЕМВРИ': 12, 'ЈАНУАРИ': 1, 'ФЕВРУАРИ': 2, 'МАРТ': 3, 'АПРИЛ': 4 };

function num(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).replace(/\s+/g, '').replace(/ден\.?/gi, '');
  if (!s || /^[-–—]+$/.test(s)) return null;
  s = s.replace(/,(?=\d{3}(\D|$))/g, '');   // 47,500 → 47500
  s = s.replace(',', '.');                  // 4,5 → 4.5
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const DEFAULT_COLS = { module: 1, full: 2, half1: 3, half2: 4, disc: 5, months: { '09': 6, '10': 7 } };

function parseHeader(cells) {
  const cols = { module: 1, full: null, half1: null, half2: null, disc: null, months: {} };
  cells.forEach((c, i) => {
    const u = String(c || '').trim().toUpperCase();
    if (!u || i === 0) return;
    if (u.startsWith('МОДУЛ')) cols.module = i;
    else if (u.startsWith('ФУЛ') || u.startsWith('ШКОЛ')) cols.full = i;
    else if (u.startsWith('1 ПОЛУ')) cols.half1 = i;
    else if (u.startsWith('2 ПОЛУ')) cols.half2 = i;
    else if (u.startsWith('ПОПУСТ')) cols.disc = i;
    else if (MONTHS[u]) cols.months[MONTHS[u]] = i;
  });
  if (cols.full === null) return null;
  return cols;
}

function isProfLine(cells) {
  const first = String(cells[0] || '').trim();
  if (!first || cells.slice(1).some(c => String(c || '').trim())) return false;
  const core = first.replace(/\(.*?\)/g, '').trim();
  return core.length >= 5 && !/\d/.test(core) && core === core.toUpperCase() && /[Ѐ-ӿA-Z]/.test(core);
}

// startYear = календарска година во која почнува учебната година (за септември)
function parseRoster(text, startYear) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let cur = null, cols = null;
  for (const raw of lines) {
    const cells = raw.split('\t');
    if (!cells.some(c => String(c || '').trim())) continue;
    const first = String(cells[0] || '').trim();
    if (/^ИМЕ\s/i.test(first)) { const h = parseHeader(cells); if (h) cols = h; continue; }
    if (isProfLine(cells)) {
      const note = (first.match(/\((.*?)\)/) || [])[1] || null;
      cur = { professor_name: first.replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim(), note, students: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const c = cols || null;
    const useCols = c || { ...DEFAULT_COLS, months: { 9: 6, 10: 7 } };
    // ако колоната „модул“ недостасува (бројка веднаш по името) → поместување за 1
    let shift = 0;
    if (num(cells[1]) !== null && String(cells[1]).trim() !== '' ) shift = -1;
    const at = (idx) => (idx === null || idx === undefined ? undefined : cells[idx + shift]);
    const name = first.replace(/^\*+/, '').trim();
    if (!name) continue;
    const full = num(at(useCols.full));
    const months = {};
    for (const [mn, idx] of Object.entries(useCols.months)) {
      const v = num(at(idx));
      if (v !== null && v > 0) {
        const y = Number(mn) >= 9 ? startYear : startYear + 1;
        months[`${y}-${String(mn).padStart(2, '0')}`] = v;
      }
    }
    const moduleCell = shift === 0 ? String(cells[useCols.module] || '').trim() : '';
    const disc = String(at(useCols.disc) || '').trim();
    cur.students.push({
      full_name: name.replace(/\s+/g, ' '),
      star: /^\*/.test(first),
      module: moduleCell || null,
      full_price: full === null ? 0 : full,
      half1: num(at(useCols.half1)), half2: num(at(useCols.half2)),
      discount: disc || null,
      payments: months
    });
  }
  return out.filter(p => p.students.length);
}

// Во кој месец е учебната година: септември=0 … април=7
function monthIdx(ym) {
  const m = Number(String(ym).slice(5, 7));
  if (m >= 9) return m - 9;
  if (m <= 4) return m + 3;
  return 7;
}

// Очекувано плаќање до даден месец: цена × (месеци до тогаш)/8
function expectedThrough(fullPrice, ym) {
  return Math.round(Number(fullPrice) * Math.min(monthIdx(ym) + 1, 8) / 8);
}

module.exports = { nameKey, parseRoster, expectedThrough, monthIdx };
