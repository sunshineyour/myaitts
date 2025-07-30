#!/usr/bin/env node

/**
 * KV数据分析工具
 * 用于分析从Cloudflare KV下载的数据，检查数据结构和兼容性
 * 
 * 使用方法:
 * node scripts/analyze_kv_data.js [data_file.json]
 * 
 * 如果不指定文件，会自动查找最新的备份文件
 */

const fs = require('fs').promises;
const path = require('path');

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

class KVDataAnalyzer {
  constructor() {
    this.dataDir = path.join(__dirname, '..', 'data');
  }

  // 查找最新的用户数据备份文件
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

  // 加载数据文件
  async loadDataFile(filepath) {
    try {
      const content = await fs.readFile(filepath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`加载数据文件失败: ${error.message}`);
    }
  }

  // 分析用户数据结构
  analyzeUserStructure(userData) {
    const analysis = {
      totalUsers: 0,
      structureTypes: {
        legacy: 0,        // 老用户（无quotaChars）
        newRule: 0,       // 新规则用户（有quotaChars）
        incomplete: 0     // 数据不完整
      },
      vipTypes: {},
      fieldPresence: {
        username: 0,
        passwordHash: 0,
        email: 0,
        emailVerified: 0,
        createdAt: 0,
        quota: 0,
        vip: 0,
        usage: 0
      },
      vipFieldPresence: {
        expireAt: 0,
        type: 0,
        quotaChars: 0,
        usedChars: 0
      },
      usageFieldPresence: {
        totalChars: 0,
        monthlyChars: 0,
        monthlyResetAt: 0
      },
      samples: {
        legacy: null,
        newRule: null,
        incomplete: null
      }
    };

    for (const [key, value] of Object.entries(userData)) {
      if (key.startsWith('user:')) {
        analysis.totalUsers++;
        
        try {
          const user = JSON.parse(value);
          
          // 检查字段存在性
          Object.keys(analysis.fieldPresence).forEach(field => {
            if (user[field] !== undefined) {
              analysis.fieldPresence[field]++;
            }
          });
          
          // 检查VIP字段
          if (user.vip) {
            Object.keys(analysis.vipFieldPresence).forEach(field => {
              if (user.vip[field] !== undefined) {
                analysis.vipFieldPresence[field]++;
              }
            });
            
            // VIP类型统计
            const vipType = user.vip.type || '无类型';
            analysis.vipTypes[vipType] = (analysis.vipTypes[vipType] || 0) + 1;
          }
          
          // 检查usage字段
          if (user.usage) {
            Object.keys(analysis.usageFieldPresence).forEach(field => {
              if (user.usage[field] !== undefined) {
                analysis.usageFieldPresence[field]++;
              }
            });
          }
          
          // 判断用户类型
          if (!user.vip) {
            analysis.structureTypes.incomplete++;
            if (!analysis.samples.incomplete) {
              analysis.samples.incomplete = { key, user };
            }
          } else if (user.vip.quotaChars === undefined) {
            analysis.structureTypes.legacy++;
            if (!analysis.samples.legacy) {
              analysis.samples.legacy = { key, user };
            }
          } else {
            analysis.structureTypes.newRule++;
            if (!analysis.samples.newRule) {
              analysis.samples.newRule = { key, user };
            }
          }
          
        } catch (error) {
          log('yellow', `⚠️  解析用户数据失败: ${key} - ${error.message}`);
          analysis.structureTypes.incomplete++;
        }
      }
    }

    return analysis;
  }

  // 检查数据兼容性
  checkCompatibility(analysis) {
    const compatibility = {
      overall: 'compatible',
      issues: [],
      warnings: [],
      recommendations: []
    };

    // 检查必需字段
    const requiredFields = ['username', 'passwordHash'];
    requiredFields.forEach(field => {
      const coverage = (analysis.fieldPresence[field] / analysis.totalUsers) * 100;
      if (coverage < 100) {
        compatibility.issues.push(`${field}字段缺失率: ${(100 - coverage).toFixed(1)}%`);
        if (coverage < 90) {
          compatibility.overall = 'incompatible';
        }
      }
    });

    // 检查VIP数据完整性
    if (analysis.fieldPresence.vip < analysis.totalUsers) {
      const missingVip = analysis.totalUsers - analysis.fieldPresence.vip;
      compatibility.warnings.push(`${missingVip} 个用户缺少VIP信息`);
    }

    // 检查新旧用户比例
    const legacyRatio = (analysis.structureTypes.legacy / analysis.totalUsers) * 100;
    const newRuleRatio = (analysis.structureTypes.newRule / analysis.totalUsers) * 100;
    
    if (legacyRatio > 0) {
      compatibility.warnings.push(`${legacyRatio.toFixed(1)}% 的用户是老用户（无配额限制）`);
    }
    
    if (newRuleRatio > 0) {
      compatibility.recommendations.push(`${newRuleRatio.toFixed(1)}% 的用户有配额限制，需要正确处理配额逻辑`);
    }

    // 检查数据不完整的用户
    if (analysis.structureTypes.incomplete > 0) {
      const incompleteRatio = (analysis.structureTypes.incomplete / analysis.totalUsers) * 100;
      compatibility.issues.push(`${incompleteRatio.toFixed(1)}% 的用户数据不完整`);
      if (incompleteRatio > 10) {
        compatibility.overall = 'needs_attention';
      }
    }

    return compatibility;
  }

  // 生成迁移建议
  generateMigrationAdvice(analysis, compatibility) {
    const advice = {
      preparation: [],
      migration: [],
      postMigration: []
    };

    // 准备阶段建议
    advice.preparation.push('备份现有PostgreSQL数据库');
    advice.preparation.push('确认Cloudflare API配置正确');
    
    if (analysis.structureTypes.incomplete > 0) {
      advice.preparation.push('处理数据不完整的用户，考虑设置默认值');
    }

    // 迁移阶段建议
    advice.migration.push('使用现有的migrate_data.js脚本进行迁移');
    advice.migration.push('迁移过程中监控错误日志');
    
    if (analysis.structureTypes.legacy > 0) {
      advice.migration.push('确认老用户的无限配额权益得到保留');
    }
    
    if (analysis.structureTypes.newRule > 0) {
      advice.migration.push('验证新规则用户的配额计算正确');
    }

    // 迁移后建议
    advice.postMigration.push('验证用户登录功能');
    advice.postMigration.push('测试VIP状态检查');
    advice.postMigration.push('验证配额计算逻辑');
    advice.postMigration.push('检查使用统计数据');

    return advice;
  }

  // 显示分析结果
  displayAnalysis(analysis, compatibility, advice) {
    log('cyan', '\n📊 用户数据结构分析');
    log('blue', '=' .repeat(50));
    
    // 基本统计
    log('green', `总用户数: ${analysis.totalUsers}`);
    log('blue', '\n用户类型分布:');
    log('cyan', `  老用户 (无配额限制): ${analysis.structureTypes.legacy} (${(analysis.structureTypes.legacy/analysis.totalUsers*100).toFixed(1)}%)`);
    log('cyan', `  新规则用户 (有配额): ${analysis.structureTypes.newRule} (${(analysis.structureTypes.newRule/analysis.totalUsers*100).toFixed(1)}%)`);
    log('cyan', `  数据不完整: ${analysis.structureTypes.incomplete} (${(analysis.structureTypes.incomplete/analysis.totalUsers*100).toFixed(1)}%)`);

    // VIP类型分布
    log('blue', '\nVIP类型分布:');
    Object.entries(analysis.vipTypes).forEach(([type, count]) => {
      const percentage = (count / analysis.totalUsers * 100).toFixed(1);
      log('cyan', `  ${type}: ${count} (${percentage}%)`);
    });

    // 字段完整性
    log('blue', '\n字段完整性:');
    Object.entries(analysis.fieldPresence).forEach(([field, count]) => {
      const percentage = (count / analysis.totalUsers * 100).toFixed(1);
      const status = percentage === '100.0' ? '✅' : percentage > '90.0' ? '⚠️' : '❌';
      log('cyan', `  ${field}: ${count}/${analysis.totalUsers} (${percentage}%) ${status}`);
    });

    // 兼容性检查
    log('cyan', '\n🔍 兼容性检查');
    log('blue', '=' .repeat(50));
    
    const statusColor = compatibility.overall === 'compatible' ? 'green' : 
                       compatibility.overall === 'needs_attention' ? 'yellow' : 'red';
    const statusText = compatibility.overall === 'compatible' ? '✅ 完全兼容' :
                      compatibility.overall === 'needs_attention' ? '⚠️ 需要注意' : '❌ 不兼容';
    
    log(statusColor, `总体状态: ${statusText}`);

    if (compatibility.issues.length > 0) {
      log('red', '\n❌ 发现问题:');
      compatibility.issues.forEach(issue => log('red', `  • ${issue}`));
    }

    if (compatibility.warnings.length > 0) {
      log('yellow', '\n⚠️ 警告:');
      compatibility.warnings.forEach(warning => log('yellow', `  • ${warning}`));
    }

    if (compatibility.recommendations.length > 0) {
      log('blue', '\n💡 建议:');
      compatibility.recommendations.forEach(rec => log('blue', `  • ${rec}`));
    }

    // 迁移建议
    log('cyan', '\n🚀 迁移建议');
    log('blue', '=' .repeat(50));
    
    log('yellow', '准备阶段:');
    advice.preparation.forEach(item => log('cyan', `  • ${item}`));
    
    log('yellow', '\n迁移阶段:');
    advice.migration.forEach(item => log('cyan', `  • ${item}`));
    
    log('yellow', '\n迁移后验证:');
    advice.postMigration.forEach(item => log('cyan', `  • ${item}`));

    // 显示样本数据
    if (analysis.samples.newRule) {
      log('cyan', '\n📋 新规则用户样本:');
      log('blue', JSON.stringify(analysis.samples.newRule.user, null, 2));
    }
  }

  // 执行分析
  async analyze(filepath) {
    try {
      log('blue', '🔍 开始分析KV数据...\n');
      
      // 确定要分析的文件
      const targetFile = filepath || await this.findLatestUserBackup();
      log('cyan', `📁 分析文件: ${path.basename(targetFile)}`);
      
      // 加载数据
      const backupData = await this.loadDataFile(targetFile);
      log('green', `✅ 数据加载成功`);
      log('blue', `📊 元数据: ${backupData.metadata.totalKeys} 个键，下载时间: ${backupData.metadata.downloadTime}`);
      
      // 分析用户数据结构
      const analysis = this.analyzeUserStructure(backupData.data);
      
      // 检查兼容性
      const compatibility = this.checkCompatibility(analysis);
      
      // 生成迁移建议
      const advice = this.generateMigrationAdvice(analysis, compatibility);
      
      // 显示结果
      this.displayAnalysis(analysis, compatibility, advice);
      
      log('green', '\n🎉 分析完成！');
      
    } catch (error) {
      log('red', `❌ 分析失败: ${error.message}`);
      throw error;
    }
  }
}

// 执行分析
if (require.main === module) {
  const analyzer = new KVDataAnalyzer();
  const targetFile = process.argv[2]; // 可选的文件路径参数
  
  analyzer.analyze(targetFile).catch(error => {
    log('red', `分析失败: ${error.message}`);
    process.exit(1);
  });
}

module.exports = KVDataAnalyzer;
