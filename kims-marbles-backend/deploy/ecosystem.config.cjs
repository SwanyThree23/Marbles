// PM2: pm2 start /opt/kims-marbles/kims-marbles-backend/deploy/ecosystem.config.cjs
// ONE process, by design: live rooms, media and rate limits live in its memory.
module.exports = {
  apps: [{
    name: 'kims-marbles',
    cwd: '/opt/kims-marbles/kims-marbles-backend/server',
    script: 'index.js',
    node_args: '--env-file=.env',   // .env is read fresh on every (re)start: no stale PM2 env
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: '1500M',
    kill_timeout: 8000,              // the server shuts down cleanly within 5 s on SIGTERM
    restart_delay: 2000,
    exp_backoff_restart_delay: 200,
    time: true,
    out_file: '/var/log/kims-marbles/out.log',
    error_file: '/var/log/kims-marbles/error.log',
    merge_logs: true,
  }],
};
