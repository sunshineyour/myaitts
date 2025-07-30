#!/usr/bin/env node

/**
 * 数据库用户信息查询脚本
 * 用于查询和分析PostgreSQL数据库中的用户数据
 * 
 * 使用方法:
 * node scripts/query_users.js [command] [options]
 * 
 * 命令:
 * stats          - 显示用户统计信息
 * list [limit]   - 列出用户（默认显示10个）
 * search <term>  - 搜索用户（用户名或邮箱）
 * user <username> - 查看特定用户详情
 * vip [type]     - 查看VIP用户（可指定类型）
 * legacy         - 查看老用户（无配额限制）
 * quota          - 查看配额使用情况
 * 
 * 示例:
 * node scripts/query_users.js stats
 * node scripts/query_users.js list 20
 * node scripts/query_users.js search eluzh
 * node scripts/query_users.js user eluzh
 * node scripts/query_users.js vip M
 * node scripts/query_users.js legacy
 * node scripts/query_users.js quota
 */

require('dotenv').config();
const { Pool } = require('pg');

// 数据库连接配置
const DB_CONFIG = {
  connectionString: process.env.DATABASE_URL
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

// 格式化时间戳
function formatTimestamp(timestamp) {
  if (!timestamp) return '未设置';
  const date = new Date(parseInt(timestamp));
  return date.toLocaleString('zh-CN');
}

// 格式化字节数
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 字符';
  return bytes.toLocaleString() + ' 字符';
}

// 格式化VIP状态
function formatVipStatus(vipInfo) {
  if (!vipInfo || !vipInfo.type) {
    return '无VIP';
  }
  
  const expireAt = parseInt(vipInfo.expireAt);
  const now = Date.now();
  const isExpired = expireAt > 0 && expireAt < now;
  const isLegacy = vipInfo.quotaChars === undefined;
  
  let status = vipInfo.type;
  if (isLegacy) {
    status += ' (老用户-无限)';
  } else if (expireAt === 0) {
    status += ' (永久)';
  } else if (isExpired) {
    status += ' (已过期)';
  } else {
    status += ` (${formatTimestamp(expireAt)}到期)`;
  }
  
  return status;
}

class UserQueryTool {
  constructor() {
    this.pgPool = new Pool(DB_CONFIG);
  }

  // 显示用户统计信息
  async showStats() {
    try {
      log('cyan', '\n📊 用户数据统计');
      log('blue', '=' .repeat(60));
      
      // 总用户数
      const totalResult = await this.pgPool.query('SELECT COUNT(*) as count FROM users');
      const totalUsers = parseInt(totalResult.rows[0].count);
      log('green', `总用户数: ${totalUsers}`);
      
      // VIP类型分布
      const vipResult = await this.pgPool.query(`
        SELECT 
          COALESCE(vip_info->>'type', '无VIP') as vip_type,
          COUNT(*) as count
        FROM users 
        GROUP BY vip_info->>'type'
        ORDER BY count DESC
      `);
      
      log('blue', '\nVIP类型分布:');
      vipResult.rows.forEach(row => {
        const percentage = ((row.count / totalUsers) * 100).toFixed(1);
        log('cyan', `  ${row.vip_type}: ${row.count} (${percentage}%)`);
      });
      
      // 老用户vs新用户
      const userTypeResult = await this.pgPool.query(`
        SELECT 
          CASE 
            WHEN vip_info->>'quotaChars' IS NULL THEN '老用户(无限配额)'
            ELSE '新用户(有配额)'
          END as user_type,
          COUNT(*) as count
        FROM users 
        GROUP BY (vip_info->>'quotaChars' IS NULL)
      `);
      
      log('blue', '\n用户类型分布:');
      userTypeResult.rows.forEach(row => {
        const percentage = ((row.count / totalUsers) * 100).toFixed(1);
        log('cyan', `  ${row.user_type}: ${row.count} (${percentage}%)`);
      });
      
      // 邮箱完整性
      const emailResult = await this.pgPool.query(`
        SELECT 
          CASE 
            WHEN email IS NOT NULL THEN '有邮箱'
            ELSE '无邮箱'
          END as email_status,
          COUNT(*) as count
        FROM users 
        GROUP BY (email IS NOT NULL)
      `);
      
      log('blue', '\n邮箱信息完整性:');
      emailResult.rows.forEach(row => {
        const percentage = ((row.count / totalUsers) * 100).toFixed(1);
        log('cyan', `  ${row.email_status}: ${row.count} (${percentage}%)`);
      });
      
      // 最近注册用户
      const recentResult = await this.pgPool.query(`
        SELECT COUNT(*) as count 
        FROM users 
        WHERE created_at > NOW() - INTERVAL '7 days'
      `);
      log('blue', `\n最近7天新注册: ${recentResult.rows[0].count} 个用户`);
      
    } catch (error) {
      log('red', `❌ 查询统计失败: ${error.message}`);
    }
  }

  // 列出用户
  async listUsers(limit = 10) {
    try {
      log('cyan', `\n📋 用户列表 (显示前${limit}个)`);
      log('blue', '=' .repeat(80));
      
      const result = await this.pgPool.query(`
        SELECT 
          username,
          email,
          vip_info,
          usage_stats,
          created_at
        FROM users 
        ORDER BY created_at DESC 
        LIMIT $1
      `, [limit]);
      
      if (result.rows.length === 0) {
        log('yellow', '未找到用户数据');
        return;
      }
      
      result.rows.forEach((user, index) => {
        const vipStatus = formatVipStatus(user.vip_info);
        const email = user.email || '未设置';
        const createdAt = user.created_at.toLocaleString('zh-CN');
        
        log('green', `${index + 1}. ${user.username}`);
        log('cyan', `   邮箱: ${email}`);
        log('cyan', `   VIP: ${vipStatus}`);
        log('cyan', `   注册: ${createdAt}`);
        
        if (user.usage_stats && user.usage_stats.totalChars) {
          log('cyan', `   使用: ${formatBytes(user.usage_stats.totalChars)}`);
        }
        console.log();
      });
      
    } catch (error) {
      log('red', `❌ 查询用户列表失败: ${error.message}`);
    }
  }

  // 搜索用户
  async searchUsers(searchTerm) {
    try {
      log('cyan', `\n🔍 搜索用户: "${searchTerm}"`);
      log('blue', '=' .repeat(60));
      
      const result = await this.pgPool.query(`
        SELECT 
          username,
          email,
          vip_info,
          usage_stats,
          created_at
        FROM users 
        WHERE username ILIKE $1 OR email ILIKE $1
        ORDER BY username
      `, [`%${searchTerm}%`]);
      
      if (result.rows.length === 0) {
        log('yellow', '未找到匹配的用户');
        return;
      }
      
      log('green', `找到 ${result.rows.length} 个匹配用户:`);
      
      result.rows.forEach((user, index) => {
        const vipStatus = formatVipStatus(user.vip_info);
        const email = user.email || '未设置';
        
        log('cyan', `${index + 1}. ${user.username} (${email}) - ${vipStatus}`);
      });
      
    } catch (error) {
      log('red', `❌ 搜索用户失败: ${error.message}`);
    }
  }

  // 查看特定用户详情
  async showUserDetail(username) {
    try {
      log('cyan', `\n👤 用户详情: ${username}`);
      log('blue', '=' .repeat(60));
      
      const result = await this.pgPool.query(`
        SELECT
          username,
          email,
          vip_info,
          usage_stats,
          created_at,
          updated_at
        FROM users WHERE username = $1
      `, [username]);
      
      if (result.rows.length === 0) {
        log('yellow', '用户不存在');
        return;
      }
      
      const user = result.rows[0];
      
      log('green', '基本信息:');
      log('cyan', `  用户名: ${user.username}`);
      log('cyan', `  邮箱: ${user.email || '未设置'}`);
      log('cyan', `  注册时间: ${user.created_at.toLocaleString('zh-CN')}`);
      log('cyan', `  更新时间: ${user.updated_at.toLocaleString('zh-CN')}`);
      
      log('green', '\nVIP信息:');
      if (user.vip_info && Object.keys(user.vip_info).length > 0) {
        const vip = user.vip_info;
        log('cyan', `  类型: ${vip.type || '无'}`);
        log('cyan', `  到期时间: ${formatTimestamp(vip.expireAt)}`);
        
        if (vip.quotaChars !== undefined) {
          log('cyan', `  配额: ${formatBytes(vip.quotaChars)}`);
          log('cyan', `  已用: ${formatBytes(vip.usedChars || 0)}`);
          const remaining = vip.quotaChars - (vip.usedChars || 0);
          log('cyan', `  剩余: ${formatBytes(remaining)}`);
          const usagePercent = ((vip.usedChars || 0) / vip.quotaChars * 100).toFixed(1);
          log('cyan', `  使用率: ${usagePercent}%`);
        } else {
          log('cyan', `  配额: 无限制 (老用户)`);
        }
      } else {
        log('cyan', '  无VIP信息');
      }
      
      log('green', '\n使用统计:');
      if (user.usage_stats && Object.keys(user.usage_stats).length > 0) {
        const usage = user.usage_stats;
        log('cyan', `  总使用: ${formatBytes(usage.totalChars || 0)}`);
        log('cyan', `  本月使用: ${formatBytes(usage.monthlyChars || 0)}`);
        log('cyan', `  月度重置: ${formatTimestamp(usage.monthlyResetAt)}`);
      } else {
        log('cyan', '  无使用统计');
      }
      
    } catch (error) {
      log('red', `❌ 查询用户详情失败: ${error.message}`);
    }
  }

  // 查看VIP用户
  async showVipUsers(vipType = null) {
    try {
      const title = vipType ? `VIP用户 (${vipType}类型)` : 'VIP用户';
      log('cyan', `\n💎 ${title}`);
      log('blue', '=' .repeat(60));
      
      let query = `
        SELECT 
          username,
          email,
          vip_info,
          created_at
        FROM users 
        WHERE vip_info->>'type' IS NOT NULL
      `;
      const params = [];
      
      if (vipType) {
        query += ` AND vip_info->>'type' = $1`;
        params.push(vipType);
      }
      
      query += ` ORDER BY (vip_info->>'expireAt')::bigint DESC`;
      
      const result = await this.pgPool.query(query, params);
      
      if (result.rows.length === 0) {
        log('yellow', '未找到VIP用户');
        return;
      }
      
      log('green', `找到 ${result.rows.length} 个VIP用户:`);
      
      result.rows.forEach((user, index) => {
        const vip = user.vip_info;
        const expireAt = formatTimestamp(vip.expireAt);
        const email = user.email || '未设置';
        const isLegacy = vip.quotaChars === undefined ? ' (老用户)' : '';
        
        log('cyan', `${index + 1}. ${user.username} (${email})`);
        log('cyan', `   类型: ${vip.type}${isLegacy} | 到期: ${expireAt}`);
        
        if (vip.quotaChars !== undefined) {
          const usagePercent = ((vip.usedChars || 0) / vip.quotaChars * 100).toFixed(1);
          log('cyan', `   配额: ${formatBytes(vip.usedChars || 0)}/${formatBytes(vip.quotaChars)} (${usagePercent}%)`);
        }
        console.log();
      });
      
    } catch (error) {
      log('red', `❌ 查询VIP用户失败: ${error.message}`);
    }
  }

  // 查看老用户
  async showLegacyUsers() {
    try {
      log('cyan', '\n👴 老用户 (无配额限制)');
      log('blue', '=' .repeat(60));
      
      const result = await this.pgPool.query(`
        SELECT 
          username,
          email,
          vip_info,
          usage_stats,
          created_at
        FROM users 
        WHERE vip_info->>'quotaChars' IS NULL
        ORDER BY created_at
      `);
      
      if (result.rows.length === 0) {
        log('yellow', '未找到老用户');
        return;
      }
      
      log('green', `找到 ${result.rows.length} 个老用户:`);
      
      result.rows.forEach((user, index) => {
        const vipType = user.vip_info?.type || '无VIP';
        const email = user.email || '未设置';
        const totalUsage = user.usage_stats?.totalChars || 0;
        
        log('cyan', `${index + 1}. ${user.username} (${email})`);
        log('cyan', `   VIP类型: ${vipType} | 总使用: ${formatBytes(totalUsage)}`);
      });
      
    } catch (error) {
      log('red', `❌ 查询老用户失败: ${error.message}`);
    }
  }

  // 查看配额使用情况
  async showQuotaUsage() {
    try {
      log('cyan', '\n📊 配额使用情况');
      log('blue', '=' .repeat(80));
      
      const result = await this.pgPool.query(`
        SELECT 
          username,
          vip_info,
          usage_stats
        FROM users 
        WHERE vip_info->>'quotaChars' IS NOT NULL
        ORDER BY 
          ((vip_info->>'usedChars')::bigint::float / (vip_info->>'quotaChars')::bigint::float) DESC
      `);
      
      if (result.rows.length === 0) {
        log('yellow', '未找到有配额限制的用户');
        return;
      }
      
      log('green', `配额使用排行 (共${result.rows.length}个用户):`);
      
      result.rows.slice(0, 20).forEach((user, index) => {
        const vip = user.vip_info;
        const quotaChars = parseInt(vip.quotaChars);
        const usedChars = parseInt(vip.usedChars || 0);
        const usagePercent = (usedChars / quotaChars * 100).toFixed(1);
        
        const statusColor = usagePercent > 90 ? 'red' : usagePercent > 70 ? 'yellow' : 'cyan';
        
        log(statusColor, `${index + 1}. ${user.username}`);
        log(statusColor, `   ${formatBytes(usedChars)}/${formatBytes(quotaChars)} (${usagePercent}%)`);
        log(statusColor, `   VIP: ${vip.type}`);
        console.log();
      });
      
      if (result.rows.length > 20) {
        log('blue', `... 还有 ${result.rows.length - 20} 个用户`);
      }
      
    } catch (error) {
      log('red', `❌ 查询配额使用失败: ${error.message}`);
    }
  }

  // 查看用户完整信息（包含密码哈希，仅供管理员调试使用）
  async showUserFullDetail(username) {
    try {
      log('red', '\n🔒 管理员模式 - 用户完整信息');
      log('red', '⚠️  此模式会显示敏感信息，仅供调试使用');
      log('blue', '=' .repeat(60));

      const result = await this.pgPool.query(`
        SELECT * FROM users WHERE username = $1
      `, [username]);

      if (result.rows.length === 0) {
        log('yellow', '用户不存在');
        return;
      }

      const user = result.rows[0];

      log('green', '基本信息:');
      log('cyan', `  用户名: ${user.username}`);
      log('cyan', `  邮箱: ${user.email || '未设置'}`);
      log('cyan', `  注册时间: ${user.created_at.toLocaleString('zh-CN')}`);
      log('cyan', `  更新时间: ${user.updated_at.toLocaleString('zh-CN')}`);

      log('red', '\n敏感信息:');
      log('red', `  密码哈希: ${user.password_hash}`);

      log('green', '\nVIP信息:');
      log('cyan', `  ${JSON.stringify(user.vip_info, null, 2)}`);

      log('green', '\n使用统计:');
      log('cyan', `  ${JSON.stringify(user.usage_stats, null, 2)}`);

    } catch (error) {
      log('red', `❌ 查询用户完整信息失败: ${error.message}`);
    }
  }

  // 显示帮助信息
  showHelp() {
    log('cyan', '\n📖 用户查询工具使用说明');
    log('blue', '=' .repeat(60));
    log('green', '可用命令:');
    log('cyan', '  stats          - 显示用户统计信息');
    log('cyan', '  list [limit]   - 列出用户（默认10个）');
    log('cyan', '  search <term>  - 搜索用户（用户名或邮箱）');
    log('cyan', '  user <username> - 查看特定用户详情');
    log('cyan', '  vip [type]     - 查看VIP用户（可指定类型）');
    log('cyan', '  legacy         - 查看老用户（无配额限制）');
    log('cyan', '  quota          - 查看配额使用情况');
    log('red', '  admin <username> - 查看用户完整信息（含密码哈希）');
    log('cyan', '  help           - 显示此帮助信息');

    log('yellow', '\n示例:');
    log('cyan', '  node scripts/query_users.js stats');
    log('cyan', '  node scripts/query_users.js list 20');
    log('cyan', '  node scripts/query_users.js search eluzh');
    log('cyan', '  node scripts/query_users.js user eluzh');
    log('cyan', '  node scripts/query_users.js vip M');
    log('cyan', '  node scripts/query_users.js legacy');
    log('cyan', '  node scripts/query_users.js quota');
    log('red', '  node scripts/query_users.js admin eluzh  # 管理员模式');

    log('red', '\n⚠️  安全提醒:');
    log('red', '  admin 命令会显示密码哈希等敏感信息');
    log('red', '  仅在必要的调试场景下使用');
  }

  // 执行查询
  async execute(command, ...args) {
    try {
      // 测试数据库连接
      await this.pgPool.query('SELECT 1');
      
      switch (command) {
        case 'stats':
          await this.showStats();
          break;
        case 'list':
          const limit = parseInt(args[0]) || 10;
          await this.listUsers(limit);
          break;
        case 'search':
          if (!args[0]) {
            log('red', '❌ 请提供搜索关键词');
            return;
          }
          await this.searchUsers(args[0]);
          break;
        case 'user':
          if (!args[0]) {
            log('red', '❌ 请提供用户名');
            return;
          }
          await this.showUserDetail(args[0]);
          break;
        case 'vip':
          await this.showVipUsers(args[0]);
          break;
        case 'legacy':
          await this.showLegacyUsers();
          break;
        case 'quota':
          await this.showQuotaUsage();
          break;
        case 'admin':
          if (!args[0]) {
            log('red', '❌ 请提供用户名');
            log('red', '⚠️  admin命令会显示敏感信息，请谨慎使用');
            return;
          }
          log('yellow', '⚠️  即将显示敏感信息，请确认您有权限查看');
          await this.showUserFullDetail(args[0]);
          break;
        case 'help':
        default:
          this.showHelp();
          break;
      }
      
    } catch (error) {
      log('red', `❌ 执行失败: ${error.message}`);
    } finally {
      await this.pgPool.end();
    }
  }
}

// 执行查询
if (require.main === module) {
  const [,, command, ...args] = process.argv;
  const queryTool = new UserQueryTool();
  
  queryTool.execute(command || 'help', ...args).catch(error => {
    log('red', `查询失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = UserQueryTool;
