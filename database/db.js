const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'bot.db');
const db = new Database(dbPath);

// Initialize schema
const schema = `
CREATE TABLE IF NOT EXISTS sent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'success'
);
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY,
  total_sent INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS control (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent_messages_username ON sent_messages(username);
CREATE INDEX IF NOT EXISTS idx_sent_messages_sent_at ON sent_messages(sent_at);
`;
db.exec(schema);

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function alreadySent(username) {
  const row = db.prepare('SELECT 1 FROM sent_messages WHERE username = ? LIMIT 1').get(normalizeUsername(username));
  return !!row;
}

function normalizeUsername(username) {
  const u = String(username).trim();
  return u.startsWith('@') ? u.slice(1) : u;
}

function logSentMessage(username, message, status = 'success') {
  const u = normalizeUsername(username);
  const date = getToday();
  db.prepare('INSERT INTO sent_messages (username, message, status) VALUES (?, ?, ?)').run(u, message, status);
  const existing = db.prepare('SELECT total_sent, total_failed FROM daily_stats WHERE date = ?').get(date);
  if (existing) {
    if (status === 'success') {
      db.prepare('UPDATE daily_stats SET total_sent = total_sent + 1 WHERE date = ?').run(date);
    } else {
      db.prepare('UPDATE daily_stats SET total_failed = total_failed + 1 WHERE date = ?').run(date);
    }
  } else {
    if (status === 'success') {
      db.prepare('INSERT INTO daily_stats (date, total_sent, total_failed) VALUES (?, 1, 0)').run(date);
    } else {
      db.prepare('INSERT INTO daily_stats (date, total_sent, total_failed) VALUES (?, 0, 1)').run(date);
    }
  }
}

function getDailyStats() {
  const date = getToday();
  const row = db.prepare('SELECT total_sent, total_failed FROM daily_stats WHERE date = ?').get(date);
  return row ? { date, total_sent: row.total_sent, total_failed: row.total_failed } : { date, total_sent: 0, total_failed: 0 };
}

function getRecentSent(limit = 50) {
  return db.prepare('SELECT username, message, sent_at, status FROM sent_messages ORDER BY sent_at DESC LIMIT ?').all(limit);
}

function setControl(key, value) {
  db.prepare('INSERT OR REPLACE INTO control (key, value) VALUES (?, ?)').run(key, String(value));
}

function getControl(key) {
  const row = db.prepare('SELECT value FROM control WHERE key = ?').get(key);
  return row ? row.value : null;
}

function resetDailyStats() {
  const date = getToday();
  db.prepare('DELETE FROM daily_stats WHERE date = ?').run(date);
  return date;
}

module.exports = {
  db,
  getToday,
  alreadySent,
  normalizeUsername,
  logSentMessage,
  getDailyStats,
  getRecentSent,
  setControl,
  getControl,
  resetDailyStats,
};
