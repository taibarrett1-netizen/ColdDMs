/**
 * Chrome fake microphone via --use-file-for-fake-audio-capture.
 * Replaces PulseAudio: getUserMedia always succeeds and the exact audio file is played as mic input.
 * No PULSE_SOURCE, null-sink, pipe-source, or pactl needed.
 */

const CHROME_FAKE_MIC_WAV = '/tmp/current-voice-note.wav';

/** Add the three Chrome flags for fake mic. Call before every puppeteer.launch. */
function appendChromeFakeMicArgs(args) {
  if (!Array.isArray(args)) return;
  const flags = [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${CHROME_FAKE_MIC_WAV}`,
    '--use-fake-ui-for-media-stream',
  ];
  for (const f of flags) {
    if (!args.some((a) => typeof a === 'string' && a.startsWith(f.split('=')[0]))) {
      args.push(f);
    }
  }
}

module.exports = {
  CHROME_FAKE_MIC_WAV,
  appendChromeFakeMicArgs,
};
