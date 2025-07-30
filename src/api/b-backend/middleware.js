/**
 * B后端API专用中间件
 * 用于Cloudflare Workers调用PostgreSQL API的认证和安全控制
 */

const rateLimit = require('express-rate-limit');

/**
 * B后端API认证中间件
 * 使用API_SECRET_TOKEN进行身份验证
 */
function bBackendAuthMiddleware(req, res, next) {
  try {
    // 检查功能开关
    if (process.env.ENABLE_B_BACKEND_API !== 'true') {
      return res.status(503).json({
        error: 'B后端API服务未启用',
        code: 4003,
        timestamp: new Date().toISOString()
      });
    }

    // 检查Authorization头
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'API认证失败：缺少认证头',
        code: 4001,
        timestamp: new Date().toISOString()
      });
    }

    // 提取并验证token
    const token = authHeader.replace('Bearer ', '');
    const apiSecret = process.env.API_SECRET_TOKEN;

    if (!apiSecret) {
      console.error('[B-BACKEND-AUTH] API_SECRET_TOKEN未配置');
      return res.status(500).json({
        error: '服务器配置错误',
        code: 5001,
        timestamp: new Date().toISOString()
      });
    }

    if (token !== apiSecret) {
      console.warn('[B-BACKEND-AUTH] API认证失败', {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString()
      });
      
      return res.status(401).json({
        error: 'API认证失败：无效的认证令牌',
        code: 4002,
        timestamp: new Date().toISOString()
      });
    }

    // 记录成功的API调用（仅在debug模式）
    if (process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
      console.log('[B-BACKEND-AUTH] API认证成功', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    }

    next();
  } catch (error) {
    console.error('[B-BACKEND-AUTH] 认证中间件错误:', error);
    res.status(500).json({
      error: '认证服务内部错误',
      code: 5002,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * B后端API速率限制中间件
 */
const bBackendRateLimitMiddleware = rateLimit({
  windowMs: 60 * 1000, // 1分钟窗口
  max: parseInt(process.env.B_BACKEND_API_RATE_LIMIT) || 1000, // 默认每分钟1000次请求
  message: {
    error: 'API请求频率超限，请稍后重试',
    code: 4029,
    timestamp: new Date().toISOString()
  },
  standardHeaders: true, // 返回速率限制信息在 `RateLimit-*` 头中
  legacyHeaders: false, // 禁用 `X-RateLimit-*` 头
  keyGenerator: (req) => {
    // 简化的key生成器，避免IPv6问题
    return 'api-client';
  },
  skip: (req) => {
    // 在开发环境跳过速率限制
    return process.env.NODE_ENV === 'development';
  }
});

/**
 * B后端API请求日志中间件
 */
function bBackendLoggingMiddleware(req, res, next) {
  const startTime = Date.now();
  
  // 记录请求开始
  if (process.env.B_BACKEND_API_LOG_LEVEL === 'info' || process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
    console.log('[B-BACKEND-API] 请求开始', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });
  }

  // 拦截响应结束事件
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    // 记录请求完成
    if (process.env.B_BACKEND_API_LOG_LEVEL === 'info' || process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
      console.log('[B-BACKEND-API] 请求完成', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration: `${duration}ms`,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
    }

    // 调用原始的send方法
    originalSend.call(this, data);
  };

  next();
}

/**
 * B后端API错误处理中间件
 */
function bBackendErrorMiddleware(error, req, res, next) {
  console.error('[B-BACKEND-API] 错误处理', {
    error: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip,
    timestamp: new Date().toISOString()
  });

  // 根据错误类型返回适当的响应
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: error.message,
      code: 4000,
      timestamp: new Date().toISOString()
    });
  }

  if (error.name === 'ConflictError') {
    return res.status(409).json({
      error: error.message,
      code: 4009,
      timestamp: new Date().toISOString()
    });
  }

  if (error.name === 'ServiceUnavailableError') {
    return res.status(503).json({
      error: error.message,
      code: 5003,
      timestamp: new Date().toISOString()
    });
  }

  // 默认内部服务器错误
  res.status(500).json({
    error: '内部服务器错误',
    code: 5000,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  bBackendAuthMiddleware,
  bBackendRateLimitMiddleware,
  bBackendLoggingMiddleware,
  bBackendErrorMiddleware
};
