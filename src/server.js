require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const groupsRoutes = require('./routes/groups');
const scheduleRoutes = require('./routes/schedule');
const materialsRoutes = require('./routes/materials');
const packagesRoutes = require('./routes/packages');
const purchasesRoutes = require('./routes/purchases');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/auth', authRoutes);
app.use('/groups', groupsRoutes);
app.use('/schedule', scheduleRoutes);
app.use('/materials', materialsRoutes);
app.use('/packages', packagesRoutes);
app.use('/purchases', purchasesRoutes);

// централен error handler — да не пропаѓаат необработени грешки како HTML стек трага
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Неочекувана грешка на серверот.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PianoForte backend работи на http://localhost:${PORT}`);
});
