const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { checkVip } = require('../services/authService');
const autoTagAudit = require('../utils/autoTagAudit');

/**
 * 自动标注API - 安全代理端点
 * 提供完整的用户认证、权限验证和使用量控制
 */

// 使用量控制 - 简单的内存存储（生产环境建议使用Redis）
const usageTracker = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1分钟窗口
const MAX_REQUESTS_PER_MINUTE = parseInt(process.env.AUTO_TAG_RATE_LIMIT || '10');

/**
 * 检查用户使用频率限制
 */
function checkRateLimit(username) {
  const now = Date.now();
  const userUsage = usageTracker.get(username) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  // 重置计数器（如果窗口已过期）
  if (now > userUsage.resetTime) {
    userUsage.count = 0;
    userUsage.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  // 检查是否超过限制
  if (userUsage.count >= MAX_REQUESTS_PER_MINUTE) {
    const remainingTime = Math.ceil((userUsage.resetTime - now) / 1000);
    throw new Error(`请求过于频繁，请在 ${remainingTime} 秒后重试`);
  }
  
  // 增加计数
  userUsage.count++;
  usageTracker.set(username, userUsage);
  
  return {
    remaining: MAX_REQUESTS_PER_MINUTE - userUsage.count,
    resetTime: userUsage.resetTime
  };
}

/**
 * 调用外部自动标注API
 */
async function callAutoTagAPI(text, language = 'auto') {
  const apiUrl = process.env.AUTO_TAG_API_URL;
  const apiToken = process.env.AUTO_TAG_TOKEN;
  const timeout = parseInt(process.env.AUTO_TAG_TIMEOUT || '30000');
  
  if (!apiUrl || !apiToken) {
    throw new Error('自动标注服务配置错误');
  }
  
  // 创建AbortController用于超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.trim(),
        language: language
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || errorData.message || `HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    // 验证响应格式
    if (!data.success || !data.processedText) {
      throw new Error('服务返回的数据格式不正确');
    }
    
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试');
    }
    
    throw error;
  }
}

/**
 * POST /api/auto-tag/process
 * 自动标注文本处理端点
 */
router.post('/process', authMiddleware, async (req, res) => {
  const startTime = Date.now();
  let auditData = {
    username: req.user?.username || 'unknown',
    textLength: 0,
    success: false,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress
  };

  try {
    const { text, language = 'auto' } = req.body;
    const username = req.user.username;

    auditData.username = username;
    auditData.textLength = text ? text.length : 0;
    
    // 输入验证
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({
        error: '请提供要处理的文本内容',
        code: 'INVALID_INPUT'
      });
    }
    
    // 文本长度限制
    if (text.length > 5000) {
      return res.status(400).json({
        error: '文本长度不能超过5000字符',
        code: 'TEXT_TOO_LONG'
      });
    }
    
    // 权限验证：检查VIP状态
    try {
      await checkVip(username, 'STANDARD', 0); // 自动标注需要STANDARD权限，不消耗字符配额
    } catch (error) {
      if (error.message.includes('权限')) {
        return res.status(403).json({
          error: '自动标注功能需要会员权限',
          code: 'VIP_REQUIRED'
        });
      }
      if (error.message.includes('过期')) {
        return res.status(403).json({
          error: '会员已过期，请续费后使用',
          code: 'VIP_EXPIRED'
        });
      }
      throw error;
    }
    
    // 频率限制检查
    const rateLimitInfo = checkRateLimit(username);
    
    // 调用外部API
    const result = await callAutoTagAPI(text, language);
    
    // 记录成功的审计日志
    auditData.success = true;
    auditData.processedLength = result.processedText.length;
    auditData.processingTime = Date.now() - startTime;
    auditData.rateLimit = rateLimitInfo;

    autoTagAudit.logRequest(auditData);

    // 记录使用日志
    console.log(`[AUTO-TAG] User ${username} processed text (${text.length} chars), remaining requests: ${rateLimitInfo.remaining}`);

    // 返回结果，包含频率限制信息
    res.json({
      success: true,
      processedText: result.processedText,
      originalLength: text.length,
      processedLength: result.processedText.length,
      rateLimit: {
        remaining: rateLimitInfo.remaining,
        resetTime: rateLimitInfo.resetTime
      }
    });
    
  } catch (error) {
    // 记录失败的审计日志
    auditData.success = false;
    auditData.error = error.message;
    auditData.processingTime = Date.now() - startTime;

    autoTagAudit.logRequest(auditData);

    console.error('Auto tag API error:', error);

    // 区分不同类型的错误
    if (error.message.includes('频繁')) {
      res.status(429).json({
        error: error.message,
        code: 'RATE_LIMIT_EXCEEDED'
      });
    } else if (error.message.includes('超时')) {
      res.status(504).json({
        error: error.message,
        code: 'REQUEST_TIMEOUT'
      });
    } else if (error.message.includes('配置错误')) {
      res.status(500).json({
        error: '服务暂时不可用，请稍后重试',
        code: 'SERVICE_UNAVAILABLE'
      });
    } else {
      res.status(500).json({
        error: error.message || '自动标注处理失败',
        code: 'PROCESSING_ERROR'
      });
    }
  }
});

/**
 * GET /api/auto-tag/status
 * 获取用户的使用状态
 */
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const userUsage = usageTracker.get(username) || { count: 0, resetTime: Date.now() + RATE_LIMIT_WINDOW };

    // 获取用户历史统计
    const userStats = await autoTagAudit.getUserStats(username, 7);

    res.json({
      rateLimit: {
        maxRequests: MAX_REQUESTS_PER_MINUTE,
        remaining: Math.max(0, MAX_REQUESTS_PER_MINUTE - userUsage.count),
        resetTime: userUsage.resetTime,
        windowMinutes: RATE_LIMIT_WINDOW / (60 * 1000)
      },
      usage: userStats
    });
  } catch (error) {
    console.error('Auto tag status error:', error);
    res.status(500).json({
      error: '获取状态失败',
      code: 'STATUS_ERROR'
    });
  }
});

/**
 * GET /api/auto-tag/admin/stats
 * 获取系统统计信息（仅管理员）
 */
router.get('/admin/stats', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    const adminUsers = (process.env.ADMIN_USERS || '').split(',');

    if (!adminUsers.includes(username)) {
      return res.status(403).json({
        error: '需要管理员权限',
        code: 'ADMIN_REQUIRED'
      });
    }

    const { date } = req.query;
    const systemStats = autoTagAudit.getSystemStats(date);

    res.json({
      date: date || new Date().toISOString().split('T')[0],
      stats: systemStats
    });
  } catch (error) {
    console.error('Auto tag admin stats error:', error);
    res.status(500).json({
      error: '获取统计信息失败',
      code: 'STATS_ERROR'
    });
  }
});

module.exports = router;
