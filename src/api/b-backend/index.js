/**
 * B后端API主路由
 * 整合所有B后端专用API接口，提供给Cloudflare Workers调用
 */

const express = require('express');
const authRoutes = require('./auth');
const usersRoutes = require('./users');
const {
  bBackendRateLimitMiddleware,
  bBackendLoggingMiddleware,
  bBackendErrorMiddleware
} = require('./middleware');

const router = express.Router();

// 应用全局中间件
router.use(bBackendRateLimitMiddleware); // 速率限制
router.use(bBackendLoggingMiddleware);   // 请求日志

// 注册子路由
router.use('/auth', authRoutes);   // 认证相关接口
router.use('/users', usersRoutes); // 用户管理接口

/**
 * GET /api/b-backend/health
 * B后端API整体健康检查
 */
router.get('/health', (req, res) => {
  res.json({
    service: 'b-backend-api',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    endpoints: {
      auth: '/api/b-backend/auth',
      users: '/api/b-backend/users'
    },
    config: {
      rateLimit: process.env.B_BACKEND_API_RATE_LIMIT || 1000,
      logLevel: process.env.B_BACKEND_API_LOG_LEVEL || 'info',
      timeout: process.env.B_BACKEND_API_TIMEOUT || 5000,
      metricsEnabled: process.env.B_BACKEND_API_ENABLE_METRICS === 'true'
    }
  });
});

/**
 * GET /api/b-backend/info
 * B后端API信息和文档
 */
router.get('/info', (req, res) => {
  res.json({
    name: 'B后端API',
    description: '为Cloudflare Workers提供PostgreSQL数据访问的专用API',
    version: '1.0.0',
    endpoints: [
      {
        path: '/api/b-backend/auth/verify',
        method: 'POST',
        description: '验证JWT Token并返回用户名',
        parameters: {
          token: 'string (required) - JWT token'
        }
      },
      {
        path: '/api/b-backend/users/register',
        method: 'POST',
        description: '用户注册完成 - A后端验证成功后调用',
        parameters: {
          username: 'string (required) - 用户名',
          passwordHash: 'string (required) - 密码哈希',
          email: 'string (optional) - 邮箱地址',
          createdAt: 'number (optional) - 创建时间戳'
        }
      },
      {
        path: '/api/b-backend/users/reset-password',
        method: 'POST',
        description: '密码重置 - A后端验证成功后调用',
        parameters: {
          username: 'string (required) - 用户名',
          newPasswordHash: 'string (required) - 新密码哈希',
          passwordUpdatedAt: 'number (optional) - 密码更新时间戳'
        }
      },
      {
        path: '/api/b-backend/users/check-quota',
        method: 'POST',
        description: '检查用户VIP状态和配额',
        parameters: {
          username: 'string (required) - 用户名',
          requiredTier: 'string (optional) - 要求的VIP等级 (STANDARD/PRO)',
          requestedChars: 'number (optional) - 请求的字符数'
        }
      },
      {
        path: '/api/b-backend/users/update-usage',
        method: 'POST',
        description: '更新用户使用量',
        parameters: {
          username: 'string (required) - 用户名',
          charCount: 'number (required) - 使用的字符数'
        }
      }
    ],
    authentication: {
      type: 'Bearer Token',
      header: 'Authorization: Bearer {API_SECRET_TOKEN}',
      description: '使用API_SECRET_TOKEN进行身份验证'
    },
    rateLimit: {
      window: '1 minute',
      max: process.env.B_BACKEND_API_RATE_LIMIT || 1000,
      description: '每分钟最大请求数限制'
    }
  });
});

// 应用全局错误处理中间件
router.use(bBackendErrorMiddleware);

module.exports = router;
