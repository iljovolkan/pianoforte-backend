// Распоред на рати според преостанатите месеци од учебната година.
// Учебната година има 8 месечни уплати (септември–април). Кој се запишува
// подоцна плаќа помалку рати: во октомври остануваат 7, во ноември 6 итн.
const SCHOOL_MONTHS = 8;
const FULL_YEAR_DISCOUNT = 0.05;
const HALF_YEAR_DISCOUNT = 0.03;

// Колку месечни уплати остануваат (тековниот месец се брои како прв).
// мај–август = следната година тукушто почнува → цели 8.
function schoolMonthsLeft(date) {
  const d = date ? new Date(date) : new Date();
  const m = d.getMonth(); // 0=јануари
  let idx;
  if (m >= 8) idx = m - 8;        // сеп(8)→0 … дек(11)→3
  else if (m <= 3) idx = m + 4;   // јан(0)→4 … апр(3)→7
  else return SCHOOL_MONTHS;      // мај–август
  return Math.max(1, SCHOOL_MONTHS - idx);
}

function buildAnnualSchedule(plan, monthlyPrice, monthsLeft) {
  const m = Math.max(1, Math.min(SCHOOL_MONTHS, Number(monthsLeft) || SCHOOL_MONTHS));
  if (m === 1) return [{ number: 1, total: 1, amount: Math.round(monthlyPrice), offsetDays: 0 }];
  if (plan === 'full') {
    return [{ number: 1, total: 1, amount: Math.round(monthlyPrice * m * (1 - FULL_YEAR_DISCOUNT)), offsetDays: 0 }];
  }
  if (plan === 'two') {
    const m1 = Math.ceil(m / 2), m2 = m - m1;
    return [
      { number: 1, total: 2, amount: Math.round(monthlyPrice * m1 * (1 - HALF_YEAR_DISCOUNT)), offsetDays: 0 },
      { number: 2, total: 2, amount: Math.round(monthlyPrice * m2 * (1 - HALF_YEAR_DISCOUNT)), offsetDays: m1 * 30 + 30 }
    ];
  }
  const out = [];
  for (let i = 0; i < m; i++) out.push({ number: i + 1, total: m, amount: Math.round(monthlyPrice), offsetDays: i * 30 });
  return out;
}

// Посебен план: прва рата (може да е посебна цена) + останатите по месечна цена.
function buildCustomSchedule(firstAmount, monthlyAmount, total) {
  const n = Math.max(1, Math.min(SCHOOL_MONTHS, Number(total) || 1));
  const first = Math.round(Number(firstAmount) > 0 ? Number(firstAmount) : Number(monthlyAmount));
  const rest = Math.round(Number(monthlyAmount));
  const out = [];
  for (let i = 0; i < n; i++) out.push({ number: i + 1, total: n, amount: i === 0 ? first : rest, offsetDays: i * 30 });
  return out;
}

module.exports = { SCHOOL_MONTHS, FULL_YEAR_DISCOUNT, HALF_YEAR_DISCOUNT, schoolMonthsLeft, buildAnnualSchedule, buildCustomSchedule };
