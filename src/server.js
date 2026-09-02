require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const groupsRoutes = require('./routes/groups');
const scheduleRoutes = require('./routes/schedule');
const materialsRoutes = require('./routes/materials');
const packagesRoutes = require('./routes/packages');
const purchasesRoutes = require('./routes/purchases');
const adminRoutes = require('./routes/admin');
const subscriptionsRoutes = require('./routes/subscriptions');
const installmentsRoutes = require('./routes/installments');
const individualBookingsRoutes = require('./routes/individual-bookings');
const childrenRoutes = require('./routes/children');
const financeRoutes = require('./routes/finance');
const paymentsRoutes = require('./routes/payments');
const { startCronJobs } = require('./cron');

const app = express();

// Railway (и слични хостинзи) работат преку reverse proxy — без ова, Express
// не ja гледа вистинската IP адреса на клиентот (сите барања изгледаат исто),
// што го прави rate limiting-от неточен/неактивен.
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // потребно за cPay callback (испраќа form-urlencoded)

// /payments рутите се РЕГИСТРИРАНИ ПРЕД CORS — cPay го повикува
// /payments/cpay-ok и /payments/cpay-fail директно од cpay.com.mk
// (redirect на browser-от НА КОРИСНИКОТ и/или server-to-server push),
// што CORS проверката инаку ja блокираше (cpay.com.mk не е во ALLOWED_ORIGINS
// и никогаш не треба да биде, бидejќи тoj домен не е наш frontend).
// /payments/init-* рутите не страдаат од ова бидejќи и онака се повикуваат
// од истиот домен (app.pianoforte.edu.mk), па CORS не им е ниту потребен.
app.use('/payments', paymentsRoutes);

// CORS — дозволени се само нашите вистински домени (не "било кој сајт")
const ALLOWED_ORIGINS = [
  'https://app.pianoforte.edu.mk',
  'https://pianoforte-backend-production.up.railway.app'
];
app.use(cors({
  origin: (origin, callback) => {
    // барања без Origin header (пр. мобилни апликации, curl, Postman) се дозволени —
    // само browser cross-origin барања од непознат сајт се одбиваат
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

// Маркетинг страниците (Почетна/За нас/Инструменти/Блог/Контакт) — на root
app.use(express.static(path.join(__dirname, '..', 'public')));

// Операциската апликација (логирање, материјали, наплата...) — на /app
app.use('/app', express.static(path.join(__dirname, '..', 'public', 'app')));
app.get('/app/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'app', 'index.html'));
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/groups', groupsRoutes);
app.use('/schedule', scheduleRoutes);
app.use('/materials', materialsRoutes);
app.use('/packages', packagesRoutes);
app.use('/purchases', purchasesRoutes);
app.use('/admin', adminRoutes);
app.use('/subscriptions', subscriptionsRoutes);
app.use('/installments', installmentsRoutes);
app.use('/individual-bookings', individualBookingsRoutes);
app.use('/children', childrenRoutes);
app.use('/finance', financeRoutes);

// централен error handler — да не пропаѓаат необработени грешки како HTML стек трага
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Неочекувана грешка на серверот.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PianoForte backend работи на http://localhost:${PORT}`);
  startCronJobs();
});
