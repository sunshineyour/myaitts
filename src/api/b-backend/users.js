/**
 * B后端API - 用户管理接口
 * 提供给Cloudflare Workers调用的用户配额检查和使用量更新服务
 */

const express = require('express');
const { checkVip, updateUserUsage, bcrypt, calculateQuotaDetails, getNextMonthResetTimestamp } = require('../../services/authService');
const { isValidUsername, isValidEmail } = require('../../utils/validators');
const dbClient = require('../../services/dbClient');
const {
  bBackendAuthMiddleware,
  bBackendLoggingMiddleware,
  bBackendErrorMiddleware
} = require('./middleware');

const router = express.Router();

// KV命名空间配置
const KV_CONFIG = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  KV_NAMESPACES: {
    USERS: '8341ec47189543b48818f57e9ca4e5e0',
    CARDS: '69d6e32b35dd4a0bb996584ebf3f5b27'
  }
};

/**
 * 同步用户数据到Cloudflare KV
 * @param {string} username - 用户名
 * @param {object} userData - 用户数据
 * @param {string} email - 用户邮箱（可选）
 */
async function syncUserToKV(username, userData, email = null) {
  if (!KV_CONFIG.CF_ACCOUNT_ID || !KV_CONFIG.CF_API_TOKEN) {
    console.warn('[KV-SYNC] Cloudflare配置缺失，跳过KV同步');
    return;
  }

  try {
    // 同步用户数据到 user:${username}
    const userResponse = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${KV_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_CONFIG.KV_NAMESPACES.USERS}/values/user:${username}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${KV_CONFIG.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(userData)
      }
    );

    if (!userResponse.ok) {
      throw new Error(`用户数据同步失败: HTTP ${userResponse.status}`);
    }

    // 如果有邮箱，同步邮箱映射到 email:${email}
    if (email) {
      const emailResponse = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${KV_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_CONFIG.KV_NAMESPACES.USERS}/values/email:${email}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${KV_CONFIG.CF_API_TOKEN}`,
            'Content-Type': 'text/plain'
          },
          body: username
        }
      );

      if (!emailResponse.ok) {
        throw new Error(`邮箱映射同步失败: HTTP ${emailResponse.status}`);
      }
    }

    console.log(`[KV-SYNC] 用户 ${username} 数据同步成功`);
  } catch (error) {
    console.error(`[KV-SYNC] 用户 ${username} 同步失败:`, error.message);
    // KV同步失败不应该阻止主流程，只记录错误
  }
}

// 应用B后端专用中间件
router.use(bBackendLoggingMiddleware);
router.use(bBackendAuthMiddleware);

/**
 * POST /api/b-backend/users/register
 * 用户注册完成接口 - A后端验证成功后调用
 *
 * 请求体:
 * {
 *   "username": "user123",
 *   "passwordHash": "hashed_password",
 *   "email": "user@example.com",
 *   "createdAt": 1640995200000
 * }
 *
 * 响应:
 * 成功 (201):
 * {
 *   "success": true,
 *   "message": "用户注册成功",
 *   "userData": {
 *     "username": "user123",
 *     "email": "user@example.com",
 *     "vip": {...},
 *     "usage": {...}
 *   },
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 *
 * 失败 (400/409):
 * {
 *   "error": "错误信息",
 *   "code": 4000,
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { username, passwordHash, email, createdAt } = req.body;

    // 参数验证
    if (!username || !passwordHash) {
      return res.status(400).json({
        error: '缺少必需参数: username, passwordHash',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof username !== 'string' || typeof passwordHash !== 'string') {
      return res.status(400).json({
        error: 'username和passwordHash必须是字符串类型',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 验证用户名格式
    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: '用户名格式不正确（3-20个字符，只能包含字母、数字、下划线）',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 验证邮箱格式（如果提供）
    if (email && !isValidEmail(email)) {
      return res.status(400).json({
        error: '邮箱格式不正确',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 检查用户名和邮箱唯一性
    let existingUser;
    if (email) {
      // 如果提供了邮箱，检查用户名和邮箱唯一性
      existingUser = await dbClient.query(
        'SELECT username, email FROM users WHERE username = $1 OR email = $2',
        [username, email]
      );
    } else {
      // 如果没有提供邮箱，只检查用户名唯一性
      existingUser = await dbClient.query(
        'SELECT username, email FROM users WHERE username = $1',
        [username]
      );
    }

    if (existingUser.rows.length > 0) {
      const existing = existingUser.rows[0];
      const conflictType = existing.username === username ? '用户名' : '邮箱';
      return res.status(409).json({
        error: `${conflictType}已存在`,
        code: 1001,
        timestamp: new Date().toISOString()
      });
    }

    // 初始化默认VIP和配额信息
    const vipInfo = {
      type: null,
      expireAt: 0,
      quotaChars: 0, // 新用户无默认配额
      usedChars: 0
    };

    const usageStats = {
      totalChars: 0,
      monthlyChars: 0,
      monthlyResetAt: getNextMonthResetTimestamp()
    };

    // 写入PostgreSQL
    const insertResult = await dbClient.query(`
      INSERT INTO users (
        username,
        password_hash,
        email,
        vip_info,
        usage_stats,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, username, email, vip_info, usage_stats, created_at
    `, [
      username,
      passwordHash,
      email,
      JSON.stringify(vipInfo),
      JSON.stringify(usageStats),
      createdAt ? new Date(createdAt) : new Date()
    ]);

    const newUser = insertResult.rows[0];

    // 记录成功的用户注册
    console.log('[B-BACKEND-USERS] 用户注册成功', {
      username,
      email,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    res.status(201).json({
      success: true,
      message: '用户注册成功',
      userData: {
        username: newUser.username,
        email: newUser.email,
        vip: newUser.vip_info,
        usage: newUser.usage_stats,
        createdAt: new Date(newUser.created_at).getTime()
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // 记录用户注册失败
    console.error('[B-BACKEND-USERS] 用户注册失败', {
      username: req.body.username,
      email: req.body.email,
      error: error.message,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // 数据库约束错误处理
    if (error.code === '23505') { // PostgreSQL唯一约束违反
      return res.status(409).json({
        error: '用户名或邮箱已存在',
        code: 1001,
        timestamp: new Date().toISOString()
      });
    }

    next(error);
  }
});

/**
 * POST /api/b-backend/users/reset-password
 * 密码重置接口 - A后端验证成功后调用
 *
 * 请求体:
 * {
 *   "username": "user123",
 *   "newPasswordHash": "new_hashed_password",
 *   "passwordUpdatedAt": 1640995200000
 * }
 *
 * 响应:
 * 成功 (200):
 * {
 *   "success": true,
 *   "message": "密码重置成功",
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 *
 * 失败 (400/404):
 * {
 *   "error": "错误信息",
 *   "code": 4000,
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 */
router.post('/reset-password', async (req, res, next) => {
  try {
    const { username, newPasswordHash, passwordUpdatedAt } = req.body;

    // 参数验证
    if (!username || !newPasswordHash) {
      return res.status(400).json({
        error: '缺少必需参数: username, newPasswordHash',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof username !== 'string' || typeof newPasswordHash !== 'string') {
      return res.status(400).json({
        error: 'username和newPasswordHash必须是字符串类型',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 验证用户名格式
    if (!isValidUsername(username)) {
      return res.status(400).json({
        error: '用户名格式不正确',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 检查用户是否存在
    const userResult = await dbClient.query(
      'SELECT id, username, email, vip_info, usage_stats FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: '用户不存在',
        code: 1003,
        timestamp: new Date().toISOString()
      });
    }

    const user = userResult.rows[0];

    // 更新PostgreSQL中的密码哈希
    await dbClient.query(
      'UPDATE users SET password_hash = $1, updated_at = $2 WHERE username = $3',
      [
        newPasswordHash,
        passwordUpdatedAt ? new Date(passwordUpdatedAt) : new Date(),
        username
      ]
    );

    // 记录成功的密码重置
    console.log('[B-BACKEND-USERS] 密码重置成功', {
      username,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: '密码重置成功',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // 记录密码重置失败
    console.error('[B-BACKEND-USERS] 密码重置失败', {
      username: req.body.username,
      error: error.message,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    next(error);
  }
});

/**
 * POST /api/b-backend/users/check-quota
 * 检查用户VIP状态和配额
 * 
 * 请求体:
 * {
 *   "username": "user123",
 *   "requiredTier": "STANDARD", // 可选，默认"STANDARD"
 *   "requestedChars": 1000      // 可选，默认0（不检查配额）
 * }
 * 
 * 响应:
 * 成功 (200):
 * {
 *   "success": true,
 *   "message": "配额检查通过",
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 * 
 * 失败 (403):
 * {
 *   "error": "配额不足",
 *   "code": 4003,
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 */
router.post('/check-quota', async (req, res, next) => {
  try {
    const { username, requiredTier = 'STANDARD', requestedChars = 0 } = req.body;

    // 参数验证
    if (!username) {
      return res.status(400).json({
        error: '缺少必需参数: username',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof username !== 'string') {
      return res.status(400).json({
        error: 'username必须是字符串类型',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (requiredTier && !['STANDARD', 'PRO'].includes(requiredTier)) {
      return res.status(400).json({
        error: 'requiredTier必须是STANDARD或PRO',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (requestedChars && (typeof requestedChars !== 'number' || requestedChars < 0)) {
      return res.status(400).json({
        error: 'requestedChars必须是非负数',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 调用现有的checkVip服务
    await checkVip(username, requiredTier, requestedChars);

    // 记录成功的配额检查
    if (process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
      console.log('[B-BACKEND-USERS] 配额检查成功', {
        username,
        requiredTier,
        requestedChars,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: '配额检查通过',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // 记录配额检查失败
    console.warn('[B-BACKEND-USERS] 配额检查失败', {
      username: req.body.username,
      error: error.message,
      cause: error.cause,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // 根据错误原因返回适当的状态码
    if (error.cause === 'quota') {
      return res.status(403).json({
        error: error.message,
        code: 4003,
        timestamp: new Date().toISOString()
      });
    }

    // 其他错误传递给错误处理中间件
    next(error);
  }
});

/**
 * POST /api/b-backend/users/update-usage
 * 更新用户使用量
 * 
 * 请求体:
 * {
 *   "username": "user123",
 *   "charCount": 1000
 * }
 * 
 * 响应:
 * 成功 (200):
 * {
 *   "success": true,
 *   "message": "使用量更新成功",
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 * 
 * 失败 (400/500):
 * {
 *   "error": "错误信息",
 *   "code": 4000,
 *   "timestamp": "2024-07-27T10:30:00.000Z"
 * }
 */
router.post('/update-usage', async (req, res, next) => {
  try {
    const { username, charCount } = req.body;

    // 参数验证
    if (!username) {
      return res.status(400).json({
        error: '缺少必需参数: username',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof username !== 'string') {
      return res.status(400).json({
        error: 'username必须是字符串类型',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (charCount === undefined || charCount === null) {
      return res.status(400).json({
        error: '缺少必需参数: charCount',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    if (typeof charCount !== 'number' || charCount < 0) {
      return res.status(400).json({
        error: 'charCount必须是非负数',
        code: 4000,
        timestamp: new Date().toISOString()
      });
    }

    // 调用现有的updateUserUsage服务
    await updateUserUsage(username, charCount);

    // 记录成功的使用量更新
    if (process.env.B_BACKEND_API_LOG_LEVEL === 'debug') {
      console.log('[B-BACKEND-USERS] 使用量更新成功', {
        username,
        charCount,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: '使用量更新成功',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    // 记录使用量更新失败
    console.error('[B-BACKEND-USERS] 使用量更新失败', {
      username: req.body.username,
      charCount: req.body.charCount,
      error: error.message,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });

    // 使用量更新失败通常不应该阻止主流程，但需要记录
    // 根据业务需求，可以选择返回成功或失败
    next(error);
  }
});

/**
 * GET /api/b-backend/users/health
 * 用户服务健康检查
 */
router.get('/health', (req, res) => {
  res.json({
    service: 'b-backend-users',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// 应用错误处理中间件
router.use(bBackendErrorMiddleware);

module.exports = router;
