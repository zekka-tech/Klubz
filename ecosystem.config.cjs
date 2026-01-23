module.exports = {
  apps: [
    {
      name: 'klubz-webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=klubz-db-prod --local --ip 0.0.0.0 --port 3000',
      cwd: '/home/user',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        ENVIRONMENT: 'development',
        VERSION: '2.0.0'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        ENVIRONMENT: 'production',
        VERSION: '2.0.0'
      },
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 4000,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
      wait_ready: true,
      listen_timeout: 10000,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true
    },
    {
      name: 'klubz-monitoring',
      script: 'node',
      args: 'src/monitoring/server.js',
      cwd: '/home/user',
      env: {
        NODE_ENV: 'development',
        PORT: 3001,
        MONITORING_PORT: 3001
      },
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 2000,
      max_restarts: 5,
      min_uptime: '5s',
      kill_timeout: 3000,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/monitoring-err.log',
      out_file: './logs/monitoring-out.log'
    }
  ],
  
  // Deployment configuration
  deploy: {
    production: {
      user: 'deploy',
      host: ['production-server-1', 'production-server-2'],
      ref: 'origin/main',
      repo: 'https://github.com/zekka-tech/Klubz.git',
      path: '/var/www/klubz',
      'pre-deploy-local': 'npm run build:prod',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env production',
      'pre-setup': 'npm install -g pm2 && npm install -g wrangler'
    },
    staging: {
      user: 'deploy',
      host: 'staging-server',
      ref: 'origin/develop',
      repo: 'https://github.com/zekka-tech/Klubz.git',
      path: '/var/www/klubz-staging',
      'post-deploy': 'npm install && pm2 reload ecosystem.config.cjs --env staging'
    }
  }
};