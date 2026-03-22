/**
 * Voice note audio helpers. Chrome fake mic: convert to WAV; no PulseAudio.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const { CHROME_FAKE_MIC_WAV } = require('./chrome-fake-mic');

function ffmpegBin() {
  return process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || 'ffmpeg';
}

function ffprobeBin() {
  return process.env.FFPROBE_PATH || process.env.FFPROBE_BIN || 'ffprobe';
}

/** True if ffmpeg + ffprobe are on PATH. Required for voice-note conversion. */
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
 * Convert audio to Chrome fake mic format and write to /tmp/current-voice-note.wav.
 * Chrome expects: 48kHz, stereo, s16.
 * @returns {{ durationSec: number }}
 */
function convertToChromeFakeMicWav(inputPath, logger = null) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('voice_note_file_not_found');
  }
  const durationSec = getAudioDurationSec(inputPath);
  const bin = ffmpegBin();
  const result = spawnSync(
    bin,
    [
      '-y',
      '-i', inputPath,
      '-ar', '48000',
      '-ac', '2',
      '-sample_fmt', 's16',
      '-f', 'wav',
      CHROME_FAKE_MIC_WAV,
    ],
    { encoding: 'utf8', timeout: 30000 }
  );
  if (result.status !== 0) {
    const err = (result.stderr || result.error || '').slice(-500);
    throw new Error(`voice_note_convert_failed: ${err}`);
  }
  if (logger && typeof logger.log === 'function') {
    logger.log(`[voice] Converted to Chrome fake mic format: ${inputPath} → ${CHROME_FAKE_MIC_WAV} (${durationSec.toFixed(1)}s)`);
  }
  return { durationSec };
}

/**
 * Ensure /tmp/current-voice-note.wav exists (silent placeholder) so Chrome can launch.
 * Call before first browser launch when no voice file has been converted yet.
 */
function ensureChromeFakeMicPlaceholder(logger = null) {
  if (fs.existsSync(CHROME_FAKE_MIC_WAV)) return;
  const bin = ffmpegBin();
  const result = spawnSync(
    bin,
    [
      '-y',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', '1',
      '-ar', '48000',
      '-ac', '2',
      '-sample_fmt', 's16',
      '-f', 'wav',
      CHROME_FAKE_MIC_WAV,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  if (result.status !== 0 && logger && typeof logger.warn === 'function') {
    logger.warn(`[voice] Could not create placeholder ${CHROME_FAKE_MIC_WAV}: ${result.stderr || ''}`);
  }
}

module.exports = {
  getAudioDurationSec,
  isFfmpegAvailable,
  convertToChromeFakeMicWav,
  ensureChromeFakeMicPlaceholder,
  ffmpegBin,
  ffprobeBin,
};
