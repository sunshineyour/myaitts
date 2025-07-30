const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
const { LoggerAdapter } = require('../gateway/adapters/LoggerAdapter');

/**
 * 网络管理器
 * 提供统一的网络请求入口，支持多种网络模式的无缝切换
 */
class NetworkManager {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.logger = new LoggerAdapter('NETWORK-MANAGER');
    this.config = null;
    
    // 统计信息
    this.stats = {
      initializationTime: null,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      modeChanges: 0,
      lastRequestTime: null
    };
  }
  
  /**
   * 初始化网络管理器
   */
  async initialize() {
    if (this.initialized) return;

    try {
      this.logger.info('Initializing NetworkManager...');
      this.stats.initializationTime = Date.now();

      // 加载配置
      this.config = configAdapter.getConfig();

      // 根据配置创建相应的网络客户端
      await this.createNetworkClient();

      this.initialized = true;

      this.logger.info('NetworkManager initialized successfully', {
        mode: this.config.NETWORK_MODE,
        gatewayEnabled: this.config.ENABLE_SINGBOX_GATEWAY
      });

    } catch (error) {
      this.logger.error('NetworkManager initialization failed', error);
      throw error;
    }
  }

  /**
   * 确保初始化（幂等操作）
   * 多个并发调用时只初始化一次
   */
  async ensureInitialized() {
    if (this.initialized) return;

    // 防止并发初始化
    if (this._initializing) {
      // 等待正在进行的初始化完成
      while (this._initializing) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return;
    }

    this._initializing = true;
    try {
      await this.initialize();
    } finally {
      this._initializing = false;
    }
  }
  
  /**
   * 创建网络客户端
   */
  async createNetworkClient() {
    const mode = this.config.NETWORK_MODE;
    
    this.logger.debug(`Creating network client for mode: ${mode}`);
    
    switch (mode) {
      case 'gateway':
        this.client = await this.createGatewayClient();
        break;
      case 'proxy':
        this.client = await this.createProxyClient();
        break;
      case 'fallback':
        this.client = await this.createFallbackClient();
        break;
      case 'direct':
      default:
        this.client = await this.createDirectClient();
        break;
    }
    
    this.logger.debug(`Network client created for mode: ${mode}`);
  }
  
  /**
   * 创建网关客户端
   */
  async createGatewayClient() {
    const { ProxyGateway } = require('../gateway/core/ProxyGateway');
    
    const gatewayLogger = this.logger.createSubLogger('GATEWAY');
    const gateway = new ProxyGateway(this.config, gatewayLogger);
    
    await gateway.initialize();
    return gateway.getNetworkClient();
  }
  
  /**
   * 创建代理客户端
   */
  async createProxyClient() {
    const { NetworkAdapter } = require('../gateway/adapters/NetworkAdapter');
    
    const networkLogger = this.logger.createSubLogger('PROXY');
    return new NetworkAdapter(this.config, null, networkLogger);
  }
  
  /**
   * 创建降级客户端
   */
  async createFallbackClient() {
    const { NetworkAdapter } = require('../gateway/adapters/NetworkAdapter');
    
    const networkLogger = this.logger.createSubLogger('FALLBACK');
    return new NetworkAdapter(this.config, null, networkLogger);
  }
  
  /**
   * 创建直连客户端
   */
  async createDirectClient() {
    const { NetworkAdapter } = require('../gateway/adapters/NetworkAdapter');
    
    const networkLogger = this.logger.createSubLogger('DIRECT');
    return new NetworkAdapter(this.config, null, networkLogger);
  }
  
  /**
   * 统一网络请求接口
   */
  async request(options) {
    // 确保已初始化（幂等操作，支持并发）
    await this.ensureInitialized();

    this.stats.totalRequests++;
    this.stats.lastRequestTime = Date.now();

    try {
      this.logger.debug('Making network request', {
        method: options.method || 'GET',
        url: options.url,
        mode: this.getMode()
      });

      const response = await this.client.request(options);
      this.stats.successfulRequests++;

      return response;

    } catch (error) {
      this.stats.failedRequests++;

      this.logger.error('Network request failed', error, {
        method: options.method || 'GET',
        url: options.url,
        mode: this.getMode()
      });

      throw error;
    }
  }
  
  /**
   * GET请求便捷方法
   */
  async get(url, options = {}) {
    return await this.request({
      url,
      method: 'GET',
      ...options
    });
  }
  
  /**
   * POST请求便捷方法
   */
  async post(url, data = null, options = {}) {
    return await this.request({
      url,
      method: 'POST',
      body: data,
      ...options
    });
  }
  
  /**
   * PUT请求便捷方法
   */
  async put(url, data = null, options = {}) {
    return await this.request({
      url,
      method: 'PUT',
      body: data,
      ...options
    });
  }
  
  /**
   * DELETE请求便捷方法
   */
  async delete(url, options = {}) {
    return await this.request({
      url,
      method: 'DELETE',
      ...options
    });
  }
  
  /**
   * 获取当前网络模式
   */
  getMode() {
    return this.client?.getMode() || 'unknown';
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    if (!this.initialized) {
      await this.initialize();
    }
    
    try {
      const isHealthy = await this.client.healthCheck();
      
      this.logger.debug('Health check completed', {
        mode: this.getMode(),
        healthy: isHealthy
      });
      
      return isHealthy;
    } catch (error) {
      this.logger.error('Health check failed', error);
      return false;
    }
  }
  
  /**
   * 获取统计信息
   */
  async getStats() {
    const networkStats = this.client ? this.client.getStats() : null;
    
    return {
      manager: { ...this.stats },
      client: networkStats,
      mode: this.getMode(),
      initialized: this.initialized
    };
  }
  
  /**
   * 切换网络模式
   */
  async switchMode(newMode) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    const oldMode = this.getMode();
    
    if (oldMode === newMode) {
      this.logger.debug(`Already in ${newMode} mode, no switch needed`);
      return;
    }
    
    this.logger.info(`Switching network mode from ${oldMode} to ${newMode}`);
    
    try {
      // 更新配置
      this.config.NETWORK_MODE = newMode;
      
      // 重新创建网络客户端
      await this.createNetworkClient();
      
      this.stats.modeChanges++;
      
      this.logger.info(`Successfully switched to ${newMode} mode`);
      
    } catch (error) {
      this.logger.error(`Failed to switch to ${newMode} mode`, error);
      throw error;
    }
  }
  
  /**
   * 重新加载配置
   */
  async reload() {
    this.logger.info('Reloading NetworkManager...');
    
    try {
      // 重新加载配置
      this.config = configAdapter.reload();
      
      // 重新创建网络客户端
      await this.createNetworkClient();
      
      this.logger.info('NetworkManager reloaded successfully');
      
    } catch (error) {
      this.logger.error('NetworkManager reload failed', error);
      throw error;
    }
  }
  
  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      initialized: this.initialized,
      mode: this.getMode(),
      config: this.config ? {
        NETWORK_MODE: this.config.NETWORK_MODE,
        ENABLE_SINGBOX_GATEWAY: this.config.ENABLE_SINGBOX_GATEWAY,
        ENABLE_TTS_PROXY: this.config.ENABLE_TTS_PROXY
      } : null,
      stats: this.stats
    };
  }
  
  /**
   * 清理资源
   */
  async cleanup() {
    this.logger.info('Cleaning up NetworkManager...');
    
    this.initialized = false;
    this.client = null;
    this.config = null;
    
    this.logger.info('NetworkManager cleanup completed');
  }
}

// 单例模式
const networkManager = new NetworkManager();

module.exports = {
  NetworkManager,
  networkManager
};
