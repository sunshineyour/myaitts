const { verifyToken } = require('../services/authService');
const { checkAdminPermission } = require('../utils/helpers');

// 基础认证中间件
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Access token required',
        code: 'TOKEN_REQUIRED'
      });
    }

    const username = await verifyToken(token);
    req.user = { username };
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    
    let errorCode = 'AUTH_ERROR';
    let errorMessage = 'Authentication failed';

    if (error.message === 'Token expired') {
      errorCode = 'TOKEN_EXPIRED';
      errorMessage = 'Access token has expired';
    } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
      errorCode = 'TOKEN_INVALID';
      errorMessage = 'Invalid access token';
    } else if (error.message === 'Invalid token type') {
      errorCode = 'TOKEN_TYPE_INVALID';
      errorMessage = 'Invalid token type';
    }

    res.status(401).json({
      error: errorMessage,
      code: errorCode
    });
  }
}

// 可选认证中间件（token可选）
async function optionalAuthMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (token) {
      const username = await verifyToken(token);
      req.user = { username };
    }
    
    next();
  } catch (error) {
    // 可选认证失败时不阻止请求，但清除用户信息
    req.user = null;
    next();
  }
}

// 管理员认证中间件
async function adminAuthMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ 
        error: 'Access token required',
        code: 'TOKEN_REQUIRED'
      });
    }

    const username = await verifyToken(token);
    
    // 检查管理员权限
    await checkAdminPermission(username);
    
    req.user = { username, isAdmin: true };
    
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    
    if (error.message.includes('管理员')) {
      res.status(403).json({
        error: error.message,
        code: 'ADMIN_REQUIRED'
      });
    } else if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({
        error: 'Authentication failed',
        code: 'AUTH_ERROR'
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
}

// VIP权限检查中间件
function vipMiddleware(requiredTier = 'STANDARD') {
  return async (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          error: 'Authentication required',
          code: 'AUTH_REQUIRED'
        });
      }

      const { checkVip } = require('../services/authService');
      await checkVip(req.user.username, requiredTier);
      
      next();
    } catch (error) {
      console.error('VIP middleware error:', error);
      
      if (error.cause === 'quota') {
        res.status(403).json({
          error: error.message,
          code: 'VIP_REQUIRED'
        });
      } else {
        res.status(500).json({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR'
        });
      }
    }
  };
}

// 请求限制中间件（简单实现）
function rateLimitMiddleware(maxRequests = 100, windowMs = 15 * 60 * 1000) {
  const requests = new Map();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    
    // 清理过期记录
    if (requests.has(key)) {
      const userRequests = requests.get(key);
      const validRequests = userRequests.filter(time => now - time < windowMs);
      requests.set(key, validRequests);
    }

    // 检查请求数量
    const userRequests = requests.get(key) || [];
    if (userRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }

    // 记录请求
    userRequests.push(now);
    requests.set(key, userRequests);

    next();
  };
}

module.exports = {
  authMiddleware,
  optionalAuthMiddleware,
  adminAuthMiddleware,
  vipMiddleware,
  rateLimitMiddleware
};
