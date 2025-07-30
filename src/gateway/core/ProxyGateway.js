const { SingboxController } = require('./SingboxController');
const { WorkerPoolController } = require('./WorkerPoolController');
const { NetworkAdapter } = require('../adapters/NetworkAdapter');
const { LoggerAdapter } = require('../adapters/LoggerAdapter');

// 全局WorkerPoolController实例，确保所有分片共享同一个实例
let globalWorkerPoolController = null;

/**
 * 代理网关主控制器
 * 协调sing-box控制器和网络适配器，提供统一的代理网关服务
 */
class ProxyGateway {
  constructor(config, logger = null) {
    this.config = config;
    this.logger = logger || new LoggerAdapter('PROXY-GATEWAY');
    
    // 核心组件
    this.singboxController = null;
    this.networkAdapter = null;
    this.healthChecker = null;
    
    // 状态管理
    this.initialized = false;
    this.running = false;
    
    // 统计信息
    this.stats = {
      startTime: null,
      uptime: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      nodeSwitches: 0,
      lastHealthCheck: null
    };
  }
  
  /**
   * 初始化代理网关
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      this.logger.info('Initializing ProxyGateway...');
      this.stats.startTime = Date.now();
      
      // 检查配置
      this.validateConfig();
      
      // 初始化sing-box控制器（使用工作池模型）
      if (this.config.ENABLE_SINGBOX_GATEWAY) {
        await this.initializeWorkerPoolController();
      }
      
      // 初始化网络适配器
      await this.initializeNetworkAdapter();
      
      // 启动健康检查（如果启用）
      if (this.config.SINGBOX_HEALTH_CHECK_INTERVAL > 0) {
        this.startHealthCheck();
      }
      
      this.initialized = true;
      this.running = true;
      
      this.logger.info('ProxyGateway initialized successfully', {
        mode: this.config.NETWORK_MODE,
        singboxEnabled: this.config.ENABLE_SINGBOX_GATEWAY,
        healthCheckEnabled: this.config.SINGBOX_HEALTH_CHECK_INTERVAL > 0
      });
      
    } catch (error) {
      this.logger.error('ProxyGateway initialization failed', error);
      throw error;
    }
  }
  
  /**
   * 验证配置
   */
  validateConfig() {
    if (!this.config) {
      throw new Error('Configuration is required');
    }
    
    if (this.config.NETWORK_MODE === 'gateway' && !this.config.ENABLE_SINGBOX_GATEWAY) {
      throw new Error('Gateway mode requires ENABLE_SINGBOX_GATEWAY to be true');
    }
    
    if (this.config.ENABLE_SINGBOX_GATEWAY) {
      if (!this.config.SINGBOX_API_ENDPOINT) {
        throw new Error('SINGBOX_API_ENDPOINT is required when sing-box is enabled');
      }
      
      if (!this.config.SINGBOX_SELECTOR_NAME) {
        throw new Error('SINGBOX_SELECTOR_NAME is required when sing-box is enabled');
      }
    }
  }
  
  /**
   * 初始化工作池控制器（单例模式）
   */
  async initializeWorkerPoolController() {
    this.logger.debug('Initializing WorkerPoolController...');

    // 使用全局单例，确保所有分片共享同一个WorkerPoolController实例
    if (!globalWorkerPoolController) {
      const workerPoolLogger = this.logger.createSubLogger('WORKER-POOL');
      globalWorkerPoolController = new WorkerPoolController(this.config, workerPoolLogger);
      await globalWorkerPoolController.initialize();
      this.logger.debug('WorkerPoolController created and initialized (singleton)');
    } else {
      this.logger.debug('WorkerPoolController already exists (singleton)');
    }

    this.singboxController = globalWorkerPoolController;
  }
  
  /**
   * 初始化网络适配器
   */
  async initializeNetworkAdapter() {
    this.logger.debug('Initializing NetworkAdapter...');
    
    const networkLogger = this.logger.createSubLogger('NETWORK');
    this.networkAdapter = new NetworkAdapter(
      this.config,
      this.singboxController,
      networkLogger
    );
    
    this.logger.debug('NetworkAdapter initialized');
  }
  
  /**
   * 启动健康检查
   */
  startHealthCheck() {
    if (!this.singboxController) {
      this.logger.warn('Cannot start health check: SingboxController not initialized');
      return;
    }

    const interval = this.config.SINGBOX_HEALTH_CHECK_INTERVAL;
    this.logger.info(`Starting health check with ${interval}ms interval`);

    // 启动常规健康检查
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error('Health check failed', error);
      }
    }, interval);

    // 启动独立的隔离池检查（如果启用了工作池模式）
    if (this.config.NETWORK_MODE === 'gateway' &&
        typeof this.singboxController.getQuarantinedNodes === 'function') {
      this.startQuarantineCheck();
    }
  }

  /**
   * 启动隔离池检查定时器
   */
  startQuarantineCheck() {
    const quarantineInterval = this.config.SINGBOX_QUARANTINE_CHECK_INTERVAL;

    if (quarantineInterval <= 0) {
      this.logger.info('Quarantine check disabled (interval <= 0)');
      return;
    }

    this.logger.info(`Starting quarantine check with ${quarantineInterval}ms interval`);

    // 立即执行一次隔离池检查
    setTimeout(async () => {
      try {
        await this.performQuarantineCheck();
      } catch (error) {
        this.logger.error('Initial quarantine check failed', error);
      }
    }, 5000); // 延迟5秒启动，让系统先稳定

    // 启动定期隔离池检查
    this.quarantineCheckInterval = setInterval(async () => {
      try {
        await this.performQuarantineCheck();
      } catch (error) {
        this.logger.error('Quarantine check failed', error);
      }
    }, quarantineInterval);
  }
  
  /**
   * 执行健康检查
   */
  async performHealthCheck() {
    if (!this.running) return;

    this.stats.lastHealthCheck = Date.now();

    try {
      // 检查网络适配器健康状态
      const networkHealthy = await this.networkAdapter.healthCheck();

      if (!networkHealthy) {
        this.logger.warn('Network adapter health check failed');

        // 如果当前使用网关模式且有sing-box控制器，尝试切换节点
        if (this.config.NETWORK_MODE === 'gateway' && this.singboxController) {
          const currentNode = await this.singboxController.getCurrentNode();
          if (currentNode) {
            await this.singboxController.markNodeFailed(currentNode, 'Health check failed');
          }
        }
      }

      this.logger.debug('Health check completed', {
        networkHealthy,
        timestamp: this.stats.lastHealthCheck
      });

    } catch (error) {
      this.logger.error('Health check error', error);
    }
  }

  /**
   * 执行隔离池检查和恢复
   */
  async performQuarantineCheck() {
    try {
      this.logger.debug('[QUARANTINE] Starting quarantine pool check...');

      // 获取隔离池中的节点
      const quarantinedNodes = this.singboxController.getQuarantinedNodes();

      if (quarantinedNodes.length === 0) {
        this.logger.debug('[QUARANTINE] No nodes in quarantine pool');
        return;
      }

      this.logger.info(`[QUARANTINE] Checking ${quarantinedNodes.length} quarantined nodes`);

      let recoveredCount = 0;
      let checkedCount = 0;

      for (const nodeInfo of quarantinedNodes) {
        try {
          checkedCount++;

          // 检查是否允许永久隔离节点恢复
          if (nodeInfo.quarantineType === 'permanent' &&
              !this.config.SINGBOX_QUARANTINE_ENABLE_PERMANENT_RECOVERY) {
            this.logger.debug(`[QUARANTINE] Skipping permanent quarantine node: ${nodeInfo.nodeTag}`);
            continue;
          }

          this.logger.debug(`[QUARANTINE] Checking node: ${nodeInfo.nodeTag} (${nodeInfo.quarantineType})`);

          // 执行健康检查
          const isHealthy = await this.singboxController.healthCheck(
            nodeInfo.nodeTag,
            this.config.SINGBOX_QUARANTINE_HEALTH_CHECK_TIMEOUT
          );

          if (isHealthy) {
            // 尝试恢复节点
            const recovered = await this.singboxController.markNodeHealthy(nodeInfo.nodeTag);

            if (recovered) {
              recoveredCount++;
              this.logger.info(`[QUARANTINE] Node ${nodeInfo.nodeTag} recovered successfully`);
            } else {
              this.logger.debug(`[QUARANTINE] Node ${nodeInfo.nodeTag} health check passed but needs more successes`);
            }
          } else {
            this.logger.debug(`[QUARANTINE] Node ${nodeInfo.nodeTag} still unhealthy`);

            // 重置连续成功次数
            if (nodeInfo.consecutiveSuccesses > 0) {
              const quarantineInfo = this.singboxController.failedNodes.get(nodeInfo.nodeTag);
              if (quarantineInfo) {
                quarantineInfo.consecutiveSuccesses = 0;
                quarantineInfo.consecutiveFailures = (quarantineInfo.consecutiveFailures || 0) + 1;
                quarantineInfo.lastHealthCheck = Date.now();
              }
            }
          }

        } catch (error) {
          this.logger.warn(`[QUARANTINE] Error checking node ${nodeInfo.nodeTag}`, error);
        }
      }

      this.logger.info(`[QUARANTINE] Check completed: ${checkedCount} checked, ${recoveredCount} recovered`);

    } catch (error) {
      this.logger.error('[QUARANTINE] Quarantine check failed', error);
    }
  }
  
  /**
   * 获取网络客户端
   */
  getNetworkClient() {
    if (!this.initialized) {
      throw new Error('ProxyGateway not initialized. Call initialize() first.');
    }
    
    return this.networkAdapter;
  }
  
  /**
   * 获取sing-box控制器
   */
  getSingboxController() {
    return this.singboxController;
  }
  
  /**
   * 发起网络请求（便捷方法）
   */
  async request(options) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    this.stats.totalRequests++;
    
    try {
      const response = await this.networkAdapter.request(options);
      this.stats.successfulRequests++;
      return response;
    } catch (error) {
      this.stats.failedRequests++;
      throw error;
    }
  }
  
  /**
   * 获取统计信息
   */
  async getStats() {
    const currentTime = Date.now();
    this.stats.uptime = this.stats.startTime ? currentTime - this.stats.startTime : 0;
    
    const result = {
      gateway: { ...this.stats },
      network: this.networkAdapter ? this.networkAdapter.getStats() : null,
      singbox: this.singboxController ? await this.singboxController.getStats() : null
    };
    
    return result;
  }
  
  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      initialized: this.initialized,
      running: this.running,
      mode: this.config.NETWORK_MODE,
      singboxEnabled: this.config.ENABLE_SINGBOX_GATEWAY,
      healthCheckRunning: !!this.healthCheckInterval,
      quarantineCheckRunning: !!this.quarantineCheckInterval,
      quarantineCheckInterval: this.config.SINGBOX_QUARANTINE_CHECK_INTERVAL
    };
  }
  
  /**
   * 重新加载配置
   */
  async reload() {
    this.logger.info('Reloading ProxyGateway...');
    
    try {
      // 重新加载sing-box控制器
      if (this.singboxController) {
        await this.singboxController.reload();
      }
      
      this.logger.info('ProxyGateway reloaded successfully');
    } catch (error) {
      this.logger.error('ProxyGateway reload failed', error);
      throw error;
    }
  }
  
  /**
   * 停止代理网关
   */
  async stop() {
    this.logger.info('Stopping ProxyGateway...');

    this.running = false;

    // 停止健康检查
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    // 停止隔离池检查
    if (this.quarantineCheckInterval) {
      clearInterval(this.quarantineCheckInterval);
      this.quarantineCheckInterval = null;
    }

    // 清理sing-box控制器
    if (this.singboxController) {
      await this.singboxController.cleanup();
    }

    this.logger.info('ProxyGateway stopped');
  }

  /**
   * 重置全局WorkerPoolController实例（用于测试和重启）
   */
  static async resetGlobalWorkerPool() {
    if (globalWorkerPoolController) {
      if (typeof globalWorkerPoolController.cleanup === 'function') {
        await globalWorkerPoolController.cleanup();
      }
      globalWorkerPoolController = null;
    }
  }

  /**
   * 获取全局WorkerPoolController实例（用于调试）
   */
  static getGlobalWorkerPool() {
    return globalWorkerPoolController;
  }
}

module.exports = { ProxyGateway };
