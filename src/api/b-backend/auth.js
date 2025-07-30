/**
 * B后端API - 用户认证接口
 * 提供给Cloudflare Workers调用的用户认证服务
 */

const express = require('express');
const { verifyToken } = require('../../services/authService');
const {
  bBackendAuthMiddleware,
  bBackendLoggingMiddleware,
  bBackendErrorMiddleware
} = require('./middleware');

const router = express.Router();

// 应用B后端专用中间件
router.use(bBackendLoggingMiddleware);
router.use(bBackendAuthMiddleware);

/**
 * POST /api/b-backend/auth/verify
 * 验证JWT Token并返回用户名
 * 
 * 请求体:
 * {
 *   "token": "jwt_token_string"
 * }
 * 
 * 响应:
 * 成功 (200):
 * {
 *   "success": true,
 *   "username": "user123",
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 * 
 * 失败 (400/401):
 * {
 *   "error": "错误信息",
 *   "code": 4001,
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 */
router.post('/verify', async (req, res, next) => {
  try {
    const { token } = req.body;

    // 参数验证
    if (!token) {
      return res.status(400).json({
        error: '缺少必需参数: token',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof token !== 'string') {
      return res.status(400).json({
        error: 'token必须是字符串类型',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 调用现有的verifyToken服务
    const username = await verifyToken(token);

    // 记录成功的token验证
    if (process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
      console.log('[B-BACKEND-AUTH] Token验证成功', {
        username,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      username,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // 记录token验证失败
    console.warn('[B-BACKEND-AUTH] Token验证失败', {
      error: error.message,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // 根据错误类型返回适当的状态码
    if (error.message.includes('Invalid token') || 
        error.message.includes('Token expired') ||
        error.message.includes('Invalid signature')) {
      return res.status(401).json({
        error: 'Token验证失败',
        code: 4001,
        timestamp: new Date().toISOString()
      });
    }

    // 其他错误传递给错误处理中间件
    next(error);
  }
});

/**
 * GET /api/b-backend/auth/health
 * 认证服务健康检查
 */
router.get('/health', (req, res) => {
  res.json({
    service: 'b-backend-auth',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 应用错误处理中间件
router.use(bBackendErrorMiddleware);

module.exports = router;
