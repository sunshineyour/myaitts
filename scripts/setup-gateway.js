#!/usr/bin/env node

/**
 * 代理网关快速设置脚本
 * 帮助用户快速配置和启用代理网关功能
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 颜色输出
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  reset: '\x1b[0m'
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

// 创建readline接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// 提问函数
function question(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

// 配置模板
const configTemplates = {
  direct: {
    NETWORK_MODE: 'direct',
    ENABLE_SINGBOX_GATEWAY: 'false',
    description: '直连模式 - 直接连接到目标API，适用于无网络限制的环境'
  },
  proxy: {
    NETWORK_MODE: 'proxy',
    ENABLE_TTS_PROXY: 'true',
    ENABLE_SINGBOX_GATEWAY: 'false',
    description: '代理模式 - 使用现有代理服务器，兼容原有配置'
  },
  gateway: {
    NETWORK_MODE: 'gateway',
    ENABLE_SINGBOX_GATEWAY: 'true',
    SINGBOX_API_ENDPOINT: 'http://127.0.0.1:9090',
    SINGBOX_SELECTOR_NAME: 'proxy-selector',
    SINGBOX_PROXY_HOST: '127.0.0.1',
    SINGBOX_PROXY_PORT: '1080',
    SINGBOX_HEALTH_CHECK_INTERVAL: '30000',
    SINGBOX_NODE_TIMEOUT: '15000',
    SINGBOX_MAX_RETRIES: '3',
    SINGBOX_DEBUG: 'false',
    SINGBOX_ENABLE_STATS: 'true',
    SINGBOX_FALLBACK_ENABLED: 'true',
    description: 'sing-box网关模式 - 使用sing-box代理网关，提供最高可用性'
  },
  fallback: {
    NETWORK_MODE: 'fallback',
    ENABLE_SINGBOX_GATEWAY: 'true',
    ENABLE_TTS_PROXY: 'true',
    SINGBOX_API_ENDPOINT: 'http://127.0.0.1:9090',
    SINGBOX_SELECTOR_NAME: 'proxy-selector',
    SINGBOX_PROXY_HOST: '127.0.0.1',
    SINGBOX_PROXY_PORT: '1080',
    SINGBOX_FALLBACK_ENABLED: 'true',
    description: '降级模式 - 先尝试直连，失败后自动切换到代理'
  }
};

/**
 * 显示欢迎信息
 */
function showWelcome() {
  log('cyan', '\n🚀 代理网关快速设置向导');
  log('cyan', '=====================================');
  console.log('本向导将帮助您快速配置和启用代理网关功能。');
  console.log('');
}

/**
 * 显示模式选择菜单
 */
function showModeMenu() {
  log('blue', '📋 请选择网络模式:');
  console.log('');
  console.log('1. Direct模式 - 直连模式（默认）');
  console.log('   适用于: 无网络限制的环境');
  console.log('   特点: 最快的响应速度，无代理开销');
  console.log('');
  console.log('2. Proxy模式 - 代理模式');
  console.log('   适用于: 已有代理服务器的环境');
  console.log('   特点: 兼容现有代理配置，支持多代理轮询');
  console.log('');
  console.log('3. Gateway模式 - sing-box网关模式');
  console.log('   适用于: 需要高可用性的生产环境');
  console.log('   特点: 智能节点切换，自动故障恢复');
  console.log('');
  console.log('4. Fallback模式 - 智能降级模式');
  console.log('   适用于: 网络环境不稳定的场景');
  console.log('   特点: 自动选择最佳连接方式');
  console.log('');
}

/**
 * 获取用户选择的模式
 */
async function getModeChoice() {
  while (true) {
    const choice = await question('请输入选择 (1-4): ');
    
    switch (choice.trim()) {
      case '1':
        return 'direct';
      case '2':
        return 'proxy';
      case '3':
        return 'gateway';
      case '4':
        return 'fallback';
      default:
        log('red', '❌ 无效选择，请输入 1-4');
    }
  }
}

/**
 * 获取sing-box配置
 */
async function getSingboxConfig() {
  log('blue', '\n🔧 配置sing-box参数:');
  
  const config = {};
  
  // API端点
  const apiEndpoint = await question('sing-box API端点 [http://127.0.0.1:9090]: ');
  config.SINGBOX_API_ENDPOINT = apiEndpoint.trim() || 'http://127.0.0.1:9090';
  
  // 选择器名称
  const selectorName = await question('选择器名称 [proxy-selector]: ');
  config.SINGBOX_SELECTOR_NAME = selectorName.trim() || 'proxy-selector';
  
  // 代理端口
  const proxyPort = await question('本地代理端口 [1080]: ');
  config.SINGBOX_PROXY_PORT = proxyPort.trim() || '1080';
  
  // 健康检查间隔
  const healthInterval = await question('健康检查间隔(毫秒) [30000]: ');
  config.SINGBOX_HEALTH_CHECK_INTERVAL = healthInterval.trim() || '30000';
  
  // 调试模式
  const debug = await question('启用调试模式? (y/N): ');
  config.SINGBOX_DEBUG = debug.toLowerCase().startsWith('y') ? 'true' : 'false';
  
  return config;
}

/**
 * 获取代理配置
 */
async function getProxyConfig() {
  log('blue', '\n🔧 配置代理服务器:');
  
  const config = {};
  
  // 代理URL
  const proxyUrls = await question('代理服务器URL (多个用逗号分隔): ');
  if (proxyUrls.trim()) {
    config.TTS_PROXY_URLS = proxyUrls.trim();
  }
  
  // 代理密钥
  const proxySecret = await question('代理密钥 (可选): ');
  if (proxySecret.trim()) {
    config.TTS_PROXY_SECRET = proxySecret.trim();
  }
  
  return config;
}

/**
 * 生成配置内容
 */
function generateConfig(mode, customConfig = {}) {
  const template = configTemplates[mode];
  const config = { ...template, ...customConfig };
  
  let content = `\n# ========== 代理网关配置 (${new Date().toISOString()}) ==========\n`;
  content += `# 模式: ${mode} - ${template.description}\n\n`;
  
  // 删除description字段
  delete config.description;
  
  // 生成配置项
  Object.entries(config).forEach(([key, value]) => {
    content += `${key}=${value}\n`;
  });
  
  return content;
}

/**
 * 更新.env文件
 */
async function updateEnvFile(configContent) {
  const envPath = path.join(process.cwd(), '.env');
  const envExamplePath = path.join(process.cwd(), '.env.example');
  
  try {
    // 检查.env文件是否存在
    if (!fs.existsSync(envPath)) {
      if (fs.existsSync(envExamplePath)) {
        // 从.env.example复制
        fs.copyFileSync(envExamplePath, envPath);
        log('green', '✅ 已从.env.example创建.env文件');
      } else {
        // 创建空文件
        fs.writeFileSync(envPath, '');
        log('green', '✅ 已创建新的.env文件');
      }
    }
    
    // 读取现有内容
    let existingContent = fs.readFileSync(envPath, 'utf8');
    
    // 移除旧的代理网关配置
    existingContent = existingContent.replace(
      /\n# ========== 代理网关配置.*?(?=\n# ==========|\n[A-Z_]+=|$)/gs,
      ''
    );
    
    // 添加新配置
    const newContent = existingContent.trimEnd() + configContent + '\n';
    
    // 写入文件
    fs.writeFileSync(envPath, newContent);
    
    log('green', '✅ 配置已更新到.env文件');
    
  } catch (error) {
    log('red', `❌ 更新.env文件失败: ${error.message}`);
    throw error;
  }
}

/**
 * 验证配置
 */
async function validateConfig() {
  log('blue', '\n🧪 验证配置...');
  
  try {
    // 重新加载环境变量
    delete require.cache[require.resolve('dotenv')];
    require('dotenv').config();
    
    // 测试配置加载
    const { configAdapter } = require('../src/gateway/adapters/ConfigAdapter');
    configAdapter.reload();
    const config = configAdapter.getConfig();
    
    log('green', '✅ 配置验证成功');
    console.log(`   网络模式: ${config.NETWORK_MODE}`);
    console.log(`   sing-box启用: ${config.ENABLE_SINGBOX_GATEWAY}`);
    
    return true;
  } catch (error) {
    log('red', `❌ 配置验证失败: ${error.message}`);
    return false;
  }
}

/**
 * 显示完成信息
 */
function showCompletion(mode) {
  log('green', '\n🎉 代理网关设置完成！');
  log('cyan', '=====================================');
  
  console.log(`✅ 网络模式: ${mode}`);
  console.log('✅ 配置文件: .env');
  console.log('');
  
  log('blue', '📋 下一步操作:');
  
  if (mode === 'gateway' || mode === 'fallback') {
    console.log('1. 启动sing-box服务');
    console.log('2. 确保sing-box配置正确');
    console.log('3. 重启应用服务器');
  } else {
    console.log('1. 重启应用服务器');
  }
  
  console.log('');
  log('blue', '🔧 测试命令:');
  console.log('   node test-proxy-gateway.js        # 运行功能测试');
  console.log('   node examples/gateway-usage-examples.js  # 查看使用示例');
  console.log('');
  
  log('blue', '📊 监控命令:');
  console.log('   curl http://localhost:3001/api/gateway/status  # 查看状态');
  console.log('   curl http://localhost:3001/api/gateway/stats   # 查看统计');
  console.log('');
  
  log('blue', '📚 文档:');
  console.log('   PROXY_GATEWAY_README.md     # 详细使用指南');
  console.log('   INTEGRATION_SUMMARY.md      # 集成总结');
}

/**
 * 主函数
 */
async function main() {
  try {
    showWelcome();
    showModeMenu();
    
    const mode = await getModeChoice();
    log('cyan', `\n✅ 已选择: ${mode}模式`);
    
    let customConfig = {};
    
    // 根据模式获取额外配置
    if (mode === 'gateway' || mode === 'fallback') {
      customConfig = { ...customConfig, ...(await getSingboxConfig()) };
    }
    
    if (mode === 'proxy' || mode === 'fallback') {
      customConfig = { ...customConfig, ...(await getProxyConfig()) };
    }
    
    // 生成配置
    const configContent = generateConfig(mode, customConfig);
    
    // 显示配置预览
    log('blue', '\n📋 配置预览:');
    console.log(configContent);
    
    // 确认应用
    const confirm = await question('确认应用此配置? (Y/n): ');
    if (confirm.toLowerCase().startsWith('n')) {
      log('yellow', '⚠️  配置已取消');
      return;
    }
    
    // 更新配置文件
    await updateEnvFile(configContent);
    
    // 验证配置
    const isValid = await validateConfig();
    
    if (isValid) {
      showCompletion(mode);
    } else {
      log('red', '❌ 配置验证失败，请检查配置项');
    }
    
  } catch (error) {
    log('red', `💥 设置失败: ${error.message}`);
  } finally {
    rl.close();
  }
}

// 如果直接运行此文件，执行主函数
if (require.main === module) {
  main().catch(error => {
    console.error('💥 设置脚本执行失败:', error);
    process.exit(1);
  });
}

module.exports = { main };
