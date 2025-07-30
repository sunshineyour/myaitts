const express = require('express');
const router = express.Router();
const { verifyToken } = require('../services/authService');
const dbClient = require('../services/dbClient');
const { checkAdminPermission } = require('../utils/helpers');
const { validatePaginationParams, isValidCardCode } = require('../utils/validators');
const { getAllPackages, getPackageConfig } = require('../utils/config');

// KV同步配置（用于卡密同步）
const KV_CONFIG = {
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  KV_NAMESPACES: {
    CARDS: '69d6e32b35dd4a0bb996584ebf3f5b27'
  }
};

/**
 * 同步卡密数据到Cloudflare KV
 * @param {string} cardCode - 卡密代码
 * @param {object} cardData - 卡密数据（KV格式）
 */
async function syncCardToKV(cardCode, cardData) {
  if (!KV_CONFIG.CF_ACCOUNT_ID || !KV_CONFIG.CF_API_TOKEN) {
    console.warn('[CARD-KV-SYNC] Cloudflare配置缺失，跳过卡密KV同步');
    return;
  }

  try {
    // 同步卡密数据到 card:${cardCode}
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${KV_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${KV_CONFIG.KV_NAMESPACES.CARDS}/values/card:${cardCode}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${KV_CONFIG.CF_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cardData)
      }
    );

    if (!response.ok) {
      throw new Error(`卡密KV同步失败: HTTP ${response.status}`);
    }

    console.log(`[CARD-KV-SYNC] 卡密 ${cardCode} 同步到KV成功`);
  } catch (error) {
    console.error(`[CARD-KV-SYNC] 卡密 ${cardCode} 同步失败:`, error.message);
    // KV同步失败不应该阻止主流程，只记录错误
  }
}

/**
 * 将PostgreSQL卡密数据转换为KV格式
 * @param {string} cardCode - 卡密代码
 * @param {string} packageType - 套餐类型
 * @param {object} packageInfo - 套餐信息
 * @returns {object} KV格式的卡密数据
 */
function convertCardDataToKVFormat(cardCode, packageType, packageInfo) {
  return {
    t: packageType,                    // 套餐类型
    s: 'unused',                       // 状态：unused/used
    c: Date.now(),                     // 创建时间
    u: null,                           // 使用者（未使用时为null）
    a: null,                           // 激活时间（未使用时为null）
    chars: packageInfo.quotaChars,     // 字符配额
    days: packageInfo.duration / 86400000, // 天数（毫秒转天）
    price: packageInfo.price           // 价格
  };
}

// 生成符合验证器要求的32位卡密
function generateValidCardCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 获取套餐描述
function getPackageDescription(packageType, packageConfig) {
  const descriptions = {
    'M': '标准月套餐',
    'Q': '标准季度套餐',
    'H': '标准半年套餐',
    'PM': 'PRO月套餐',
    'PQ': 'PRO季度套餐',
    'PH': 'PRO半年套餐',
    'PT': '测试套餐'
  };

  return descriptions[packageType] || `${packageType}套餐`;
}

// 管理员中间件
async function adminMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token);
    await checkAdminPermission(username);
    
    req.adminUser = username;
    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else if (error.message.includes('管理员')) {
      res.status(403).json({ error: error.message });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}

// 获取所有用户列表
router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const validation = validatePaginationParams(req.query);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }

    const { limit, offset } = validation.params;
    const { search } = req.query;

    let query = 'SELECT username, email, created_at, updated_at, vip_info, usage_stats FROM users';
    let countQuery = 'SELECT COUNT(*) FROM users';
    const queryParams = [];
    let paramIndex = 1;

    if (search) {
      const searchCondition = ` WHERE username ILIKE $${paramIndex} OR email ILIKE $${paramIndex}`;
      query += searchCondition;
      countQuery += searchCondition;
      queryParams.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    queryParams.push(limit, offset);

    const [usersResult, countResult] = await Promise.all([
      dbClient.query(query, queryParams),
      dbClient.query(countQuery, search ? [`%${search}%`] : [])
    ]);

    const users = usersResult.rows.map(user => {
      const vip = user.vip_info || {};
      const usage = user.usage_stats || {};
      
      return {
        username: user.username,
        email: user.email,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        vip: {
          type: vip.type || null,
          expireAt: vip.expireAt || 0,
          quotaChars: vip.quotaChars || 0,
          usedChars: vip.usedChars || 0,
          isExpired: vip.expireAt ? Date.now() > vip.expireAt : true
        },
        usage: {
          totalChars: usage.totalChars || 0,
          monthlyChars: usage.monthlyChars || 0
        }
      };
    });

    const total = parseInt(countResult.rows[0].count);

    res.json({
      users: users,
      pagination: {
        total: total,
        limit: limit,
        offset: offset,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    console.error('Admin get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取系统统计信息
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    // 用户统计
    const userStatsResult = await dbClient.query(`
      SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN vip_info->>'expireAt' IS NOT NULL AND (vip_info->>'expireAt')::bigint > EXTRACT(EPOCH FROM NOW()) * 1000 THEN 1 END) as active_vip_users,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as new_users_7d,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as new_users_30d
      FROM users
    `);

    // 任务统计
    const taskStatsResult = await dbClient.query(`
      SELECT
        COUNT(*) as total_tasks,
        COUNT(CASE WHEN status = 'complete' THEN 1 END) as completed_tasks,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_tasks,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_tasks,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '24 hours' THEN 1 END) as tasks_24h,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as tasks_7d
      FROM task_status
    `);

    // 卡密统计
    const cardStatsResult = await dbClient.query(`
      SELECT
        COUNT(*) as total_cards,
        COUNT(CASE WHEN status = 'unused' THEN 1 END) as unused_cards,
        COUNT(CASE WHEN status = 'used' THEN 1 END) as used_cards,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as new_cards_7d
      FROM cards
    `);

    // 最近7天的任务趋势
    const taskTrendResult = await dbClient.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as tasks,
        COUNT(CASE WHEN status = 'complete' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM task_status
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json({
      users: userStatsResult.rows[0],
      tasks: taskStatsResult.rows[0],
      cards: cardStatsResult.rows[0],
      taskTrend: taskTrendResult.rows.map(row => ({
        date: row.date,
        tasks: parseInt(row.tasks),
        completed: parseInt(row.completed),
        failed: parseInt(row.failed)
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Admin get stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取全局使用量汇总
router.get('/usage/summary', adminMiddleware, async (req, res) => {
  try {
    console.log(`[ADMIN-USAGE-SUMMARY] Admin ${req.adminUser} requesting global usage summary`);

    // 1. 全局使用量统计
    const globalUsageResult = await dbClient.query(`
      SELECT
        -- 总字符使用量统计
        SUM(COALESCE((usage_stats->>'totalChars')::bigint, 0)) as total_chars_all_time,
        SUM(COALESCE((usage_stats->>'monthlyChars')::bigint, 0)) as total_chars_current_month,

        -- 配额使用统计（仅新用户）
        SUM(COALESCE((vip_info->>'usedChars')::bigint, 0)) as total_quota_used,
        SUM(COALESCE((vip_info->>'quotaChars')::bigint, 0)) as total_quota_allocated,

        -- 用户分类统计
        COUNT(*) as total_users,
        COUNT(CASE WHEN vip_info->>'quotaChars' IS NULL THEN 1 END) as legacy_users,
        COUNT(CASE WHEN vip_info->>'quotaChars' IS NOT NULL THEN 1 END) as quota_users,

        -- 活跃用户统计（本月有使用量的用户）
        COUNT(CASE WHEN COALESCE((usage_stats->>'monthlyChars')::bigint, 0) > 0 THEN 1 END) as active_users_this_month,

        -- 平均使用量
        AVG(COALESCE((usage_stats->>'totalChars')::bigint, 0)) as avg_total_chars_per_user,
        AVG(COALESCE((usage_stats->>'monthlyChars')::bigint, 0)) as avg_monthly_chars_per_user
      FROM users
    `);

    // 2. VIP类型使用量分布
    const vipUsageResult = await dbClient.query(`
      SELECT
        COALESCE(vip_info->>'type', '无VIP') as vip_type,
        COUNT(*) as user_count,
        SUM(COALESCE((usage_stats->>'totalChars')::bigint, 0)) as total_chars,
        SUM(COALESCE((usage_stats->>'monthlyChars')::bigint, 0)) as monthly_chars,
        AVG(COALESCE((usage_stats->>'totalChars')::bigint, 0)) as avg_total_chars,
        AVG(COALESCE((usage_stats->>'monthlyChars')::bigint, 0)) as avg_monthly_chars
      FROM users
      GROUP BY vip_info->>'type'
      ORDER BY total_chars DESC
    `);

    // 3. 最近7天使用量趋势（基于任务创建时间）
    const usageTrendResult = await dbClient.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as tasks_count,
        COUNT(DISTINCT username) as active_users
      FROM task_status
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    // 4. 配额使用率TOP10用户（仅限有配额的用户）
    const quotaTopUsersResult = await dbClient.query(`
      SELECT
        username,
        vip_info->>'type' as vip_type,
        (vip_info->>'quotaChars')::bigint as quota_chars,
        (vip_info->>'usedChars')::bigint as used_chars,
        ROUND(
          (COALESCE((vip_info->>'usedChars')::bigint, 0)::numeric /
           NULLIF((vip_info->>'quotaChars')::bigint, 0)::numeric) * 100, 2
        ) as usage_percentage
      FROM users
      WHERE vip_info->>'quotaChars' IS NOT NULL
        AND (vip_info->>'quotaChars')::bigint > 0
      ORDER BY usage_percentage DESC
      LIMIT 10
    `);

    // 5. 月度重置状态检查
    const now = Date.now();
    const monthlyResetResult = await dbClient.query(`
      SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN COALESCE((usage_stats->>'monthlyResetAt')::bigint, 0) <= $1 THEN 1 END) as users_need_reset,
        COUNT(CASE WHEN COALESCE((usage_stats->>'monthlyResetAt')::bigint, 0) > $1 THEN 1 END) as users_reset_ok
      FROM users
    `, [now]);

    // 处理数据
    const globalStats = globalUsageResult.rows[0];
    const vipDistribution = vipUsageResult.rows;
    const usageTrend = usageTrendResult.rows;
    const topQuotaUsers = quotaTopUsersResult.rows;
    const resetStatus = monthlyResetResult.rows[0];

    // 计算全局配额使用率
    const globalQuotaUsageRate = globalStats.total_quota_allocated > 0
      ? Math.round((globalStats.total_quota_used / globalStats.total_quota_allocated) * 10000) / 100
      : 0;

    const response = {
      // 全局汇总数据
      globalSummary: {
        totalCharsAllTime: parseInt(globalStats.total_chars_all_time) || 0,
        totalCharsCurrentMonth: parseInt(globalStats.total_chars_current_month) || 0,
        totalQuotaUsed: parseInt(globalStats.total_quota_used) || 0,
        totalQuotaAllocated: parseInt(globalStats.total_quota_allocated) || 0,
        globalQuotaUsageRate: globalQuotaUsageRate,

        // 用户统计
        totalUsers: parseInt(globalStats.total_users) || 0,
        legacyUsers: parseInt(globalStats.legacy_users) || 0,
        quotaUsers: parseInt(globalStats.quota_users) || 0,
        activeUsersThisMonth: parseInt(globalStats.active_users_this_month) || 0,

        // 平均使用量
        avgTotalCharsPerUser: Math.round(parseFloat(globalStats.avg_total_chars_per_user) || 0),
        avgMonthlyCharsPerUser: Math.round(parseFloat(globalStats.avg_monthly_chars_per_user) || 0)
      },

      // VIP类型分布
      vipDistribution: vipDistribution.map(row => ({
        vipType: row.vip_type,
        userCount: parseInt(row.user_count),
        totalChars: parseInt(row.total_chars) || 0,
        monthlyChars: parseInt(row.monthly_chars) || 0,
        avgTotalChars: Math.round(parseFloat(row.avg_total_chars) || 0),
        avgMonthlyChars: Math.round(parseFloat(row.avg_monthly_chars) || 0)
      })),

      // 使用量趋势
      usageTrend: usageTrend.map(row => ({
        date: row.date,
        tasksCount: parseInt(row.tasks_count),
        activeUsers: parseInt(row.active_users)
      })),

      // 配额使用率TOP用户
      topQuotaUsers: topQuotaUsers.map(row => ({
        username: row.username,
        vipType: row.vip_type,
        quotaChars: parseInt(row.quota_chars),
        usedChars: parseInt(row.used_chars) || 0,
        usagePercentage: parseFloat(row.usage_percentage) || 0
      })),

      // 月度重置状态
      monthlyResetStatus: {
        totalUsers: parseInt(resetStatus.total_users),
        usersNeedReset: parseInt(resetStatus.users_need_reset),
        usersResetOk: parseInt(resetStatus.users_reset_ok)
      },

      // 元数据
      timestamp: new Date().toISOString(),
      generatedBy: req.adminUser
    };

    console.log(`[ADMIN-USAGE-SUMMARY] Successfully generated usage summary for admin ${req.adminUser}`);
    res.json(response);

  } catch (error) {
    console.error('Admin get usage summary error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: '获取使用量汇总失败'
    });
  }
});

// 获取用户详细信息
router.get('/users/:username', adminMiddleware, async (req, res) => {
  try {
    const { username } = req.params;

    const userResult = await dbClient.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const vip = user.vip_info || {};
    const usage = user.usage_stats || {};

    // 获取用户的任务历史
    const tasksResult = await dbClient.query(
      'SELECT task_id, status, created_at, completed_at FROM task_status WHERE username = $1 ORDER BY created_at DESC LIMIT 10',
      [username]
    );

    // 获取用户使用的卡密
    const cardsResult = await dbClient.query(
      'SELECT code, package_type, used_at FROM cards WHERE used_by = $1 ORDER BY used_at DESC LIMIT 10',
      [username]
    );

    res.json({
      user: {
        username: user.username,
        email: user.email,
        passwordHash: user.password_hash,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        vip: vip,
        usage: usage
      },
      recentTasks: tasksResult.rows,
      usedCards: cardsResult.rows
    });
  } catch (error) {
    console.error('Admin get user detail error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 更新用户VIP信息
router.put('/users/:username/vip', adminMiddleware, async (req, res) => {
  try {
    const { username } = req.params;
    const { type, expireAt, quotaChars, usedChars } = req.body;

    // 验证参数
    if (type && !['M', 'Q', 'H', 'PM', 'PQ', 'PH', 'PT', 'T'].includes(type)) {
      return res.status(400).json({ error: 'Invalid VIP type' });
    }

    if (expireAt && (typeof expireAt !== 'number' || expireAt < 0)) {
      return res.status(400).json({ error: 'Invalid expireAt timestamp' });
    }

    if (quotaChars !== undefined && (typeof quotaChars !== 'number' || quotaChars < 0)) {
      return res.status(400).json({ error: 'Invalid quotaChars' });
    }

    if (usedChars !== undefined && (typeof usedChars !== 'number' || usedChars < 0)) {
      return res.status(400).json({ error: 'Invalid usedChars' });
    }

    // 获取当前用户信息
    const userResult = await dbClient.query(
      'SELECT vip_info FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentVip = userResult.rows[0].vip_info || {};

    // 更新VIP信息
    const updatedVip = {
      ...currentVip,
      ...(type !== undefined && { type }),
      ...(expireAt !== undefined && { expireAt }),
      ...(quotaChars !== undefined && { quotaChars }),
      ...(usedChars !== undefined && { usedChars })
    };

    await dbClient.query(
      'UPDATE users SET vip_info = $1, updated_at = CURRENT_TIMESTAMP WHERE username = $2',
      [JSON.stringify(updatedVip), username]
    );

    console.log(`[ADMIN] ${req.adminUser} updated VIP info for user ${username}`);

    res.json({
      success: true,
      message: 'VIP information updated successfully',
      vip: updatedVip
    });
  } catch (error) {
    console.error('Admin update user VIP error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 生成卡密
router.post('/cards/generate', adminMiddleware, async (req, res) => {
  try {
    const { packageType, quantity = 1, customCode } = req.body;

    // 验证套餐类型
    if (!packageType) {
      return res.status(400).json({ error: '套餐类型不能为空' });
    }

    const packageConfig = getPackageConfig(packageType);
    if (!packageConfig) {
      return res.status(400).json({
        error: '无效的套餐类型',
        availableTypes: Object.keys(getAllPackages())
      });
    }

    // 验证数量
    if (quantity < 1 || quantity > 100) {
      return res.status(400).json({ error: '生成数量必须在1-100之间' });
    }

    // 如果提供了自定义卡密，验证格式
    if (customCode && !isValidCardCode(customCode)) {
      return res.status(400).json({ error: '自定义卡密格式不正确（需要32位字母数字组合）' });
    }

    const generatedCards = [];
    const errors = [];

    // 生成卡密
    for (let i = 0; i < quantity; i++) {
      try {
        let cardCode;

        if (customCode && quantity === 1) {
          // 使用自定义卡密（仅当数量为1时）
          cardCode = customCode;
        } else {
          // 生成随机卡密
          cardCode = generateValidCardCode();

          // 确保卡密唯一性
          let attempts = 0;
          while (attempts < 10) {
            const existingCard = await dbClient.query(
              'SELECT id FROM cards WHERE code = $1',
              [cardCode]
            );

            if (existingCard.rows.length === 0) {
              break; // 卡密唯一，可以使用
            }

            cardCode = generateValidCardCode();
            attempts++;
          }

          if (attempts >= 10) {
            errors.push(`第${i + 1}张卡密生成失败：无法生成唯一卡密`);
            continue;
          }
        }

        // 构建package_info
        const packageInfo = {
          type: packageType,
          duration: packageConfig.days * 86400000, // 转换为毫秒
          quotaChars: packageConfig.chars,
          price: packageConfig.price,
          description: getPackageDescription(packageType, packageConfig)
        };

        // 插入数据库
        await dbClient.query(`
          INSERT INTO cards (code, package_type, status, package_info, created_at)
          VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        `, [
          cardCode,
          packageType,
          'unused',
          JSON.stringify(packageInfo)
        ]);

        // 同步卡密到Cloudflare KV
        const kvCardData = convertCardDataToKVFormat(cardCode, packageType, packageInfo);
        await syncCardToKV(cardCode, kvCardData);

        generatedCards.push({
          code: cardCode,
          packageType: packageType,
          packageInfo: packageInfo
        });

      } catch (error) {
        console.error(`生成第${i + 1}张卡密失败:`, error);
        if (error.code === '23505') { // PostgreSQL唯一约束违反
          errors.push(`第${i + 1}张卡密生成失败：卡密已存在`);
        } else {
          errors.push(`第${i + 1}张卡密生成失败：${error.message}`);
        }
      }
    }

    // 返回结果
    const response = {
      success: generatedCards.length > 0,
      generated: generatedCards.length,
      requested: quantity,
      cards: generatedCards
    };

    if (errors.length > 0) {
      response.errors = errors;
    }

    if (generatedCards.length === 0) {
      return res.status(400).json({
        ...response,
        error: '没有成功生成任何卡密'
      });
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('Generate cards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取卡密列表
router.get('/cards', adminMiddleware, async (req, res) => {
  try {
    const { status, packageType } = req.query;

    // 验证分页参数
    const validation = validatePaginationParams(req.query);
    if (!validation.isValid) {
      return res.status(400).json({ errors: validation.errors });
    }

    const { limit: validatedLimit, offset } = validation.params;

    // 构建查询条件
    let whereConditions = [];
    let queryParams = [];
    let paramIndex = 1;

    if (status) {
      whereConditions.push(`c.status = $${paramIndex}`);
      queryParams.push(status);
      paramIndex++;
    }

    if (packageType) {
      whereConditions.push(`c.package_type = $${paramIndex}`);
      queryParams.push(packageType);
      paramIndex++;
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    // 查询卡密列表（包含用户使用量信息）
    const cardsResult = await dbClient.query(`
      SELECT
        c.id, c.code, c.package_type, c.status, c.package_info,
        c.created_at, c.used_at, c.used_by,
        u.usage_stats
      FROM cards c
      LEFT JOIN users u ON c.used_by = u.username
      ${whereClause}
      ORDER BY c.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `, [...queryParams, validatedLimit, offset]);

    // 查询总数
    const countResult = await dbClient.query(`
      SELECT COUNT(*) as total FROM cards c ${whereClause}
    `, queryParams);

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / validatedLimit);

    // 处理返回数据，添加用户使用量信息
    const cards = cardsResult.rows.map(card => ({
      id: card.id,
      code: card.code,
      package_type: card.package_type,
      status: card.status,
      package_info: card.package_info,
      created_at: card.created_at,
      used_at: card.used_at,
      used_by: card.used_by,
      // 如果卡密已使用且有用户数据，则包含使用量信息
      userUsage: card.used_by && card.usage_stats ? card.usage_stats : null
    }));

    const currentPage = Math.floor(offset / validatedLimit) + 1;

    res.json({
      cards: cards,
      pagination: {
        page: currentPage,
        limit: validatedLimit,
        total: total,
        totalPages: totalPages,
        hasNext: currentPage < totalPages,
        hasPrev: currentPage > 1
      }
    });
  } catch (error) {
    console.error('Get cards error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取可用套餐类型
router.get('/cards/packages', adminMiddleware, async (req, res) => {
  try {
    const packages = getAllPackages();
    const packageList = Object.entries(packages).map(([type, config]) => ({
      type: type,
      description: getPackageDescription(type, config),
      days: config.days,
      price: config.price,
      chars: config.chars
    }));

    res.json({
      packages: packageList
    });
  } catch (error) {
    console.error('Get packages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
