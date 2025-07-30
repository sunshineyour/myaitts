#!/usr/bin/env node

/**
 * Cloudflare KV数据下载工具
 * 用于从Cloudflare KV存储中下载所有数据并保存为本地JSON文件
 * 
 * 使用方法:
 * 1. 设置环境变量: CF_ACCOUNT_ID, CF_API_TOKEN
 * 2. 运行: node scripts/download_kv_data.js
 * 
 * 输出文件:
 * - data/kv_backup_users_YYYYMMDD_HHMMSS.json
 * - data/kv_backup_cards_YYYYMMDD_HHMMSS.json
 * - data/kv_backup_tts_status_YYYYMMDD_HHMMSS.json
 * - data/kv_backup_voice_mappings_YYYYMMDD_HHMMSS.json
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');

// Cloudflare KV配置
const KV_CONFIG = {
  // 从环境变量获取Cloudflare API配置
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  
  // KV命名空间ID (与migrate_data.js保持一致)
  KV_NAMESPACES: {
    USERS: '8341ec47189543b48818f57e9ca4e5e0',
    CARDS: '69d6e32b35dd4a0bb996584ebf3f5b27',
    TTS_STATUS: '0ae5fbcb1ed34dab9357ae1a838b34f3',
    VOICE_MAPPINGS: '065bf81a6ad347d19709b402659608f5'
  }
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

class KVDataDownloader {
  constructor() {
    this.validateConfig();
    this.dataDir = path.join(__dirname, '..', 'data');
    this.timestamp = this.getTimestamp();
  }

  // 验证配置
  validateConfig() {
    if (!KV_CONFIG.CF_ACCOUNT_ID || !KV_CONFIG.CF_API_TOKEN) {
      log('red', '❌ 错误: 缺少Cloudflare API配置');
      log('yellow', '请设置以下环境变量:');
      log('yellow', '  CF_ACCOUNT_ID=your_account_id');
      log('yellow', '  CF_API_TOKEN=your_api_token');
      log('yellow', '\n获取方式:');
      log('yellow', '1. 登录 Cloudflare Dashboard');
      log('yellow', '2. 右上角 "My Profile" -> "API Tokens"');
      log('yellow', '3. 创建自定义令牌，权限: Zone:Zone:Read, Account:Cloudflare Workers:Edit');
      process.exit(1);
    }
  }

  // 生成时间戳
  getTimestamp() {
    const now = new Date();
    return now.toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, '')
      .replace('T', '_');
  }

  // 确保数据目录存在
  async ensureDataDir() {
    try {
      await fs.access(this.dataDir);
    } catch {
      await fs.mkdir(this.dataDir, { recursive: true });
      log('blue', `📁 创建数据目录: ${this.dataDir}`);
    }
  }

  // 从Cloudflare KV获取所有键
  async fetchKVKeys(namespaceId) {
    try {
      log('blue', `🔍 获取KV命名空间 ${namespaceId} 的所有键...`);
      
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${KV_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/keys`,
        {
          headers: {
            'Authorization': `Bearer ${KV_CONFIG.CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
      }
      
      const { result, success, errors } = await response.json();
      
      if (!success) {
        throw new Error(`API错误: ${JSON.stringify(errors)}`);
      }
      
      log('green', `✅ 找到 ${result.length} 个键`);
      return result;
      
    } catch (error) {
      log('red', `❌ 获取键列表失败: ${error.message}`);
      throw error;
    }
  }

  // 从Cloudflare KV获取单个键的值
  async fetchKVValue(namespaceId, keyName) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${KV_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(keyName)}`,
        {
          headers: {
            'Authorization': `Bearer ${KV_CONFIG.CF_API_TOKEN}`
          }
        }
      );
      
      if (!response.ok) {
        log('yellow', `⚠️  获取键 "${keyName}" 失败: HTTP ${response.status}`);
        return null;
      }
      
      return await response.text();
      
    } catch (error) {
      log('yellow', `⚠️  获取键 "${keyName}" 失败: ${error.message}`);
      return null;
    }
  }

  // 下载指定命名空间的所有数据
  async downloadNamespaceData(namespaceName, namespaceId) {
    try {
      log('cyan', `\n🚀 开始下载 ${namespaceName} 数据...`);
      
      // 获取所有键
      const keys = await this.fetchKVKeys(namespaceId);
      
      if (keys.length === 0) {
        log('yellow', `⚠️  命名空间 ${namespaceName} 为空`);
        return { keys: [], data: {}, stats: { total: 0, success: 0, failed: 0 } };
      }
      
      // 下载所有值
      const data = {};
      const stats = { total: keys.length, success: 0, failed: 0 };
      
      log('blue', `📥 开始下载 ${keys.length} 个键的数据...`);
      
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const progress = `[${i + 1}/${keys.length}]`;
        
        process.stdout.write(`\r${progress} 下载: ${key.name.substring(0, 50)}...`);
        
        const value = await this.fetchKVValue(namespaceId, key.name);
        
        if (value !== null) {
          data[key.name] = value;
          stats.success++;
        } else {
          stats.failed++;
        }
        
        // 添加小延迟避免API限制
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      console.log(); // 换行
      log('green', `✅ ${namespaceName} 下载完成: ${stats.success}/${stats.total} 成功`);
      
      return { keys, data, stats };
      
    } catch (error) {
      log('red', `❌ 下载 ${namespaceName} 失败: ${error.message}`);
      throw error;
    }
  }

  // 保存数据到文件
  async saveDataToFile(namespaceName, downloadResult) {
    const filename = `kv_backup_${namespaceName.toLowerCase()}_${this.timestamp}.json`;
    const filepath = path.join(this.dataDir, filename);
    
    const backupData = {
      metadata: {
        namespace: namespaceName,
        downloadTime: new Date().toISOString(),
        totalKeys: downloadResult.stats.total,
        successfulKeys: downloadResult.stats.success,
        failedKeys: downloadResult.stats.failed
      },
      keys: downloadResult.keys,
      data: downloadResult.data
    };
    
    await fs.writeFile(filepath, JSON.stringify(backupData, null, 2), 'utf8');
    log('green', `💾 数据已保存: ${filename}`);
    
    return filepath;
  }

  // 分析用户数据结构
  analyzeUserData(userData) {
    const analysis = {
      totalUsers: 0,
      userTypes: {},
      vipTypes: {},
      dataStructures: {
        hasQuotaChars: 0,
        hasUsedChars: 0,
        hasUsage: 0,
        hasEmailVerified: 0,
        hasCreatedAt: 0
      }
    };

    for (const [key, value] of Object.entries(userData)) {
      if (key.startsWith('user:')) {
        analysis.totalUsers++;
        
        try {
          const user = JSON.parse(value);
          
          // 分析VIP类型
          if (user.vip && user.vip.type) {
            analysis.vipTypes[user.vip.type] = (analysis.vipTypes[user.vip.type] || 0) + 1;
          } else {
            analysis.vipTypes['无VIP'] = (analysis.vipTypes['无VIP'] || 0) + 1;
          }
          
          // 分析数据结构
          if (user.vip && user.vip.quotaChars !== undefined) {
            analysis.dataStructures.hasQuotaChars++;
          }
          if (user.vip && user.vip.usedChars !== undefined) {
            analysis.dataStructures.hasUsedChars++;
          }
          if (user.usage) {
            analysis.dataStructures.hasUsage++;
          }
          if (user.emailVerified !== undefined) {
            analysis.dataStructures.hasEmailVerified++;
          }
          if (user.createdAt !== undefined) {
            analysis.dataStructures.hasCreatedAt++;
          }
          
        } catch (error) {
          log('yellow', `⚠️  解析用户数据失败: ${key}`);
        }
      }
    }

    return analysis;
  }

  // 执行完整下载
  async download() {
    try {
      log('blue', '🚀 开始从Cloudflare KV下载数据...\n');
      
      // 确保数据目录存在
      await this.ensureDataDir();
      
      const results = {};
      const savedFiles = [];
      
      // 下载所有命名空间的数据
      for (const [namespaceName, namespaceId] of Object.entries(KV_CONFIG.KV_NAMESPACES)) {
        try {
          const downloadResult = await this.downloadNamespaceData(namespaceName, namespaceId);
          results[namespaceName] = downloadResult;
          
          // 保存到文件
          const filepath = await this.saveDataToFile(namespaceName, downloadResult);
          savedFiles.push(filepath);
          
        } catch (error) {
          log('red', `❌ 下载 ${namespaceName} 失败，跳过...`);
          results[namespaceName] = { error: error.message };
        }
      }
      
      // 显示下载统计
      log('cyan', '\n📊 下载统计:');
      for (const [namespaceName, result] of Object.entries(results)) {
        if (result.error) {
          log('red', `  ${namespaceName}: 失败 - ${result.error}`);
        } else {
          log('green', `  ${namespaceName}: ${result.stats.success}/${result.stats.total} 成功`);
        }
      }
      
      // 特别分析用户数据
      if (results.USERS && results.USERS.data) {
        log('cyan', '\n👥 用户数据分析:');
        const userAnalysis = this.analyzeUserData(results.USERS.data);
        
        log('blue', `  总用户数: ${userAnalysis.totalUsers}`);
        log('blue', `  VIP类型分布:`);
        for (const [type, count] of Object.entries(userAnalysis.vipTypes)) {
          log('cyan', `    ${type}: ${count} 用户`);
        }
        
        log('blue', `  数据结构分析:`);
        log('cyan', `    有quotaChars字段: ${userAnalysis.dataStructures.hasQuotaChars}/${userAnalysis.totalUsers}`);
        log('cyan', `    有usedChars字段: ${userAnalysis.dataStructures.hasUsedChars}/${userAnalysis.totalUsers}`);
        log('cyan', `    有usage字段: ${userAnalysis.dataStructures.hasUsage}/${userAnalysis.totalUsers}`);
        log('cyan', `    有emailVerified字段: ${userAnalysis.dataStructures.hasEmailVerified}/${userAnalysis.totalUsers}`);
        log('cyan', `    有createdAt字段: ${userAnalysis.dataStructures.hasCreatedAt}/${userAnalysis.totalUsers}`);
      }
      
      log('green', '\n🎉 数据下载完成！');
      log('blue', '\n📁 保存的文件:');
      savedFiles.forEach(file => {
        log('cyan', `  ${path.basename(file)}`);
      });
      
      log('yellow', '\n💡 下一步:');
      log('yellow', '1. 检查下载的数据文件');
      log('yellow', '2. 根据需要修改迁移脚本');
      log('yellow', '3. 运行迁移: node scripts/migrate_data.js');
      
    } catch (error) {
      log('red', `❌ 下载失败: ${error.message}`);
      throw error;
    }
  }
}

// 执行下载
if (require.main === module) {
  const downloader = new KVDataDownloader();
  downloader.download().catch(error => {
    log('red', `下载失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = KVDataDownloader;
