# PianoForte — Backend (Node.js + Express + MySQL)

Вистински, runnable backend за оперативниот дел на PianoForte: автентикација,
групи, распоред, дигитален индекс (материјали) и пакети/плаќања.

## Инсталација

```bash
cd pianoforte-backend
npm install
cp .env.example .env
# отвори .env и пополни ги DB_HOST / DB_USER / DB_PASSWORD / JWT_SECRET
```

## База

Треба MySQL сервер (истиот каде што седи WordPress/WooCommerce работи одлично).

```bash
mysql -u root -p < schema.sql
```

Ова креира база `pianoforte` со сите табели и внесува 3 демо пакети.

## Стартување

```bash
npm run dev     # со nodemon, рестартира автоматски при промени
# или
npm start
```

Серверот слуша на `http://localhost:4000` (или PORT од `.env`).
Провери дали работи: `GET /health` → `{ ok: true }`.

## Структура

```
src/
  server.js              — влезна точка, ги монтира сите рути
  db.js                  — MySQL connection pool
  middleware/auth.js     — проверка на JWT + проверка на улога
  routes/auth.js         — register, login, /me
  routes/groups.js       — листа групи, додавање дете во група
  routes/schedule.js     — неделен распоред по групи
  routes/materials.js    — дигитален индекс (испраќање, статус)
  routes/packages.js     — листа на пакети
  routes/purchases.js    — купување пакет + резервација термин
```

## API накратко

| Метод | Патека                        | Улога            | Опис |
|-------|-------------------------------|------------------|------|
| POST  | /auth/register                | -                | Креира корисник |
| POST  | /auth/login                   | -                | Враќа JWT токен |
| GET   | /auth/me                      | сите             | Сопствен профил |
| GET   | /groups                       | сите             | Листа групи + членови |
| POST  | /groups                       | professor/admin  | Нова група |
| POST  | /groups/:id/members           | professor/admin  | Додава дете (проверува капацитет) |
| GET   | /schedule                     | сите             | Неделен распоред |
| POST  | /schedule                     | professor/admin  | Доделува термин на група |
| PUT   | /schedule/:id                 | professor/admin  | Ажурира белешка од час |
| POST  | /materials                    | professor/admin  | Испраќа материјал |
| GET   | /materials/:studentId         | сопствен/проф.   | Дигитален индекс |
| PUT   | /materials/:id/status         | сопствен/проф.   | queued→delivered→opened→done |
| GET   | /packages                     | сите             | Листа пакети |
| POST  | /purchases                    | student          | Купува пакет + резервира термин |
| GET   | /purchases/history/:studentId | сопствен/проф.   | Историја на купувања |

Сите рути освен `/auth/register` и `/auth/login` бараат хедер:
`Authorization: Bearer <token>`

## Важно за плаќањата (картичка)

Овој backend **никогаш не прима суров број на картичка, CVV или датум на
истек**. `/purchases` очекува `payment_method_id` — токен што го генерира
платежниот процесор (Stripe.js, CPay/NestPay hosted fields и сл.) директно
на страната на клиентот. Само токенот патува до нашиот сервер.

Во моментот `routes/purchases.js` симулира успешна трансакција
(`SIMULATED-<timestamp>`), означено јасно во коментар. Пред да одиш во
продукција, треба да:

1. Отвориш merchant акаунт кај платежен процесор (CPay/NestPay за МК банки,
   или Stripe меѓународно) — ова го правиш ти/училиштето, не јас.
2. На фронтендот (WordPress страницата) вклучиш нивна JS библиотека што
   го тркетира внесот на картичка и враќа `payment_method_id`.
3. Го замениш симулираниот дел во `purchases.js` со реален API повик кон
   процесорот (пример е коментиран во кодот).

## Следни чекори

- Rate limiting на `/auth/login` (спречува brute-force)
- Refresh токени (моментално JWT трае 7 дена, потоа бара повторна најава)
- Валидација на телото на request-ите со библиотека како `zod` или `joi`
- Тестови (Jest + supertest)
- Deploy на VPS (PM2 за process management, nginx како reverse proxy + SSL)
