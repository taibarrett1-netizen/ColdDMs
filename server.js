require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDailyStats, getRecentSent, setControl, getControl, alreadySent } = require('./database/db');
const { loadLeadsFromCSV } = require('./bot');
const { MESSAGES } = require('./config/messages');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;
const projectRoot = path.join(__dirname);
const envPath = path.join(projectRoot, '.env');
const leadsPath = path.join(projectRoot, process.env.LEADS_CSV || 'leads.csv');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: projectRoot, limits: { fileSize: 1024 * 1024 } });

// --- API: status & stats ---
app.get('/api/status', (req, res) => {
  const stats = getDailyStats();
  const paused = getControl('pause') === '1';
  let leadsTotal = 0;
  let leadsRemaining = 0;
  loadLeadsFromCSV(leadsPath).then((leads) => {
    leadsTotal = leads.length;
    leadsRemaining = leads.filter((u) => !alreadySent(u)).length;
    res.json({
      paused,
      todaySent: stats.total_sent,
      todayFailed: stats.total_failed,
      leadsTotal,
      leadsRemaining,
    });
  }).catch(() => {
    res.json({
      paused,
      todaySent: stats.total_sent,
      todayFailed: stats.total_failed,
      leadsTotal: 0,
      leadsRemaining: 0,
    });
  });
});

app.get('/api/stats', (req, res) => {
  res.json(getDailyStats());
});

app.get('/api/sent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  res.json(getRecentSent(limit));
});

// --- API: settings (.env) ---
const ENV_KEYS = [
  'INSTAGRAM_USERNAME',
  'INSTAGRAM_PASSWORD',
  'DAILY_SEND_LIMIT',
  'MIN_DELAY_MINUTES',
  'MAX_DELAY_MINUTES',
  'MAX_SENDS_PER_HOUR',
  'HEADLESS_MODE',
  'LEADS_CSV',
];

function readEnv() {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function writeEnv(obj) {
  const lines = [];
  for (const key of ENV_KEYS) {
    if (obj[key] !== undefined && obj[key] !== '') {
      lines.push(`${key}=${String(obj[key]).trim()}`);
    }
  }
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

app.get('/api/settings', (req, res) => {
  const env = readEnv();
  const safe = { ...env };
  if (safe.INSTAGRAM_PASSWORD) safe.INSTAGRAM_PASSWORD = '********';
  res.json(safe);
});

app.post('/api/settings', (req, res) => {
  const env = readEnv();
  const body = req.body || {};
  for (const key of ENV_KEYS) {
    if (body[key] !== undefined) {
      if (key === 'INSTAGRAM_PASSWORD' && body[key] === '********') continue;
      env[key] = body[key];
    }
  }
  writeEnv(env);
  res.json({ ok: true });
});

// --- API: messages (templates) ---
app.get('/api/messages', (req, res) => {
  res.json({ messages: MESSAGES });
});

app.post('/api/messages', (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const configPath = path.join(__dirname, 'config', 'messages.js');
  const content = `const MESSAGES = ${JSON.stringify(messages, null, 2)};\n\nfunction getRandomMessage() {\n  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)];\n}\n\nmodule.exports = { MESSAGES, getRandomMessage };\n`;
  fs.writeFileSync(configPath, content, 'utf8');
  res.json({ ok: true });
});

// --- API: leads ---
app.get('/api/leads', (req, res) => {
  if (!fs.existsSync(leadsPath)) {
    return res.json({ usernames: [], raw: '' });
  }
  const raw = fs.readFileSync(leadsPath, 'utf8');
  loadLeadsFromCSV(leadsPath).then((usernames) => {
    res.json({ usernames, raw });
  }).catch(() => res.json({ usernames: [], raw }));
});

app.post('/api/leads', (req, res) => {
  const { raw } = req.body || {};
  const lines = (raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const usernames = lines.map((u) => u.replace(/^@/, ''));
  const header = 'username\n';
  const body = usernames.join('\n') + (usernames.length ? '\n' : '');
  fs.writeFileSync(leadsPath, header + body, 'utf8');
  res.json({ ok: true, count: usernames.length });
});

app.post('/api/leads/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const raw = fs.readFileSync(req.file.path, 'utf8');
  fs.unlinkSync(req.file.path);
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0].toLowerCase();
  const start = first === 'username' || first === 'user' ? 1 : 0;
  const usernames = lines.slice(start).map((u) => u.replace(/^@/, '')).filter(Boolean);
  const header = 'username\n';
  const body = usernames.join('\n') + (usernames.length ? '\n' : '');
  fs.writeFileSync(leadsPath, header + body, 'utf8');
  res.json({ ok: true, count: usernames.length });
});

// --- API: bot control ---
app.post('/api/control/pause', (req, res) => {
  console.log('[API] Pause requested');
  setControl('pause', '1');
  console.log('[API] Pause set in DB');
  res.json({ ok: true, paused: true });
});

app.post('/api/control/resume', (req, res) => {
  console.log('[API] Resume requested');
  setControl('pause', '0');
  console.log('[API] Resume set in DB');
  res.json({ ok: true, paused: false });
});

// --- serve dashboard ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard at http://localhost:${PORT}`);
});
