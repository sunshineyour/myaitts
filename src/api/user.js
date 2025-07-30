const express = require('express');
const router = express.Router();
const { verifyToken, calculateQuotaDetails } = require('../services/authService');
const dbClient = require('../services/dbClient');

// 获取用户配额信息
router.get('/quota', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        error: 'Token required',
        code: 'NO_TOKEN'
      });
    }

    const username = await verifyToken(token);
    const result = await dbClient.query(
      'SELECT vip_info, usage_stats FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = result.rows[0];
    const vip = userData.vip_info || { expireAt: 0 };
    const usage = userData.usage_stats || {};

    // 【新增】计算配额详细信息 - 与参考代码完全一致
    const quotaDetails = calculateQuotaDetails(userData);

    const response = {
      // 原有字段（保持向后兼容）
      isVip: Date.now() < (vip.expireAt || 0),
      expireAt: vip.expireAt || 0,
      type: vip.type || null,
      // 如果是测试套餐，添加剩余时间信息
      remainingTime: vip.type === 'PT' ?
        Math.max(0, ((vip.expireAt || 0) - Date.now()) / 1000).toFixed(1) : null,

      // 新增配额相关字段
      quotaChars: quotaDetails.quotaChars,           // 总配额（老用户为undefined）
      usedChars: quotaDetails.usedChars,             // 已用配额（老用户为undefined）
      remainingChars: quotaDetails.remainingChars,   // 剩余配额（老用户为undefined）
      usagePercentage: quotaDetails.usagePercentage, // 使用百分比
      isLegacyUser: quotaDetails.isLegacyUser,       // 是否为老用户

      // 使用统计
      monthlyChars: usage.monthlyChars || 0,
      totalChars: usage.totalChars || 0,
      isExpired: vip.expireAt ? Date.now() > vip.expireAt : true
    };

    res.json(response);
  } catch (error) {
    console.error('Get quota error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      // 【修复】添加错误码，便于前端识别认证错误
      let errorCode = 'AUTH_ERROR';
      if (error.message === 'Token expired') {
        errorCode = 'TOKEN_EXPIRED';
      } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
        errorCode = 'TOKEN_INVALID';
      } else if (error.message === 'Invalid token type') {
        errorCode = 'TOKEN_TYPE_INVALID';
      }

      res.status(401).json({
        error: 'Authentication failed',
        code: errorCode
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
});

// 注意：卡密相关功能已移动到 /api/card 路由

// 获取用户信息
router.get('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        error: 'Token required',
        code: 'NO_TOKEN'
      });
    }

    const username = await verifyToken(token);
    const result = await dbClient.query(
      'SELECT username, email, created_at, vip_info, usage_stats FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const vip = user.vip_info || {};
    const usage = user.usage_stats || {};

    // 【新增】计算配额详细信息
    const quotaDetails = calculateQuotaDetails(user);

    res.json({
      username: user.username,
      email: user.email,
      createdAt: user.created_at,
      vip: {
        type: vip.type || null,
        expireAt: vip.expireAt || 0,
        quotaChars: quotaDetails.quotaChars,
        usedChars: quotaDetails.usedChars,
        remainingChars: quotaDetails.remainingChars,
        usagePercentage: quotaDetails.usagePercentage,
        isLegacyUser: quotaDetails.isLegacyUser,
        isExpired: vip.expireAt ? Date.now() > vip.expireAt : true
      },
      usage: {
        totalChars: usage.totalChars || 0,
        monthlyChars: usage.monthlyChars || 0,
        monthlyResetAt: usage.monthlyResetAt || 0
      }
    });
  } catch (error) {
    console.error('Get profile error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      // 【修复】添加错误码，便于前端识别认证错误
      let errorCode = 'AUTH_ERROR';
      if (error.message === 'Token expired') {
        errorCode = 'TOKEN_EXPIRED';
      } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
        errorCode = 'TOKEN_INVALID';
      } else if (error.message === 'Invalid token type') {
        errorCode = 'TOKEN_TYPE_INVALID';
      }

      res.status(401).json({
        error: 'Authentication failed',
        code: errorCode
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
});

// 更新用户信息
router.put('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        error: 'Token required',
        code: 'NO_TOKEN'
      });
    }

    const username = await verifyToken(token);
    const { email } = req.body;

    // 验证邮箱格式
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 检查邮箱是否已被其他用户使用
    if (email) {
      const existingUser = await dbClient.query(
        'SELECT username FROM users WHERE email = $1 AND username != $2',
        [email, username]
      );

      if (existingUser.rows.length > 0) {
        return res.status(400).json({ error: '该邮箱已被其他用户使用' });
      }
    }

    // 更新用户信息
    const updateFields = [];
    const updateValues = [];
    let paramIndex = 1;

    if (email !== undefined) {
      updateFields.push(`email = $${paramIndex++}`);
      updateValues.push(email);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(username);

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE username = $${paramIndex}`;
    await dbClient.query(query, updateValues);

    res.json({
      success: true,
      message: '用户信息更新成功'
    });
  } catch (error) {
    console.error('Update profile error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      // 【修复】添加错误码，便于前端识别认证错误
      let errorCode = 'AUTH_ERROR';
      if (error.message === 'Token expired') {
        errorCode = 'TOKEN_EXPIRED';
      } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
        errorCode = 'TOKEN_INVALID';
      } else if (error.message === 'Invalid token type') {
        errorCode = 'TOKEN_TYPE_INVALID';
      }

      res.status(401).json({
        error: 'Authentication failed',
        code: errorCode
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
});

// 获取用户使用统计
router.get('/stats', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({
        error: 'Token required',
        code: 'NO_TOKEN'
      });
    }

    const username = await verifyToken(token);

    // 获取用户基本统计
    const userResult = await dbClient.query(
      'SELECT usage_stats FROM users WHERE username = $1',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const usage = userResult.rows[0].usage_stats || {};

    // 获取任务统计
    const taskStatsResult = await dbClient.query(
      'SELECT status, COUNT(*) as count FROM task_status WHERE username = $1 GROUP BY status',
      [username]
    );

    const taskStats = {};
    taskStatsResult.rows.forEach(row => {
      taskStats[row.status] = parseInt(row.count);
    });

    // 获取最近7天的使用情况
    const recentUsageResult = await dbClient.query(
      'SELECT DATE(created_at) as date, COUNT(*) as tasks FROM task_status WHERE username = $1 AND created_at >= NOW() - INTERVAL \'7 days\' GROUP BY DATE(created_at) ORDER BY date',
      [username]
    );

    const recentUsage = recentUsageResult.rows.map(row => ({
      date: row.date,
      tasks: parseInt(row.tasks)
    }));

    res.json({
      usage: {
        totalChars: usage.totalChars || 0,
        monthlyChars: usage.monthlyChars || 0,
        monthlyResetAt: usage.monthlyResetAt || 0
      },
      taskStats: {
        total: Object.values(taskStats).reduce((sum, count) => sum + count, 0),
        completed: taskStats.complete || 0,
        failed: taskStats.failed || 0,
        processing: taskStats.processing || 0,
        ...taskStats
      },
      recentUsage: recentUsage
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      // 【修复】添加错误码，便于前端识别认证错误
      let errorCode = 'AUTH_ERROR';
      if (error.message === 'Token expired') {
        errorCode = 'TOKEN_EXPIRED';
      } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
        errorCode = 'TOKEN_INVALID';
      } else if (error.message === 'Invalid token type') {
        errorCode = 'TOKEN_TYPE_INVALID';
      }

      res.status(401).json({
        error: 'Authentication failed',
        code: errorCode
      });
    } else {
      res.status(500).json({
        error: 'Internal server error',
        code: 'INTERNAL_ERROR'
      });
    }
  }
});

module.exports = router;
