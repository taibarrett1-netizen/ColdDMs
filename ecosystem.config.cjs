/**
 * PM2 config. Use: pm2 start ecosystem.config.cjs
 * Sets PULSE_SERVER so pactl/Chromium find PulseAudio when running as root.
 * Start PulseAudio first: XDG_RUNTIME_DIR=/run/user/0 pulseaudio -D
 */
module.exports = {
  apps: [
    {
      name: 'ig-dm-dashboard',
      script: 'server.js',
      env: {
        PULSE_SERVER: 'unix:/run/user/0/pulse/native',
        XDG_RUNTIME_DIR: '/run/user/0',
      },
    },
  ],
};
