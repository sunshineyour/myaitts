#!/usr/bin/env node

/**
 * 密码哈希验证工具
 * 用于验证密码哈希值和测试密码加密算法
 * 
 * 使用方法:
 * node scripts/verify_password_hash.js <hash> [test_passwords...]
 * 
 * 示例:
 * node scripts/verify_password_hash.js "lRXeSeXTgpXQ2tMM2B1PxleXirwaJwd8PYPPYOslCuU=" "123456" "password" "555"
 */

require('dotenv').config();
const crypto = require('crypto');

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

// 密码加密函数（与authService.js中的bcrypt函数相同）
async function bcrypt(password) {
  const data = password + process.env.JWT_SECRET;
  const hash = crypto.createHash('sha256').update(data).digest();
  return Buffer.from(hash).toString('base64');
}

// 常见密码列表
const COMMON_PASSWORDS = [
  '123456',
  'password',
  '123456789',
  '12345678',
  '12345',
  '1234567',
  '1234567890',
  'qwerty',
  'abc123',
  'password123',
  'admin',
  'root',
  'user',
  'test',
  '555',        // 基于用户名的密码
  'user555',    // 用户名相关
  '555555',     // 重复数字
  '000000',
  '111111',
  '222222',
  '333333',
  '444444',
  '666666',
  '777777',
  '888888',
  '999999'
];

class PasswordHashVerifier {
  constructor() {
    this.jwtSecret = process.env.JWT_SECRET;
    if (!this.jwtSecret) {
      log('red', '❌ 错误: 未找到JWT_SECRET环境变量');
      log('yellow', '请确保.env文件中配置了JWT_SECRET');
      process.exit(1);
    }
  }

  // 验证单个密码
  async verifyPassword(targetHash, password) {
    try {
      const computedHash = await bcrypt(password);
      const isMatch = computedHash === targetHash;
      
      return {
        password,
        computedHash,
        isMatch
      };
    } catch (error) {
      return {
        password,
        error: error.message,
        isMatch: false
      };
    }
  }

  // 批量验证密码
  async verifyMultiplePasswords(targetHash, passwords) {
    log('cyan', '\n🔍 开始密码验证...');
    log('blue', '=' .repeat(60));
    log('yellow', `目标哈希: ${targetHash}`);
    log('yellow', `JWT_SECRET: ${this.jwtSecret.substring(0, 10)}...`);
    log('blue', '=' .repeat(60));
    
    const results = [];
    let foundMatch = false;
    
    for (let i = 0; i < passwords.length; i++) {
      const password = passwords[i];
      process.stdout.write(`\r[${i + 1}/${passwords.length}] 测试密码: ${password.padEnd(20)}`);
      
      const result = await this.verifyPassword(targetHash, password);
      results.push(result);
      
      if (result.isMatch) {
        foundMatch = true;
        console.log(); // 换行
        log('green', `\n🎉 找到匹配密码!`);
        log('green', `密码: "${password}"`);
        log('green', `哈希: ${result.computedHash}`);
        break;
      }
      
      // 添加小延迟避免CPU过载
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    
    console.log(); // 换行
    
    if (!foundMatch) {
      log('red', '\n❌ 未找到匹配的密码');
      log('yellow', '可能的原因:');
      log('yellow', '1. 密码不在测试列表中');
      log('yellow', '2. JWT_SECRET不正确');
      log('yellow', '3. 哈希算法不匹配');
    }
    
    return { results, foundMatch };
  }

  // 显示加密算法详情
  async showEncryptionDetails(password) {
    log('cyan', '\n🔧 加密算法详情');
    log('blue', '=' .repeat(60));

    const plaintext = password + this.jwtSecret;
    log('yellow', `原始密码: "${password}"`);
    log('yellow', `JWT_SECRET: "${this.jwtSecret}"`);
    log('yellow', `拼接字符串: "${plaintext}"`);

    // 步骤1: SHA256哈希
    const hash = crypto.createHash('sha256').update(plaintext).digest();
    log('cyan', `SHA256哈希 (hex): ${hash.toString('hex')}`);
    log('cyan', `SHA256哈希 (buffer): [${Array.from(hash).join(', ')}]`);

    // 步骤2: Base64编码
    const base64Hash = Buffer.from(hash).toString('base64');
    log('green', `最终结果 (Base64): ${base64Hash}`);

    return base64Hash;
  }

  // 分析特定密码的加密过程
  async analyzePassword(password, targetHash) {
    log('cyan', `\n🔍 分析密码: "${password}"`);
    log('blue', '=' .repeat(60));

    const computedHash = await this.showEncryptionDetails(password);

    log('blue', '\n📊 比较结果:');
    log('yellow', `目标哈希: ${targetHash}`);
    log('yellow', `计算哈希: ${computedHash}`);

    const isMatch = computedHash === targetHash;
    if (isMatch) {
      log('green', '✅ 匹配成功！');
    } else {
      log('red', '❌ 不匹配');

      // 显示差异
      log('cyan', '\n🔍 差异分析:');
      for (let i = 0; i < Math.max(targetHash.length, computedHash.length); i++) {
        if (targetHash[i] !== computedHash[i]) {
          log('red', `位置 ${i}: 目标="${targetHash[i] || 'undefined'}" vs 计算="${computedHash[i] || 'undefined'}"`);
          break;
        }
      }
    }

    return isMatch;
  }

  // 执行验证
  async verify(targetHash, testPasswords = []) {
    try {
      log('blue', '🔐 密码哈希验证工具');
      log('blue', '=' .repeat(60));
      
      // 合并测试密码和常见密码
      const allPasswords = [...new Set([...testPasswords, ...COMMON_PASSWORDS])];
      
      log('cyan', `准备测试 ${allPasswords.length} 个密码...`);
      
      // 执行验证
      const { results, foundMatch } = await this.verifyMultiplePasswords(targetHash, allPasswords);
      
      // 如果找到匹配，显示详细信息
      if (foundMatch) {
        const matchedResult = results.find(r => r.isMatch);
        await this.showEncryptionDetails(matchedResult.password);
      } else {
        // 显示一些测试结果
        log('yellow', '\n📋 部分测试结果:');
        results.slice(0, 5).forEach(result => {
          log('cyan', `  "${result.password}" -> ${result.computedHash.substring(0, 20)}...`);
        });
      }
      
      log('blue', '\n💡 提示:');
      log('cyan', '如果需要测试特定密码，请作为参数传入:');
      log('cyan', 'node scripts/verify_password_hash.js "hash" "password1" "password2"');
      
    } catch (error) {
      log('red', `❌ 验证失败: ${error.message}`);
      throw error;
    }
  }
}

// 执行验证
if (require.main === module) {
  const [,, targetHash, ...testPasswords] = process.argv;
  
  if (!targetHash) {
    log('red', '❌ 请提供要验证的哈希值');
    log('yellow', '使用方法: node scripts/verify_password_hash.js <hash> [test_passwords...]');
    log('yellow', '示例: node scripts/verify_password_hash.js "lRXeSeXTgpXQ2tMM2B1PxleXirwaJwd8PYPPYOslCuU=" "555"');
    process.exit(1);
  }
  
  const verifier = new PasswordHashVerifier();
  verifier.verify(targetHash, testPasswords).catch(error => {
    log('red', `验证失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = PasswordHashVerifier;
