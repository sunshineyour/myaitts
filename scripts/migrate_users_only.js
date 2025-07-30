#!/usr/bin/env node

/**
 * 用户数据专用迁移脚本
 * 从本地KV备份文件读取用户数据并迁移到PostgreSQL数据库
 * 
 * 使用方法:
 * node scripts/migrate_users_only.js [backup_file_path]
 * 
 * 示例:
 * node scripts/migrate_users_only.js data/kv_backup_users_20250726_114649.json
 * 
 * 如果不指定文件路径，会自动查找最新的用户备份文件
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');

// 数据库连接配置
const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL
};

// VIP类型映射（处理旧类型）
const VIP_TYPE_MAPPING = {
  'T': 'PT',  // 旧的测试套餐映射为新的测试套餐
  'PT': 'PT',
  'M': 'M',
  'Q': 'Q', 
  'H': 'H',
  'PM': 'PM',
  'PQ': 'PQ',
  'PH': 'PH'
};

// 颜色输出函数
function log(color, message) {
  const colors = {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    reset: '\x1b[0m'
  };
  console.log(`${colors[color] || ''}${message}${colors.reset}`);
}

// 获取下个月重置时间戳
function getNextMonthResetTimestamp() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.getTime();
}

class UserDataMigrator {
  constructor() {
    this.pgPool = new Pool(DB_CONFIG);
    this.dataDir = path.join(__dirname, '..', 'data');
    this.stats = {
      total: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
  }

  // 查找最新的用户备份文件
  async findLatestUserBackup() {
    try {
      const files = await fs.readdir(this.dataDir);
      const userBackups = files
        .filter(file => file.startsWith('kv_backup_users_') && file.endsWith('.json'))
        .sort()
        .reverse();
      
      if (userBackups.length === 0) {
        throw new Error('未找到用户数据备份文件');
      }
      
      return path.join(this.dataDir, userBackups[0]);
    } catch (error) {
      throw new Error(`查找备份文件失败: ${error.message}`);
    }
  }

  // 加载备份数据
  async loadBackupData(filepath) {
    try {
      const content = await fs.readFile(filepath, 'utf8');
      const backupData = JSON.parse(content);
      
      if (!backupData.data) {
        throw new Error('备份文件格式错误：缺少data字段');
      }
      
      return backupData;
    } catch (error) {
      throw new Error(`加载备份文件失败: ${error.message}`);
    }
  }

  // 验证和转换用户数据
  transformUserData(key, rawUserData) {
    try {
      const userData = JSON.parse(rawUserData);
      const username = key.replace('user:', '');

      // 验证必需字段
      if (!userData.username || !userData.passwordHash) {
        throw new Error('缺少必需字段: username 或 passwordHash');
      }

      // 处理注册时间
      let createdAt = null;
      if (userData.createdAt) {
        // 将时间戳转换为PostgreSQL的timestamp格式
        createdAt = new Date(userData.createdAt).toISOString();
      } else {
        // 如果没有原始注册时间，使用当前时间
        createdAt = new Date().toISOString();
      }

      // 处理VIP信息
      let vipInfo = {};
      if (userData.vip && Object.keys(userData.vip).length > 0) {
        vipInfo = {
          expireAt: userData.vip.expireAt || 0,
          type: VIP_TYPE_MAPPING[userData.vip.type] || userData.vip.type || null,
          quotaChars: userData.vip.quotaChars,
          usedChars: userData.vip.usedChars || 0
        };
      } else {
        // 无VIP信息的用户设置默认值
        vipInfo = {
          expireAt: 0,
          type: null,
          quotaChars: undefined,
          usedChars: undefined
        };
      }

      // 处理使用统计
      let usageStats = {};
      if (userData.usage && Object.keys(userData.usage).length > 0) {
        usageStats = {
          totalChars: userData.usage.totalChars || 0,
          monthlyChars: userData.usage.monthlyChars || 0,
          monthlyResetAt: userData.usage.monthlyResetAt || getNextMonthResetTimestamp()
        };
      } else {
        // 无使用统计的用户设置默认值
        usageStats = {
          totalChars: 0,
          monthlyChars: 0,
          monthlyResetAt: getNextMonthResetTimestamp()
        };
      }

      return {
        username: userData.username,
        passwordHash: userData.passwordHash,
        email: userData.email || null,
        createdAt: createdAt,
        vipInfo: vipInfo,
        usageStats: usageStats,
        originalData: userData // 保留原始数据用于调试
      };

    } catch (error) {
      throw new Error(`数据转换失败: ${error.message}`);
    }
  }

  // 插入单个用户到数据库
  async insertUser(transformedUser) {
    const client = await this.pgPool.connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查用户是否已存在
      const existingUser = await client.query(
        'SELECT username FROM users WHERE username = $1',
        [transformedUser.username]
      );
      
      if (existingUser.rows.length > 0) {
        log('yellow', `⚠️  用户 ${transformedUser.username} 已存在，跳过`);
        this.stats.skipped++;
        await client.query('ROLLBACK');
        return { success: true, action: 'skipped' };
      }
      
      // 插入用户数据
      await client.query(`
        INSERT INTO users (
          username,
          password_hash,
          email,
          vip_info,
          usage_stats,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
      `, [
        transformedUser.username,
        transformedUser.passwordHash,
        transformedUser.email,
        JSON.stringify(transformedUser.vipInfo),
        JSON.stringify(transformedUser.usageStats),
        transformedUser.createdAt
      ]);
      
      await client.query('COMMIT');
      this.stats.success++;
      
      return { success: true, action: 'inserted' };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 执行用户数据迁移
  async migrateUsers(backupData) {
    log('blue', '🚀 开始迁移用户数据...\n');
    
    const userData = backupData.data;
    const userKeys = Object.keys(userData).filter(key => key.startsWith('user:'));
    
    this.stats.total = userKeys.length;
    log('cyan', `📊 找到 ${this.stats.total} 个用户待迁移`);
    
    let processedCount = 0;
    
    for (const key of userKeys) {
      processedCount++;
      const username = key.replace('user:', '');
      
      try {
        // 显示进度
        process.stdout.write(`\r[${processedCount}/${this.stats.total}] 处理用户: ${username.padEnd(20)}`);
        
        // 转换用户数据
        const transformedUser = this.transformUserData(key, userData[key]);
        
        // 插入数据库
        const result = await this.insertUser(transformedUser);
        
        if (result.action === 'inserted') {
          // 显示详细信息（仅对成功插入的用户）
          const vipType = transformedUser.vipInfo.type || '无VIP';
          const isLegacy = transformedUser.vipInfo.quotaChars === undefined ? '老用户' : '新用户';
          process.stdout.write(` ✅ ${vipType} (${isLegacy})\n`);
        }
        
      } catch (error) {
        this.stats.failed++;
        this.stats.errors.push({ username, error: error.message });
        process.stdout.write(` ❌ 失败: ${error.message}\n`);
      }
    }
    
    console.log(); // 换行
  }

  // 显示迁移统计
  displayStats() {
    log('cyan', '\n📊 迁移统计结果');
    log('blue', '=' .repeat(50));
    log('green', `✅ 成功迁移: ${this.stats.success} 个用户`);
    log('yellow', `⚠️  跳过重复: ${this.stats.skipped} 个用户`);
    log('red', `❌ 迁移失败: ${this.stats.failed} 个用户`);
    log('blue', `📊 总计处理: ${this.stats.total} 个用户`);
    
    const successRate = ((this.stats.success / this.stats.total) * 100).toFixed(1);
    log('cyan', `📈 成功率: ${successRate}%`);
    
    // 显示错误详情
    if (this.stats.errors.length > 0) {
      log('red', '\n❌ 错误详情:');
      this.stats.errors.slice(0, 10).forEach(({ username, error }) => {
        log('red', `  • ${username}: ${error}`);
      });
      
      if (this.stats.errors.length > 10) {
        log('red', `  ... 还有 ${this.stats.errors.length - 10} 个错误`);
      }
    }
  }

  // 执行完整迁移流程
  async migrate(backupFilePath) {
    try {
      log('blue', '🚀 开始用户数据迁移...\n');
      
      // 确定备份文件路径
      const targetFile = backupFilePath || await this.findLatestUserBackup();
      log('cyan', `📁 使用备份文件: ${path.basename(targetFile)}`);
      
      // 加载备份数据
      const backupData = await this.loadBackupData(targetFile);
      log('green', `✅ 备份数据加载成功`);
      log('blue', `📊 备份信息: ${backupData.metadata.totalKeys} 个键，下载时间: ${backupData.metadata.downloadTime}`);
      
      // 测试数据库连接
      await this.pgPool.query('SELECT 1');
      log('green', '✅ 数据库连接成功');
      
      // 执行迁移
      await this.migrateUsers(backupData);
      
      // 显示统计结果
      this.displayStats();
      
      log('green', '\n🎉 用户数据迁移完成！');
      
      // 迁移后建议
      log('yellow', '\n💡 下一步建议:');
      log('yellow', '1. 验证用户登录功能');
      log('yellow', '2. 检查VIP状态和配额计算');
      log('yellow', '3. 测试使用统计功能');
      
    } catch (error) {
      log('red', `❌ 迁移失败: ${error.message}`);
      throw error;
    } finally {
      await this.pgPool.end();
    }
  }
}

// 执行迁移
if (require.main === module) {
  const migrator = new UserDataMigrator();
  const backupFilePath = process.argv[2]; // 可选的备份文件路径
  
  migrator.migrate(backupFilePath).catch(error => {
    log('red', `迁移失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = UserDataMigrator;
