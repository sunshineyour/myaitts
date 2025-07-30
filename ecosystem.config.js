module.exports = {
  apps: [
    {
      name: 'tts-app',
      script: 'src/app.js',
      instances: 'max', // 使用所有CPU核心
      exec_mode: 'cluster',
      
      // 环境配置
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        DEBUG: 'false',
        // 生产环境专用配置
        MAX_MEMORY_RESTART: '1G',
        NODE_OPTIONS: '--max-old-space-size=1024'
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 3001,
        DEBUG: 'true'
      },
      env_staging: {
        NODE_ENV: 'staging',
        PORT: 3000
      },

      // 进程管理
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'tests'],
      watch_options: {
        followSymlinks: false
      },

      // 内存和CPU限制
      max_memory_restart: '1G',
      min_uptime: '10s',
      max_restarts: 10,
      
      // 日志配置
      log_file: './logs/combined.log',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // PM2日志轮转配置
      max_log_size: '50M',        // 单个日志文件最大大小
      retain_logs: 30,            // 保留的日志文件数量
      
      // 自动重启配置
      autorestart: true,
      restart_delay: 4000,
      
      // 优雅关闭
      kill_timeout: 5000,
      listen_timeout: 3000,
      
      // 健康检查
      health_check_grace_period: 3000,
      
      // 集群配置
      instance_var: 'INSTANCE_ID',
      
      // 进程标题已在开头定义，此行删除避免重复
    }
  ],

  // 部署配置
  deploy: {
    production: {
      user: 'ubuntu',
      host: ['your-server-ip'],
      ref: 'origin/main',
      repo: 'https://github.com/your-org/tts-app-server.git',
      path: '/var/www/tts-app',
      'pre-deploy-local': '',
      'post-deploy': 'npm install && npm run migrate:create && pm2 reload ecosystem.config.js --env production',
      'pre-setup': '',
      'ssh_options': 'StrictHostKeyChecking=no'
    },
    staging: {
      user: 'ubuntu',
      host: ['your-staging-server-ip'],
      ref: 'origin/develop',
      repo: 'https://github.com/your-org/tts-app-server.git',
      path: '/var/www/tts-app-staging',
      'post-deploy': 'npm install && npm run migrate:create && pm2 reload ecosystem.config.js --env staging'
    }
  }
};
