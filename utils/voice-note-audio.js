const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const { getVoiceNotePipePath, isPipeSourceReady } = require('./pulse-pipe-source');

function ffmpegBin() {
  return process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_PATH || process.env.FFPROBE_BIN || 'ffprobe';
}

/** True if ffmpeg + ffprobe are on PATH (or FFMPEG_PATH / FFPROBE_PATH). Required for voice-note pipe feeding. */
function isFfmpegAvailable() {
  try {
    const a = spawnSync(ffmpegBin(), ['-hide_banner', '-version'], { encoding: 'utf8' });
    const b = spawnSync(ffprobeBin(), ['-version'], { encoding: 'utf8' });
    if (a.error || b.error) return false;
    return a.status === 0 && b.status === 0;
  } catch {
    return false;
  }
}

function getAudioDurationSec(audioPath) {
  const probe = spawnSync(
    ffprobeBin(),
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      audioPath,
    ],
    { encoding: 'utf8' }
  );
  if (probe.status !== 0) return 7;
  const value = parseFloat((probe.stdout || '').trim());
  if (!Number.isFinite(value) || value <= 0) return 7;
  return Math.min(Math.max(value, 1), 60);
}

/**
 * Start ffmpeg feeding the voice-note audio file into the pipe-source.
 *
 * CHANGED: No longer uses Pulse sink (-f pulse). Now writes raw s16le 48kHz stereo
 * to the named pipe that module-pipe-source reads. This matches the pipe-source
 * format (s16le rate=48000 channels=2). The second arg (pipePathOrSink) is kept
 * for API compatibility but ignored — we always use getVoiceNotePipePath().
 */
function startVoiceNotePlayback(audioPath, _pipePathOrSink, logger, timeoutMs = 90000) {
  if (!audioPath) throw new Error('voice_note_path_missing');
  if (!fs.existsSync(audioPath)) throw new Error('voice_note_file_not_found');
  if (!isPipeSourceReady()) {
    throw new Error(
      'voice_pipe_source_not_ready: PulseAudio pipe-source setup failed (pactl not found or load-module failed). Voice notes require a VPS with PulseAudio. Install: sudo apt install pulseaudio.'
    );
  }
  const durationSec = getAudioDurationSec(audioPath);
  const pipePath = getVoiceNotePipePath();

  // ffmpeg outputs raw s16le 48kHz stereo to stdout; we stream that into the pipe
  const args = [
    '-re',
    '-stream_loop',
    '0',
    '-i',
    audioPath,
    '-vn',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-f',
    's16le',
    '-',
  ];

  const bin = ffmpegBin();
  // Use fd not WriteStream: Node spawn rejects streams with fd:null; opening the pipe for write
  // blocks until module-pipe-source (reader) connects — ensure ensureVoicePipeSource ran first.
  let pipeFd;
  try {
    pipeFd = fs.openSync(pipePath, 'w');
  } catch (e) {
    throw new Error(
      `voice_note_pipe_open_failed: ${pipePath} — run on VPS with PulseAudio. pactl load-module module-pipe-source must succeed first.`
    );
  }
  const child = spawn(bin, args, { stdio: ['ignore', pipeFd, 'pipe'] });
  let stderrBuf = '';
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      if (stderrBuf.length < 2000) stderrBuf += d.toString();
    });
  }
  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      if (logger) {
        logger.warn(
          `ffmpeg not found (${bin}). Install on the VPS: sudo apt install ffmpeg. Or set FFMPEG_PATH to the full binary path.`
        );
      }
    } else if (logger) {
      logger.warn('ffmpeg spawn error: ' + (err && err.message ? err.message : String(err)));
    }
  });
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, timeoutMs);
  let exited = false;
  child.on('exit', () => {
    exited = true;
    clearTimeout(timeout);
    try {
      fs.closeSync(pipeFd);
    } catch {
      /* ignore */
    }
  });
  if (logger) logger.log(`Voice playback started (${durationSec.toFixed(1)}s) → pipe: ${audioPath}`);
  return {
    durationSec,
    stop: () => {
      if (!exited) child.kill('SIGTERM');
    },
    getStderr: () => stderrBuf.slice(-1000),
  };
}

module.exports = { startVoiceNotePlayback, getAudioDurationSec, isFfmpegAvailable, ffmpegBin, ffprobeBin };
