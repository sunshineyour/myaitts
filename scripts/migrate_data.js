#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');

// 数据迁移配置
const MIGRATION_CONFIG = {
  // Cloudflare API配置 (需要从Cloudflare获取)
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID,
  CF_API_TOKEN: process.env.CF_API_TOKEN,
  
  // KV命名空间ID (从wrangler.toml获取 - 已更新为实际ID)
  KV_NAMESPACES: {
    USERS: '8341ec47189543b48818f57e9ca4e5e0',
    CARDS: '69d6e32b35dd4a0bb996584ebf3f5b27',
    TTS_STATUS: '0ae5fbcb1ed34dab9357ae1a838b34f3',
    VOICE_MAPPINGS: '065bf81a6ad347d19709b402659608f5'
  },
  
  // PostgreSQL连接
  PG_CONFIG: {
    connectionString: process.env.DATABASE_URL
  }
};

class DataMigrator {
  constructor() {
    this.pgPool = new Pool(MIGRATION_CONFIG.PG_CONFIG);
  }

  // 从Cloudflare KV获取所有数据
  async fetchKVData(namespaceId) {
    if (!MIGRATION_CONFIG.CF_ACCOUNT_ID || !MIGRATION_CONFIG.CF_API_TOKEN) {
      console.log('⚠️  Cloudflare API配置未设置，跳过KV数据获取');
      return {};
    }

    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${MIGRATION_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/keys`,
        {
          headers: {
            'Authorization': `Bearer ${MIGRATION_CONFIG.CF_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const { result } = await response.json();
      const data = {};
      
      // 获取每个key的值
      for (const key of result) {
        const valueResponse = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${MIGRATION_CONFIG.CF_ACCOUNT_ID}/storage/kv/namespaces/${namespaceId}/values/${key.name}`,
          {
            headers: {
              'Authorization': `Bearer ${MIGRATION_CONFIG.CF_API_TOKEN}`
            }
          }
        );
        
        if (valueResponse.ok) {
          data[key.name] = await valueResponse.text();
        }
      }
      
      return data;
    } catch (error) {
      console.error(`获取KV数据失败 (${namespaceId}):`, error.message);
      return {};
    }
  }

  // 迁移用户数据
  async migrateUsers() {
    console.log('开始迁移用户数据...');
    const userData = await this.fetchKVData(MIGRATION_CONFIG.KV_NAMESPACES.USERS);
    
    let migratedCount = 0;
    for (const [key, value] of Object.entries(userData)) {
      if (key.startsWith('user:')) {
        try {
          const username = key.replace('user:', '');
          const userInfo = JSON.parse(value);
          
          await this.pgPool.query(`
            INSERT INTO users (username, password_hash, email, vip_info, usage_stats)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (username) DO UPDATE SET
              password_hash = EXCLUDED.password_hash,
              email = EXCLUDED.email,
              vip_info = EXCLUDED.vip_info,
              usage_stats = EXCLUDED.usage_stats,
              updated_at = CURRENT_TIMESTAMP
          `, [
            username,
            userInfo.password || '',
            userInfo.email || null,
            JSON.stringify(userInfo.vip || {}),
            JSON.stringify(userInfo.usage || {})
          ]);
          
          migratedCount++;
        } catch (error) {
          console.error(`迁移用户 ${key} 失败:`, error.message);
        }
      }
    }
    console.log(`✅ 用户数据迁移完成，共迁移 ${migratedCount} 个用户`);
  }

  // 迁移卡密数据
  async migrateCards() {
    console.log('开始迁移卡密数据...');
    const cardData = await this.fetchKVData(MIGRATION_CONFIG.KV_NAMESPACES.CARDS);
    
    let migratedCount = 0;
    for (const [key, value] of Object.entries(cardData)) {
      if (key.startsWith('card:')) {
        try {
          const code = key.replace('card:', '');
          const cardInfo = JSON.parse(value);
          
          await this.pgPool.query(`
            INSERT INTO cards (code, package_type, status, created_at, used_at, used_by, package_info)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (code) DO UPDATE SET
              status = EXCLUDED.status,
              used_at = EXCLUDED.used_at,
              used_by = EXCLUDED.used_by
          `, [
            code,
            cardInfo.type || 'M',
            cardInfo.used ? 'used' : 'unused',
            new Date(cardInfo.createdAt || Date.now()),
            cardInfo.usedAt ? new Date(cardInfo.usedAt) : null,
            cardInfo.usedBy || null,
            JSON.stringify(cardInfo)
          ]);
          
          migratedCount++;
        } catch (error) {
          console.error(`迁移卡密 ${key} 失败:`, error.message);
        }
      }
    }
    console.log(`✅ 卡密数据迁移完成，共迁移 ${migratedCount} 张卡密`);
  }

  // 迁移语音映射数据
  async migrateVoiceMappings() {
    console.log('开始迁移语音映射数据...');
    const voiceData = await this.fetchKVData(MIGRATION_CONFIG.KV_NAMESPACES.VOICE_MAPPINGS);
    
    if (voiceData['voices_v1']) {
      try {
        const mappings = JSON.parse(voiceData['voices_v1']);
        let migratedCount = 0;
        
        for (const [voiceName, voiceId] of Object.entries(mappings)) {
          await this.pgPool.query(`
            INSERT INTO voice_mappings (voice_name, voice_id, model_support)
            VALUES ($1, $2, $3)
            ON CONFLICT (voice_name) DO UPDATE SET
              voice_id = EXCLUDED.voice_id,
              model_support = EXCLUDED.model_support
          `, [
            voiceName,
            voiceId,
            JSON.stringify(['eleven_turbo_v2', 'eleven_turbo_v2_5', 'eleven_v3'])
          ]);
          migratedCount++;
        }
        
        console.log(`✅ 语音映射数据迁移完成，共迁移 ${migratedCount} 个映射`);
      } catch (error) {
        console.error('迁移语音映射失败:', error.message);
      }
    } else {
      console.log('⚠️  未找到语音映射数据，使用默认数据');
    }
  }

  // 执行完整迁移
  async migrate() {
    try {
      console.log('🚀 开始数据迁移...\n');
      
      await this.migrateUsers();
      await this.migrateCards();
      await this.migrateVoiceMappings();
      
      console.log('\n🎉 所有数据迁移完成！');
      
      // 显示迁移统计
      const stats = await this.getMigrationStats();
      console.log('\n📊 迁移统计:');
      console.log(`  用户: ${stats.users} 个`);
      console.log(`  卡密: ${stats.cards} 张`);
      console.log(`  语音映射: ${stats.voices} 个`);
      
    } catch (error) {
      console.error('❌ 数据迁移失败:', error);
      throw error;
    } finally {
      await this.pgPool.end();
    }
  }

  // 获取迁移统计
  async getMigrationStats() {
    const [usersResult, cardsResult, voicesResult] = await Promise.all([
      this.pgPool.query('SELECT COUNT(*) FROM users'),
      this.pgPool.query('SELECT COUNT(*) FROM cards'),
      this.pgPool.query('SELECT COUNT(*) FROM voice_mappings')
    ]);

    return {
      users: parseInt(usersResult.rows[0].count),
      cards: parseInt(cardsResult.rows[0].count),
      voices: parseInt(voicesResult.rows[0].count)
    };
  }
}

// 执行迁移
if (require.main === module) {
  const migrator = new DataMigrator();
  migrator.migrate().catch(error => {
    console.error('迁移失败:', error);
    process.exit(1);
  });
}

module.exports = DataMigrator;
