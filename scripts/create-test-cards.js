#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');
const { getAllPackages } = require('../src/utils/config');

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

// 生成符合验证器要求的32位卡密
function generateCardCode(length = 32) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 创建测试卡密
async function createTestCards() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    log('blue', '🎫 开始创建测试卡密...\n');

    const packages = getAllPackages();
    const testCards = [];

    // 为每种套餐类型创建测试卡密
    for (const [packageType, packageConfig] of Object.entries(packages)) {
      const cardCode = generateCardCode();
      
      // 构建package_info，与参考代码的PACKAGES配置完全一致
      const packageInfo = {
        type: packageType,
        duration: packageConfig.days * 86400000, // 转换为毫秒
        quotaChars: packageConfig.chars,
        price: packageConfig.price,
        description: getPackageDescription(packageType, packageConfig)
      };

      testCards.push({
        code: cardCode,
        packageType: packageType,
        packageInfo: packageInfo
      });

      log('cyan', `📋 ${getPackageDescription(packageType, packageConfig)}`);
      log('green', `   🎫 卡密: ${cardCode}`);
      log('yellow', `   ⏰ 时长: ${packageConfig.days} 天`);
      log('magenta', `   📊 配额: ${packageConfig.chars.toLocaleString()} 字符`);
      log('blue', `   💰 价格: ¥${packageConfig.price}\n`);
    }

    // 批量插入数据库
    log('blue', '💾 正在保存到数据库...');
    
    for (const card of testCards) {
      await pool.query(`
        INSERT INTO cards (code, package_type, status, package_info, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
        ON CONFLICT (code) DO UPDATE SET
          package_type = EXCLUDED.package_type,
          package_info = EXCLUDED.package_info
      `, [
        card.code,
        card.packageType,
        'unused',
        JSON.stringify(card.packageInfo)
      ]);
    }

    log('green', `✅ 成功创建 ${testCards.length} 张测试卡密！`);
    
    // 验证创建结果
    const result = await pool.query('SELECT COUNT(*) FROM cards WHERE status = $1', ['unused']);
    log('blue', `📊 数据库中共有 ${result.rows[0].count} 张未使用的卡密`);

    // 显示使用说明
    log('yellow', '\n📖 使用说明：');
    log('cyan', '1. 复制上面的卡密代码');
    log('cyan', '2. 在前端界面的"卡密充值"页面输入卡密');
    log('cyan', '3. 点击"使用卡密"按钮进行充值');
    log('cyan', '4. 系统会自动根据卡密类型分配相应的VIP权限和字符配额');

  } catch (error) {
    log('red', `❌ 创建测试卡密失败: ${error.message}`);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
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

// 主函数
async function main() {
  try {
    await createTestCards();
  } catch (error) {
    log('red', `❌ 程序执行失败: ${error.message}`);
    process.exit(1);
  }
}

// 执行脚本
if (require.main === module) {
  main();
}

module.exports = { createTestCards };
