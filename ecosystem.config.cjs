/**
 * PM2 config. Use: pm2 start ecosystem.config.cjs
 * Voice notes use Chrome fake mic (no PulseAudio needed).
 */
module.exports = {
  apps: [
    {
      name: 'ig-dm-dashboard',
      script: 'server.js',
    },
  ],
};
