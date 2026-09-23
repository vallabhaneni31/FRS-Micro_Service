// PM2 process definition for frs-fe-api, run natively in WSL.
// Start from this repo's own root: pm2 start ecosystem.config.cjs
//
// Named .cjs (not .js) because this repo's package.json has "type": "module"
// — PM2 config files use CommonJS (module.exports), and Node would otherwise
// try to parse this as an ES module and fail.
module.exports = {
  apps: [
    {
      name: 'frs-fe-api',
      cwd: __dirname,
      script: 'src/server.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 2000,
      watch: false,
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },
  ],
};
