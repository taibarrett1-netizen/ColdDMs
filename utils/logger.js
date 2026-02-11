const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logPath = path.join(logsDir, 'bot.log');
const errorPath = path.join(logsDir, 'error.log');

function timestamp() {
  return new Date().toISOString();
}

function write(level, msg) {
  const line = `[${timestamp()}] [${level}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logPath, line);
  } catch (e) {}
}

function log(msg) {
  write('INFO', msg);
}

function warn(msg) {
  write('WARN', msg);
}

function error(msg, err) {
  write('ERROR', msg);
  const errLine = err && err.stack ? `${msg}\n${err.stack}\n` : `${msg}\n`;
  try {
    fs.appendFileSync(errorPath, `[${timestamp()}] ${errLine}`);
  } catch (e) {}
}

module.exports = { log, warn, error };
