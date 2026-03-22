/**
 * PulseAudio pipe-source setup for voice notes.
 *
 * Replaces the old null-sink + monitor approach. Uses module-pipe-source so that
 * a virtual microphone exists from the start — getUserMedia sees a valid, live
 * device immediately, and clicking the IG mic icon starts recording right away.
 *
 * At startup: unload any old null-sink, create pipe-source, set as default.
 * Per voice note: ffmpeg writes raw PCM into the pipe (see voice-note-audio.js).
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const VOICE_NOTE_SOURCE_NAME = (process.env.VOICE_NOTE_SOURCE_NAME || 'ColdDMsVoice').trim();
const VOICE_NOTE_PIPE_PATH = process.env.VOICE_NOTE_PIPE_PATH || '/tmp/cold-dms-voice.pipe';
const VOICE_USE_PIPE_SOURCE = process.env.VOICE_USE_PIPE_SOURCE !== 'false' && process.env.VOICE_USE_PIPE_SOURCE !== '0';

let pipeSourceSetupDone = false;

/** Background `cat /dev/zero` — holds the fifo write end open with silence so PulseAudio can load module-pipe-source (FIFO needs both ends). */
let silenceFillerChild = null;

/**
 * Start feeding silence into the pipe (required before load-module; keep running between voice sends).
 * Killed briefly while ffmpeg writes (see pausePipeSilenceFiller).
 */
function startPipeSilenceFiller(pipePath, logger) {
  if (silenceFillerChild && !silenceFillerChild.killed) return;
  try {
    const safe = pipePath.replace(/'/g, "'\\''");
    silenceFillerChild = spawn('bash', ['-c', `exec cat /dev/zero > '${safe}'`], {
      stdio: 'ignore',
    });
    silenceFillerChild.on('error', (e) => {
      if (logger) logger.warn(`[voice] silence filler spawn error: ${e.message}`);
    });
    silenceFillerChild.on('exit', (code, sig) => {
      silenceFillerChild = null;
      if (code && code !== 0 && logger) {
        logger.warn(`[voice] silence filler exited code=${code} signal=${sig}`);
      }
    });
  } catch (e) {
    if (logger) logger.warn(`[voice] startPipeSilenceFiller: ${e.message}`);
  }
}

function killPipeSilenceFiller() {
  if (!silenceFillerChild) return;
  try {
    silenceFillerChild.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  silenceFillerChild = null;
}

/** Call before ffmpeg opens the pipe for writing. */
function pausePipeSilenceFiller() {
  killPipeSilenceFiller();
}

/** Call after ffmpeg stops so the virtual mic keeps getting silence until the next send. */
function resumePipeSilenceFiller(logger) {
  startPipeSilenceFiller(VOICE_NOTE_PIPE_PATH, logger);
}

/** Build env so PulseAudio clients (pactl, Chromium) find the server. PM2 often lacks XDG_RUNTIME_DIR. */
function pactlEnv() {
  const env = { ...process.env };
  if (env.PULSE_SERVER) return env;
  const rt = env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' && process.getuid() === 0 ? '/run/user/0' : null);
  if (rt) {
    env.XDG_RUNTIME_DIR = rt;
    env.PULSE_RUNTIME_PATH = rt;
    env.PULSE_SERVER = `unix:${rt}/pulse/native`;
  }
  return env;
}

/**
 * Find and unload PulseAudio modules by name and argument match.
 * @param {string} pulseServer - PULSE_SERVER value for pactl
 * @param {string} moduleName - e.g. 'module-null-sink' or 'module-pipe-source'
 * @param {string} argMatch - e.g. 'sink_name=ColdDMsVoice' or 'source_name=ColdDMsVoice'
 * @returns {boolean} true if something was unloaded
 */
function unloadPulseModuleIfPresent(pulseServer, moduleName, argMatch) {
  try {
    const list = spawnSync('bash', ['-c', `PULSE_SERVER="${pulseServer}" pactl list modules`], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (list.status !== 0 || !list.stdout) return false;
    const blocks = list.stdout.split('\n\n');
    for (const block of blocks) {
      const nameLine = block.match(/Name:\s*(.+)/);
      const argLine = block.match(/Argument:\s*(.+)/);
      if (!nameLine || !argLine) continue;
      const name = nameLine[1].trim();
      const arg = argLine[1].trim();
      if (name === moduleName && arg.includes(argMatch)) {
        const indexMatch = block.match(/Module #(\d+)/);
        if (indexMatch) {
          const idx = indexMatch[1];
          spawnSync('bash', ['-c', `PULSE_SERVER="${pulseServer}" pactl unload-module ${idx}`], {
            encoding: 'utf8',
            timeout: 5000,
          });
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Ensure the named pipe (fifo) exists. Create it if missing.
 */
function ensurePipeExists(pipePath) {
  try {
    if (fs.existsSync(pipePath)) {
      const stat = fs.statSync(pipePath);
      if (!stat.isFIFO()) {
        fs.unlinkSync(pipePath);
        fs.mkdirSync(path.dirname(pipePath), { recursive: true });
        spawnSync('mkfifo', [pipePath], { encoding: 'utf8' });
      }
    } else {
      fs.mkdirSync(path.dirname(pipePath), { recursive: true });
      spawnSync('mkfifo', [pipePath], { encoding: 'utf8' });
    }
    return fs.existsSync(pipePath);
  } catch {
    return false;
  }
}

/**
 * One-time setup: unload old null-sink, load pipe-source, set default source.
 * Call at bot/process startup before the first browser launch that may use voice.
 *
 * @param {{ log?: Function, warn?: Function } | null} [logger]
 * @returns {{ ok: boolean; pipePath: string; error?: string }}
 */
function ensureVoicePipeSource(logger = null) {
  if (!VOICE_USE_PIPE_SOURCE) {
    return { ok: false, pipePath: VOICE_NOTE_PIPE_PATH, error: 'VOICE_USE_PIPE_SOURCE disabled' };
  }

  if (pipeSourceSetupDone) {
    return { ok: true, pipePath: VOICE_NOTE_PIPE_PATH };
  }

  const env = pactlEnv();
  const pulseServer = env.PULSE_SERVER || 'unix:/run/user/0/pulse/native';
  const testConn = spawnSync('bash', ['-c', `PULSE_SERVER="${pulseServer}" pactl info`], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (testConn.status !== 0) {
    const hint =
      env.PULSE_SERVER ||
      env.XDG_RUNTIME_DIR ||
      '(none set — set PULSE_SERVER=unix:/run/user/0/pulse/native in .env)';
    const err = `[voice] pactl cannot connect to PulseAudio. PULSE_SERVER/XDG_RUNTIME_DIR=${hint}. Start PulseAudio: XDG_RUNTIME_DIR=/run/user/0 pulseaudio -D`;
    if (logger) logger.warn(err);
    return { ok: false, pipePath: VOICE_NOTE_PIPE_PATH, error: err };
  }

  try {
    // 1. Unload any old module-null-sink (ColdDMsVoice sink from previous setup)
    const unloadedSink = unloadPulseModuleIfPresent(pulseServer, 'module-null-sink', `sink_name=${VOICE_NOTE_SOURCE_NAME}`);
    if (unloadedSink && logger) {
      logger.log(`[voice] Unloaded old null-sink (${VOICE_NOTE_SOURCE_NAME})`);
    }

    // 2. Unload any existing pipe-source so we get a clean reload
    const unloadedSource = unloadPulseModuleIfPresent(pulseServer, 'module-pipe-source', `source_name=${VOICE_NOTE_SOURCE_NAME}`);
    if (unloadedSource && logger) {
      logger.log(`[voice] Unloaded old pipe-source (${VOICE_NOTE_SOURCE_NAME})`);
    }

    // 3. Ensure the fifo exists
    if (!ensurePipeExists(VOICE_NOTE_PIPE_PATH)) {
      const err = `[voice] Failed to create fifo: ${VOICE_NOTE_PIPE_PATH}`;
      if (logger) logger.warn(err);
      return { ok: false, pipePath: VOICE_NOTE_PIPE_PATH, error: err };
    }

    // 3b. FIFO deadlock fix: Pulse opens read during load-module and blocks until a writer exists.
    // Start a background writer first (silence), then pactl load-module can complete.
    startPipeSilenceFiller(VOICE_NOTE_PIPE_PATH, logger);
    spawnSync('sleep', ['0.25'], { encoding: 'utf8' });

    // 4. Load module-pipe-source (virtual mic that reads from the pipe)
    // Use explicit shell env to avoid PM2 spawn env issues ("Connection terminated")
    const loadCmd = `PULSE_SERVER="${pulseServer}" pactl load-module module-pipe-source source_name=${VOICE_NOTE_SOURCE_NAME} file=${VOICE_NOTE_PIPE_PATH} format=s16le rate=48000 channels=2`;
    const load = spawnSync('bash', ['-c', loadCmd], { encoding: 'utf8', timeout: 10000 });

    if (load.status !== 0) {
      killPipeSilenceFiller();
      const err = `[voice] pactl load-module failed: ${load.stderr || load.error || 'unknown'}`;
      if (logger) logger.warn(err);
      return { ok: false, pipePath: VOICE_NOTE_PIPE_PATH, error: err };
    }

    const moduleIndex = (load.stdout || '').trim();
    if (logger) logger.log(`[voice] Loaded pipe-source ${VOICE_NOTE_SOURCE_NAME} (module ${moduleIndex})`);

    // 5. Set as default source so Chromium's getUserMedia uses it without PULSE_SOURCE
    const setDefault = spawnSync('bash', [
      '-c',
      `PULSE_SERVER="${pulseServer}" pactl set-default-source ${VOICE_NOTE_SOURCE_NAME}`,
    ], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (setDefault.status !== 0 && logger) {
      logger.warn(`[voice] pactl set-default-source failed: ${setDefault.stderr || ''}`);
    } else if (logger) {
      logger.log(`[voice] Default source set to ${VOICE_NOTE_SOURCE_NAME}`);
    }

    pipeSourceSetupDone = true;
    return { ok: true, pipePath: VOICE_NOTE_PIPE_PATH };
  } catch (e) {
    const err = `[voice] Pipe-source setup error: ${e && e.message ? e.message : String(e)}`;
    if (logger) logger.warn(err);
    return { ok: false, pipePath: VOICE_NOTE_PIPE_PATH, error: err };
  }
}

/**
 * Get the pipe path. Ensure setup has run first (call ensureVoicePipeSource).
 */
function getVoiceNotePipePath() {
  return VOICE_NOTE_PIPE_PATH;
}

/** True if pipe-source setup succeeded (pactl load-module worked). */
function isPipeSourceReady() {
  return pipeSourceSetupDone;
}

/** Env for Chromium so getUserMedia finds PulseAudio (same as pactl). */
function getPulseClientEnv() {
  return pactlEnv();
}

module.exports = {
  ensureVoicePipeSource,
  getVoiceNotePipePath,
  getPulseClientEnv,
  isPipeSourceReady,
  pausePipeSilenceFiller,
  resumePipeSilenceFiller,
  VOICE_NOTE_SOURCE_NAME,
  VOICE_NOTE_PIPE_PATH,
};
