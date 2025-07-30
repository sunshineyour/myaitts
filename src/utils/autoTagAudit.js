const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

/**
 * 自动标注审计日志系统
 * 记录所有自动标注API的使用情况，用于监控和分析
 */

class AutoTagAudit {
  constructor() {
    this.auditDir = process.env.AUDIT_LOG_DIR || './logs/auto-tag';
    this.ensureAuditDir();
    this.dailyStats = new Map(); // 每日统计缓存
  }

  ensureAuditDir() {
    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }
  }

  /**
   * 记录自动标注请求
   */
  logRequest(data) {
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0]; // YYYY-MM-DD
    
    const auditEntry = {
      timestamp,
      username: data.username,
      textLength: data.textLength,
      processedLength: data.processedLength || 0,
      success: data.success,
      error: data.error || null,
      processingTime: data.processingTime || 0,
      userAgent: data.userAgent || null,
      ip: data.ip || null,
      rateLimit: data.rateLimit || null
    };

    // 写入日志文件
    this.writeToFile(date, auditEntry);
    
    // 更新统计
    this.updateDailyStats(date, auditEntry);
    
    // 写入系统日志
    logger.info('Auto tag request processed', auditEntry, { username: data.username });
  }

  /**
   * 写入审计日志文件
   */
  writeToFile(date, entry) {
    try {
      const filePath = path.join(this.auditDir, `auto-tag-${date}.log`);
      const logLine = JSON.stringify(entry) + '\n';
      
      fs.appendFileSync(filePath, logLine, 'utf8');
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }
  }

  /**
   * 更新每日统计
   */
  updateDailyStats(date, entry) {
    if (!this.dailyStats.has(date)) {
      this.dailyStats.set(date, {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalTextLength: 0,
        totalProcessedLength: 0,
        uniqueUsers: new Set(),
        errors: new Map()
      });
    }

    const stats = this.dailyStats.get(date);
    stats.totalRequests++;
    stats.totalTextLength += entry.textLength;
    stats.totalProcessedLength += entry.processedLength;
    stats.uniqueUsers.add(entry.username);

    if (entry.success) {
      stats.successfulRequests++;
    } else {
      stats.failedRequests++;
      const errorType = entry.error || 'Unknown Error';
      stats.errors.set(errorType, (stats.errors.get(errorType) || 0) + 1);
    }
  }

  /**
   * 获取用户使用统计
   */
  async getUserStats(username, days = 7) {
    const stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTextLength: 0,
      averageTextLength: 0,
      lastUsed: null,
      dailyBreakdown: []
    };

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));

    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      const dayStats = await this.getDayStats(dateStr, username);
      
      if (dayStats.totalRequests > 0) {
        stats.totalRequests += dayStats.totalRequests;
        stats.successfulRequests += dayStats.successfulRequests;
        stats.failedRequests += dayStats.failedRequests;
        stats.totalTextLength += dayStats.totalTextLength;
        stats.lastUsed = dateStr;
        
        stats.dailyBreakdown.push({
          date: dateStr,
          requests: dayStats.totalRequests,
          textLength: dayStats.totalTextLength
        });
      }
    }

    if (stats.totalRequests > 0) {
      stats.averageTextLength = Math.round(stats.totalTextLength / stats.totalRequests);
    }

    return stats;
  }

  /**
   * 获取指定日期的用户统计
   */
  async getDayStats(date, username) {
    const stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTextLength: 0
    };

    try {
      const filePath = path.join(this.auditDir, `auto-tag-${date}.log`);
      
      if (!fs.existsSync(filePath)) {
        return stats;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.username === username) {
            stats.totalRequests++;
            stats.totalTextLength += entry.textLength;
            
            if (entry.success) {
              stats.successfulRequests++;
            } else {
              stats.failedRequests++;
            }
          }
        } catch (parseError) {
          // 忽略解析错误的行
        }
      }
    } catch (error) {
      console.error(`Failed to read audit log for ${date}:`, error);
    }

    return stats;
  }

  /**
   * 获取系统整体统计
   */
  getSystemStats(date = null) {
    const targetDate = date || new Date().toISOString().split('T')[0];
    const stats = this.dailyStats.get(targetDate);

    if (!stats) {
      return {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        uniqueUsers: 0,
        totalTextLength: 0,
        averageTextLength: 0,
        successRate: 0,
        topErrors: []
      };
    }

    const successRate = stats.totalRequests > 0 
      ? Math.round((stats.successfulRequests / stats.totalRequests) * 100) 
      : 0;

    const averageTextLength = stats.totalRequests > 0 
      ? Math.round(stats.totalTextLength / stats.totalRequests) 
      : 0;

    const topErrors = Array.from(stats.errors.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([error, count]) => ({ error, count }));

    return {
      totalRequests: stats.totalRequests,
      successfulRequests: stats.successfulRequests,
      failedRequests: stats.failedRequests,
      uniqueUsers: stats.uniqueUsers.size,
      totalTextLength: stats.totalTextLength,
      averageTextLength,
      successRate,
      topErrors
    };
  }

  /**
   * 清理旧的审计日志（保留指定天数）
   */
  cleanupOldLogs(retentionDays = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      const files = fs.readdirSync(this.auditDir);
      
      for (const file of files) {
        if (file.startsWith('auto-tag-') && file.endsWith('.log')) {
          const dateMatch = file.match(/auto-tag-(\d{4}-\d{2}-\d{2})\.log/);
          if (dateMatch) {
            const fileDate = new Date(dateMatch[1]);
            if (fileDate < cutoffDate) {
              const filePath = path.join(this.auditDir, file);
              fs.unlinkSync(filePath);
              console.log(`Cleaned up old audit log: ${file}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old audit logs:', error);
    }
  }
}

// 创建单例实例
const autoTagAudit = new AutoTagAudit();

// 定期清理旧日志（每天执行一次）
setInterval(() => {
  autoTagAudit.cleanupOldLogs();
}, 24 * 60 * 60 * 1000);

module.exports = autoTagAudit;
