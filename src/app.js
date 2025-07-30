require('dotenv').config();
const express = require('express');
const enableWs = require('express-ws');
const path = require('path');

// 导入服务和中间件
const websocketManager = require('./services/websocketManager');
const authRoutes = require('./api/auth');
const ttsRoutes = require('./api/tts');
const userRoutes = require('./api/user');
const adminRoutes = require('./api/admin');
const cardRoutes = require('./api/card');
const autoTagRoutes = require('./api/autoTag');
const gatewayRoutes = require('./api/gateway');
const bBackendRoutes = require('./api/b-backend');
const corsMiddleware = require('./middleware/cors');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { requestSizeMiddleware, jsonErrorHandler, contentTypeMiddleware } = require('./middleware/validation');
const { logger } = require('./utils/logger');

const app = express();

// 启用WebSocket支持
enableWs(app);

// 基础中间件配置
app.use(corsMiddleware);

// JSON解析中间件（带错误处理）
app.use(express.json({ limit: '10mb' }));
app.use(jsonErrorHandler);

// URL编码解析
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求验证中间件
app.use(requestSizeMiddleware(10 * 1024 * 1024)); // 10MB限制
app.use(contentTypeMiddleware(['application/json', 'application/x-www-form-urlencoded']));

// 静态文件服务
app.use('/health', express.static(path.join(__dirname, '../public')));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.url}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  });
  
  next();
});

// WebSocket路由
// 单人TTS WebSocket路由
app.ws('/api/tts/ws/generate', (ws, req) => {
  logger.info('Single TTS WebSocket connection established', {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  websocketManager.handleConnection(ws, req);
});

// 多人对话TTS WebSocket路由
app.ws('/api/tts/ws/dialogue/generate', (ws, req) => {
  logger.info('Dialogue TTS WebSocket connection established', {
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  websocketManager.handleConnection(ws, req);
});

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/tts', ttsRoutes);
app.use('/api/user', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/card', cardRoutes);
app.use('/api/auto-tag', autoTagRoutes);
app.use('/api/gateway', gatewayRoutes);

// B后端专用API路由（用于Cloudflare Workers调用）
app.use('/api/b-backend', bBackendRoutes);

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// API信息端点
app.get('/api', (req, res) => {
  res.json({
    name: 'TTS API Server',
    version: '1.0.0',
    description: 'Text-to-Speech API服务',
    endpoints: {
      auth: '/api/auth',
      tts: '/api/tts',
      user: '/api/user',
      admin: '/api/admin',
      card: '/api/card',
      websocket: {
        single: '/api/tts/ws/generate',
        dialogue: '/api/tts/ws/dialogue/generate'
      }
    },
    documentation: 'https://your-docs-url.com',
    timestamp: new Date().toISOString()
  });
});

// 404处理
app.use(notFoundHandler);

// 错误处理中间件
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// 优雅关闭处理
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);

  try {
    // 【新增】关闭WebSocket连接管理器
    const websocketManager = require('./services/websocketManager');
    websocketManager.stopCleanupTimer();

    // 关闭所有活跃的WebSocket连接
    const stats = websocketManager.getConnectionStats();
    if (stats.active > 0) {
      logger.info(`Closing ${stats.active} active WebSocket connections`);
      await websocketManager.closeAllConnections(1001, 'Server shutdown');
    }

    // 关闭数据库连接
    const dbClient = require('./services/dbClient');
    const redisClient = require('./services/redisClient');

    await dbClient.end();
    await redisClient.disconnect();

    logger.info('All connections closed successfully');
    process.exit(0);
  } catch (error) {
    logger.error(error, {}, { action: 'graceful_shutdown' });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕获异常处理
process.on('uncaughtException', (error) => {
  logger.error(error, {}, { action: 'uncaught_exception' });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(new Error(`Unhandled Rejection: ${reason}`), {}, { 
    action: 'unhandled_rejection',
    promise: promise.toString()
  });
  process.exit(1);
});

// 启动服务器
if (require.main === module) {
  app.listen(PORT, () => {
    logger.info('TTS Application started successfully', {
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      websocketEndpoints: {
        single: `ws://localhost:${PORT}/api/tts/ws/generate`,
        dialogue: `ws://localhost:${PORT}/api/tts/ws/dialogue/generate`
      },
      healthCheck: `http://localhost:${PORT}/health`
    });
  });
}

module.exports = app;
