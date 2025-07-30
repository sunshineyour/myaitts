/**
 * 配置适配器
 * 负责解析和验证代理网关相关配置
 */
class ConfigAdapter {
  constructor() {
    this.config = null;
    this.initialized = false;
  }
  
  /**
   * 初始化配置
   */
  initialize() {
    if (this.initialized) return this.config;
    
    this.config = this.loadGatewayConfig();
    this.validateConfig();
    this.initialized = true;
    
    return this.config;
  }
  
  /**
   * 加载代理网关配置
   */
  loadGatewayConfig() {
    // 获取现有TTS代理配置作为基础
    const { getTTSProxyConfig } = require('../../utils/config');
    const baseConfig = getTTSProxyConfig();
    
    return {
      // 继承现有配置
      ...baseConfig,
      
      // 网络模式配置
      NETWORK_MODE: process.env.NETWORK_MODE || 'direct',
      
      // sing-box代理网关配置（使用Clash API）
      ENABLE_SINGBOX_GATEWAY: process.env.ENABLE_SINGBOX_GATEWAY === 'true',
      SINGBOX_API_ENDPOINT: process.env.SINGBOX_API_ENDPOINT || 'http://127.0.0.1:9090',
      SINGBOX_SELECTOR_NAME: process.env.SINGBOX_SELECTOR_NAME || 'proxy-selector',
      SINGBOX_PROXY_HOST: process.env.SINGBOX_PROXY_HOST || '127.0.0.1',
      SINGBOX_PROXY_PORT: parseInt(process.env.SINGBOX_PROXY_PORT || '1080'),
      
      // 节点健康管理配置
      SINGBOX_HEALTH_CHECK_INTERVAL: parseInt(process.env.SINGBOX_HEALTH_CHECK_INTERVAL || '30000'),
      SINGBOX_NODE_TIMEOUT: parseInt(process.env.SINGBOX_NODE_TIMEOUT || '15000'),
      SINGBOX_MAX_RETRIES: parseInt(process.env.SINGBOX_MAX_RETRIES || '3'),
      SINGBOX_RETRY_DELAY: parseInt(process.env.SINGBOX_RETRY_DELAY || '1000'),
      
      // 节点订阅配置
      SINGBOX_SUBSCRIBE_URL: process.env.SINGBOX_SUBSCRIBE_URL || null,
      SINGBOX_AUTO_UPDATE: process.env.SINGBOX_AUTO_UPDATE === 'true',
      SINGBOX_UPDATE_INTERVAL: parseInt(process.env.SINGBOX_UPDATE_INTERVAL || '86400000'), // 24小时
      
      // 调试和监控配置
      SINGBOX_DEBUG: process.env.SINGBOX_DEBUG === 'true',
      SINGBOX_ENABLE_STATS: process.env.SINGBOX_ENABLE_STATS === 'true',
      
      // 降级和容错配置
      SINGBOX_FALLBACK_ENABLED: process.env.SINGBOX_FALLBACK_ENABLED !== 'false', // 默认启用
      SINGBOX_FALLBACK_THRESHOLD: parseInt(process.env.SINGBOX_FALLBACK_THRESHOLD || '3'), // 连续失败3次后降级
      SINGBOX_FALLBACK_WINDOW: parseInt(process.env.SINGBOX_FALLBACK_WINDOW || '300000'), // 5分钟窗口

      // Gateway请求重试配置
      GATEWAY_REQUEST_MAX_RETRIES: parseInt(process.env.GATEWAY_REQUEST_MAX_RETRIES || '1'), // 网络请求最大重试次数

      // Gateway降级策略配置
      GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP: process.env.GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP === 'true', // 是否启用直连兜底，默认false

      // 【新增】工作池配置
      SINGBOX_WORKER_POOL_SIZE: parseInt(process.env.SINGBOX_WORKER_POOL_SIZE || '10'), // 工作池大小
      SINGBOX_WORKER_PORT_START: parseInt(process.env.SINGBOX_WORKER_PORT_START || '1081'), // 工人端口起始
      SINGBOX_WORKER_SELECTOR_PREFIX: process.env.SINGBOX_WORKER_SELECTOR_PREFIX || 'worker-selector', // 工人选择器前缀
      SINGBOX_WORKER_INBOUND_PREFIX: process.env.SINGBOX_WORKER_INBOUND_PREFIX || 'worker-in', // 工人入口前缀

      // 【新增】隔离池和后台修复配置
      SINGBOX_QUARANTINE_CHECK_INTERVAL: parseInt(process.env.SINGBOX_QUARANTINE_CHECK_INTERVAL || '600000'), // 隔离池检查间隔（10分钟）
      SINGBOX_QUARANTINE_HEALTH_CHECK_TIMEOUT: parseInt(process.env.SINGBOX_QUARANTINE_HEALTH_CHECK_TIMEOUT || '5000'), // 隔离池健康检查超时
      SINGBOX_QUARANTINE_RECOVERY_THRESHOLD: parseInt(process.env.SINGBOX_QUARANTINE_RECOVERY_THRESHOLD || '2'), // 临时隔离恢复所需连续成功次数
      SINGBOX_QUARANTINE_PERMANENT_RECOVERY_THRESHOLD: parseInt(process.env.SINGBOX_QUARANTINE_PERMANENT_RECOVERY_THRESHOLD || '3'), // 永久隔离恢复所需连续成功次数
      SINGBOX_QUARANTINE_ENABLE_PERMANENT_RECOVERY: process.env.SINGBOX_QUARANTINE_ENABLE_PERMANENT_RECOVERY !== 'false' // 是否允许永久隔离节点恢复
    };
  }
  
  /**
   * 验证配置有效性
   */
  validateConfig() {
    const config = this.config;
    
    // 验证网络模式
    const validModes = ['direct', 'proxy', 'gateway', 'fallback'];
    if (!validModes.includes(config.NETWORK_MODE)) {
      throw new Error(`Invalid NETWORK_MODE: ${config.NETWORK_MODE}. Must be one of: ${validModes.join(', ')}`);
    }
    
    // 验证sing-box配置（仅在启用时）
    if (config.ENABLE_SINGBOX_GATEWAY) {
      if (!config.SINGBOX_API_ENDPOINT) {
        throw new Error('SINGBOX_API_ENDPOINT is required when ENABLE_SINGBOX_GATEWAY is true');
      }

      if (!config.SINGBOX_SELECTOR_NAME) {
        throw new Error('SINGBOX_SELECTOR_NAME is required when ENABLE_SINGBOX_GATEWAY is true');
      }

      if (config.SINGBOX_PROXY_PORT < 1 || config.SINGBOX_PROXY_PORT > 65535) {
        throw new Error(`Invalid SINGBOX_PROXY_PORT: ${config.SINGBOX_PROXY_PORT}. Must be between 1 and 65535`);
      }

      // 验证工作池配置
      if (config.SINGBOX_WORKER_POOL_SIZE < 1 || config.SINGBOX_WORKER_POOL_SIZE > 50) {
        throw new Error(`Invalid SINGBOX_WORKER_POOL_SIZE: ${config.SINGBOX_WORKER_POOL_SIZE}. Must be between 1 and 50`);
      }

      if (config.SINGBOX_WORKER_PORT_START < 1024 || config.SINGBOX_WORKER_PORT_START > 65000) {
        throw new Error(`Invalid SINGBOX_WORKER_PORT_START: ${config.SINGBOX_WORKER_PORT_START}. Must be between 1024 and 65000`);
      }

      // 检查工人端口范围是否会超出有效范围
      const maxWorkerPort = config.SINGBOX_WORKER_PORT_START + config.SINGBOX_WORKER_POOL_SIZE - 1;
      if (maxWorkerPort > 65535) {
        throw new Error(`Worker port range exceeds valid range. Start: ${config.SINGBOX_WORKER_PORT_START}, Pool size: ${config.SINGBOX_WORKER_POOL_SIZE}, Max port would be: ${maxWorkerPort}`);
      }
    }
    
    // 验证超时配置
    if (config.SINGBOX_NODE_TIMEOUT < 1000) {
      console.warn('[CONFIG] SINGBOX_NODE_TIMEOUT is less than 1000ms, this may cause frequent timeouts');
    }

    if (config.SINGBOX_HEALTH_CHECK_INTERVAL < 10000) {
      console.warn('[CONFIG] SINGBOX_HEALTH_CHECK_INTERVAL is less than 10s, this may cause high CPU usage');
    }

    // 验证Gateway重试配置
    if (config.GATEWAY_REQUEST_MAX_RETRIES < 0 || config.GATEWAY_REQUEST_MAX_RETRIES > 5) {
      console.warn('[CONFIG] GATEWAY_REQUEST_MAX_RETRIES should be between 0 and 5, current value:', config.GATEWAY_REQUEST_MAX_RETRIES);
    }

    // 验证Gateway降级策略配置
    if (typeof config.GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP !== 'boolean') {
      console.warn('[CONFIG] GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP should be a boolean value, current value:', config.GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP);
    }
  }
  
  /**
   * 获取配置
   */
  getConfig() {
    if (!this.initialized) {
      this.initialize();
    }
    return this.config;
  }
  
  /**
   * 获取特定配置项
   */
  get(key, defaultValue = null) {
    const config = this.getConfig();
    return config[key] !== undefined ? config[key] : defaultValue;
  }
  
  /**
   * 检查功能是否启用
   */
  isEnabled(feature) {
    const config = this.getConfig();
    switch (feature) {
      case 'gateway':
        return config.ENABLE_SINGBOX_GATEWAY && config.NETWORK_MODE === 'gateway';
      case 'fallback':
        return config.SINGBOX_FALLBACK_ENABLED;
      case 'auto_update':
        return config.SINGBOX_AUTO_UPDATE;
      case 'debug':
        return config.SINGBOX_DEBUG;
      case 'stats':
        return config.SINGBOX_ENABLE_STATS;
      default:
        return false;
    }
  }
  
  /**
   * 重新加载配置
   */
  reload() {
    this.initialized = false;
    return this.initialize();
  }
}

// 单例模式
const configAdapter = new ConfigAdapter();

module.exports = {
  ConfigAdapter,
  configAdapter
};
