# Cloudflare KV数据下载和分析指南

## 📋 概述

本指南介绍如何从Cloudflare KV存储中下载所有数据，并分析数据结构以确保与新后端的兼容性。

## 🛠️ 工具说明

### 1. `download_kv_data.js` - 数据下载工具
- **功能**: 从Cloudflare KV下载所有数据并保存为本地JSON文件
- **输出**: 按命名空间分类的备份文件
- **特点**: 包含进度显示、错误处理、数据分析

### 2. `analyze_kv_data.js` - 数据分析工具  
- **功能**: 分析下载的数据，检查结构和兼容性
- **输出**: 详细的分析报告和迁移建议
- **特点**: 自动检测数据问题、生成迁移建议

## 🚀 使用步骤

### 第一步：准备Cloudflare API配置

1. **获取Account ID**:
   ```bash
   # 登录Cloudflare Dashboard
   # 右侧边栏可以看到Account ID
   ```

2. **创建API Token**:
   ```bash
   # 访问: https://dash.cloudflare.com/profile/api-tokens
   # 点击 "Create Token"
   # 选择 "Custom token"
   # 权限设置:
   #   - Account: Cloudflare Workers:Edit
   #   - Zone: Zone:Read (如果需要)
   ```

3. **设置环境变量**:
   ```bash
   # 在 .env 文件中添加:
   CF_ACCOUNT_ID=your_account_id_here
   CF_API_TOKEN=your_api_token_here
   ```

### 第二步：下载KV数据

```bash
# 进入后端目录
cd backend

# 运行下载脚本
node scripts/download_kv_data.js
```

**预期输出**:
```
🚀 开始从Cloudflare KV下载数据...

📁 创建数据目录: /path/to/backend/data

🚀 开始下载 USERS 数据...
🔍 获取KV命名空间 8341ec47189543b48818f57e9ca4e5e0 的所有键...
✅ 找到 150 个键
📥 开始下载 150 个键的数据...
[150/150] 下载: user:example_user...
✅ USERS 下载完成: 150/150 成功
💾 数据已保存: kv_backup_users_20240126_143022.json

🚀 开始下载 CARDS 数据...
...

📊 下载统计:
  USERS: 150/150 成功
  CARDS: 45/45 成功
  TTS_STATUS: 0/0 成功
  VOICE_MAPPINGS: 1/1 成功

👥 用户数据分析:
  总用户数: 150
  VIP类型分布:
    M: 85 用户
    Q: 25 用户
    无VIP: 40 用户
  数据结构分析:
    有quotaChars字段: 110/150
    有usedChars字段: 110/150
    有usage字段: 150/150
    有emailVerified字段: 150/150
    有createdAt字段: 150/150

🎉 数据下载完成！

📁 保存的文件:
  kv_backup_users_20240126_143022.json
  kv_backup_cards_20240126_143022.json
  kv_backup_tts_status_20240126_143022.json
  kv_backup_voice_mappings_20240126_143022.json
```

### 第三步：分析数据结构

```bash
# 分析最新下载的用户数据
node scripts/analyze_kv_data.js

# 或指定特定文件
node scripts/analyze_kv_data.js data/kv_backup_users_20240126_143022.json
```

**预期输出**:
```
🔍 开始分析KV数据...

📁 分析文件: kv_backup_users_20240126_143022.json
✅ 数据加载成功
📊 元数据: 150 个键，下载时间: 2024-01-26T14:30:22.000Z

📊 用户数据结构分析
==================================================
总用户数: 150

用户类型分布:
  老用户 (无配额限制): 40 (26.7%)
  新规则用户 (有配额): 110 (73.3%)
  数据不完整: 0 (0.0%)

VIP类型分布:
  M: 85 (56.7%)
  Q: 25 (16.7%)
  无类型: 40 (26.7%)

字段完整性:
  username: 150/150 (100.0%) ✅
  passwordHash: 150/150 (100.0%) ✅
  email: 145/150 (96.7%) ⚠️
  emailVerified: 150/150 (100.0%) ✅
  createdAt: 150/150 (100.0%) ✅
  quota: 150/150 (100.0%) ✅
  vip: 150/150 (100.0%) ✅
  usage: 150/150 (100.0%) ✅

🔍 兼容性检查
==================================================
总体状态: ✅ 完全兼容

⚠️ 警告:
  • 5 个用户缺少email信息
  • 26.7% 的用户是老用户（无配额限制）

💡 建议:
  • 73.3% 的用户有配额限制，需要正确处理配额逻辑

🚀 迁移建议
==================================================
准备阶段:
  • 备份现有PostgreSQL数据库
  • 确认Cloudflare API配置正确

迁移阶段:
  • 使用现有的migrate_data.js脚本进行迁移
  • 迁移过程中监控错误日志
  • 确认老用户的无限配额权益得到保留
  • 验证新规则用户的配额计算正确

迁移后验证:
  • 验证用户登录功能
  • 测试VIP状态检查
  • 验证配额计算逻辑
  • 检查使用统计数据

🎉 分析完成！
```

## 📁 输出文件结构

### 备份文件格式
```json
{
  "metadata": {
    "namespace": "USERS",
    "downloadTime": "2024-01-26T14:30:22.000Z",
    "totalKeys": 150,
    "successfulKeys": 150,
    "failedKeys": 0
  },
  "keys": [
    {
      "name": "user:example",
      "expiration": null,
      "metadata": {}
    }
  ],
  "data": {
    "user:example": "{\"username\":\"example\",\"passwordHash\":\"...\",\"vip\":{...}}"
  }
}
```

### 用户数据示例
```json
{
  "username": "eluzh",
  "passwordHash": "cJCbjhbPlLry/62n/mQkGtjUiVrigTb77M0OWtvtQJU=",
  "email": "2677531864@qq.com",
  "emailVerified": true,
  "createdAt": 1753361404697,
  "quota": {
    "daily": 100,
    "used": 0,
    "resetAt": 1753361421575
  },
  "vip": {
    "expireAt": 1756020412987,
    "type": "M",
    "quotaChars": 82766,
    "usedChars": 4481
  },
  "usage": {
    "totalChars": 6715,
    "monthlyChars": 6715,
    "monthlyResetAt": 1754006400000
  }
}
```

## 🔧 故障排除

### 常见错误

1. **API认证失败**:
   ```
   ❌ 获取键列表失败: HTTP 403: Forbidden
   ```
   **解决**: 检查CF_ACCOUNT_ID和CF_API_TOKEN是否正确

2. **权限不足**:
   ```
   ❌ API错误: [{"code":10000,"message":"Authentication error"}]
   ```
   **解决**: 确认API Token有正确的权限

3. **网络超时**:
   ```
   ⚠️ 获取键 "user:example" 失败: HTTP 524
   ```
   **解决**: 脚本会自动重试，或手动重新运行

### 数据验证

1. **检查下载完整性**:
   ```bash
   # 查看下载统计
   grep "下载统计" logs/download.log
   ```

2. **验证关键用户数据**:
   ```bash
   # 搜索特定用户
   grep "user:username" data/kv_backup_users_*.json
   ```

## 📊 数据分析说明

### 用户类型分类

- **老用户**: `vip.quotaChars === undefined`，享受无限配额
- **新规则用户**: `vip.quotaChars !== undefined`，受配额限制
- **数据不完整**: 缺少关键字段的用户

### 兼容性状态

- **✅ 完全兼容**: 所有数据都能正确迁移
- **⚠️ 需要注意**: 有警告但不影响迁移
- **❌ 不兼容**: 有严重问题需要处理

## 🎯 下一步操作

1. **数据下载完成后**:
   - 检查分析报告
   - 确认兼容性状态
   - 备份现有数据库

2. **准备迁移**:
   - 设置数据库连接
   - 运行迁移脚本
   - 监控迁移过程

3. **迁移后验证**:
   - 测试用户登录
   - 验证VIP功能
   - 检查配额计算

## 💡 最佳实践

1. **定期备份**: 在迁移前备份所有数据
2. **分批测试**: 先用少量数据测试迁移流程
3. **监控日志**: 密切关注迁移过程中的错误
4. **验证功能**: 迁移后全面测试所有功能

---

**注意**: 确保在生产环境迁移前，先在测试环境完整验证整个流程！
