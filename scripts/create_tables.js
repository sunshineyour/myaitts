#!/usr/bin/env node

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function createTables() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    console.log('连接到数据库...');
    
    // 读取SQL文件
    const sqlFile = path.join(__dirname, 'create_tables.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');
    
    console.log('执行数据库表创建脚本...');
    await pool.query(sql);
    
    console.log('✅ 数据库表创建成功！');
    
    // 验证表是否创建成功
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `);
    
    console.log('\n📋 已创建的表：');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });
    
    // 检查语音映射数据
    const voiceCount = await pool.query('SELECT COUNT(*) FROM voice_mappings');
    console.log(`\n🎤 语音映射数据：${voiceCount.rows[0].count} 条记录`);
    
  } catch (error) {
    console.error('❌ 数据库表创建失败:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  createTables().catch(console.error);
}

module.exports = createTables;
