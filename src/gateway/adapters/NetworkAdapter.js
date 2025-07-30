const { INetworkClient } = require('../interfaces/INetworkClient');
const { LoggerAdapter } = require('./LoggerAdapter');

/**
 * 网络适配器
 * 提供统一的网络请求接口，支持多种网络模式
 */
class NetworkAdapter extends INetworkClient {
  constructor(config, proxyProvider = null, logger = null) {
    super();
    this.config = config;
    this.proxyProvider = proxyProvider;
    this.logger = logger || new LoggerAdapter('NETWORK');
    this.mode = config.NETWORK_MODE || 'direct';
    
    // 统计信息
    this.stats = {
      mode: this.mode,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRequestTime: null,
      totalResponseTime: 0,
      averageResponseTime: 0
    };
  }
  
  /**
   * 统一网络请求入口
   */
  async request(options) {
    const startTime = Date.now();
    this.stats.requestCount++;
    this.stats.lastRequestTime = startTime;
    
    try {
      this.logger.debug(`Making ${this.mode} request`, {
        method: options.method || 'GET',
        url: options.url,
        mode: this.mode
      });
      
      let response;
      
      switch (this.mode) {
        case 'gateway':
          response = await this.requestViaGateway(options);
          break;
        case 'proxy':
          response = await this.requestViaProxy(options);
          break;
        case 'fallback':
          response = await this.requestWithFallback(options);
          break;
        case 'direct':
        default:
          response = await this.requestDirect(options);
          break;
      }
      
      const duration = Date.now() - startTime;
      this.updateStats(true, duration);
      
      this.logger.network(
        options.method || 'GET',
        options.url,
        response.status,
        duration
      );
      
      return response;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      this.updateStats(false, duration);
      
      this.logger.error(`Network request failed in ${this.mode} mode`, error, {
        method: options.method || 'GET',
        url: options.url,
        duration
      });
      
      throw error;
    }
  }
  
  /**
   * 直连请求
   */
  async requestDirect(options) {
    const fetchOptions = this.buildFetchOptions(options);
    
    try {
      const response = await fetch(options.url, fetchOptions);
      return response;
    } catch (error) {
      throw new Error(`Direct request failed: ${error.message}`);
    }
  }
  
  /**
   * 通过现有代理服务器请求
   */
  async requestViaProxy(options) {
    // 使用现有的代理逻辑
    const { getTTSProxyConfig } = require('../../utils/config');
    const proxyConfig = getTTSProxyConfig();
    
    if (!proxyConfig.ENABLE_TTS_PROXY || !proxyConfig.TTS_PROXY_URLS?.length) {
      throw new Error('Proxy mode enabled but no proxy URLs configured');
    }
    
    // 使用现有的智能代理重试机制
    const { callTtsProxyWithSmartRetry } = require('../../utils/ttsUtils');
    
    // 适配现有代理接口（这里需要根据实际API调整）
    if (options.url.includes('text-to-speech')) {
      // TTS请求，使用现有逻辑
      throw new Error('TTS proxy requests should use existing ttsUtils functions');
    } else {
      // 其他请求，使用简单代理
      return await this.requestViaSimpleProxy(options, proxyConfig);
    }
  }
  
  /**
   * 通过sing-box工作池网关请求
   */
  async requestViaGateway(options) {
    if (!this.config.ENABLE_SINGBOX_GATEWAY) {
      throw new Error('Gateway mode enabled but ENABLE_SINGBOX_GATEWAY is false');
    }

    if (!this.proxyProvider || typeof this.proxyProvider.acquireWorker !== 'function') {
      throw new Error('WorkerPoolController not available or not properly initialized');
    }

    // 导入TTS日志器
    const { ttsLogger } = require('../../utils/ttsLogger');
    const contextLogger = ttsLogger.createContextLogger({});

    // 获取重试配置，默认最大重试1次
    const maxRetries = this.config.GATEWAY_REQUEST_MAX_RETRIES || 1;
    let lastError = null;

    // 重试循环
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let acquiredInfo = null;

      try {
        // 1. 获取一个已分配好节点的工人
        acquiredInfo = await this.proxyProvider.acquireWorker();
        const { worker, nodeTag } = acquiredInfo;

        contextLogger.logGateway('Worker acquired for request', {
          workerId: worker.id,
          workerPort: worker.port,
          assignedNode: nodeTag,
          method: options.method || 'GET',
          url: options.url,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1
        });

        // 2. 使用该工人的专用端口创建代理
        const proxyConfig = this.createSocksAgent(worker.port);
        const socksInfo = `${this.config.SINGBOX_PROXY_HOST || '127.0.0.1'}:${worker.port}`;

        contextLogger.logGateway('Making request via worker pool', {
          socksProxy: socksInfo,
          workerId: worker.id,
          assignedNode: nodeTag,
          method: options.method || 'GET',
          hasProxy: !!proxyConfig,
          proxyType: proxyConfig?.type || 'none',
          attempt: attempt + 1
        });

        // 3. 发起请求
        const fetchOptions = this.buildFetchOptions(options, proxyConfig);
        const response = await fetch(options.url, fetchOptions);

        // 记录响应状态
        contextLogger.logGateway('Worker pool response received', {
          status: response.status,
          ok: response.ok,
          workerId: worker.id,
          assignedNode: nodeTag,
          attempt: attempt + 1
        });

        // 4. 检查响应状态
        if (!response.ok) {
          await this.handleWorkerPoolError(response, options, worker, nodeTag);
        } else {
          // 成功请求，更新工人统计
          worker.successCount++;
        }

        // 请求成功，返回响应
        return response;

      } catch (error) {
        lastError = error;

        // 记录工作池错误
        contextLogger.logError(error, 'worker-pool-request', {
          method: options.method || 'GET',
          url: options.url,
          workerId: acquiredInfo?.worker?.id,
          assignedNode: acquiredInfo?.nodeTag,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1
        });

        // 处理网络错误，标记节点失败
        await this.handleWorkerPoolNetworkError(error, options, acquiredInfo);

        // 如果是最后一次尝试，抛出错误
        if (attempt === maxRetries) {
          throw error;
        }

        // 记录重试日志
        contextLogger.logGateway('Gateway request failed, retrying with new node', {
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          error: error.message,
          failedNode: acquiredInfo?.nodeTag,
          willRetry: true
        });

      } finally {
        // 5. 无论成功失败，都必须归还工人
        if (acquiredInfo) {
          this.proxyProvider.releaseWorker(acquiredInfo.worker);

          contextLogger.logGateway('Worker released', {
            workerId: acquiredInfo.worker.id,
            assignedNode: acquiredInfo.nodeTag,
            attempt: attempt + 1
          });
        }
      }
    }

    // 如果所有重试都失败，抛出最后的错误
    throw lastError || new Error('Gateway request failed after all retries');
  }
  
  /**
   * 带降级的请求（先直连，失败后使用代理）
   */
  async requestWithFallback(options) {
    try {
      // 首先尝试直连
      this.logger.debug('Attempting direct connection first (fallback mode)');
      return await this.requestDirect(options);
      
    } catch (directError) {
      this.logger.warn('Direct connection failed, falling back to proxy', {
        error: directError.message
      });
      
      try {
        // 尝试网关模式
        if (this.config.ENABLE_SINGBOX_GATEWAY) {
          return await this.requestViaGateway(options);
        } else {
          // 尝试传统代理模式
          return await this.requestViaProxy(options);
        }
      } catch (fallbackError) {
        this.logger.error('All fallback methods failed', fallbackError);
        throw new Error(`Fallback failed: Direct (${directError.message}), Proxy (${fallbackError.message})`);
      }
    }
  }
  
  /**
   * 创建SOCKS代理agent/dispatcher
   * @param {number} port - 可选的端口号，如果不提供则使用默认配置端口
   */
  createSocksAgent(port = null) {
    try {
      const proxyPort = port || this.config.SINGBOX_PROXY_PORT;
      const proxyHost = this.config.SINGBOX_PROXY_HOST || '127.0.0.1';

      // 首先尝试使用fetch-socks（支持Node.js fetch的undici dispatcher）
      try {
        const { socksDispatcher } = require('fetch-socks');
        return {
          type: 'dispatcher',
          dispatcher: socksDispatcher({
            type: 5,
            host: proxyHost,
            port: proxyPort
          })
        };
      } catch (fetchSocksError) {
        this.logger.debug('fetch-socks not available, falling back to socks-proxy-agent');
      }

      // 降级到传统的socks-proxy-agent（用于axios等）
      const { SocksProxyAgent } = require('socks-proxy-agent');
      const proxyUrl = `socks5h://${proxyHost}:${proxyPort}`;
      return {
        type: 'agent',
        agent: new SocksProxyAgent(proxyUrl)
      };

    } catch (error) {
      this.logger.warn('No SOCKS proxy library available, using direct connection', {
        error: error.message,
        port: port || this.config.SINGBOX_PROXY_PORT
      });
      return null;
    }
  }
  
  /**
   * 构建fetch选项
   */
  buildFetchOptions(options, proxyConfig = null) {
    const fetchOptions = {
      method: options.method || 'GET',
      headers: options.headers || {},
      signal: options.signal
    };

    // 添加请求体
    if (options.body) {
      fetchOptions.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    // 添加超时控制
    if (options.timeout && !options.signal) {
      fetchOptions.signal = AbortSignal.timeout(options.timeout);
    }

    // 添加代理配置（Node.js环境）
    if (proxyConfig && typeof window === 'undefined') {
      if (proxyConfig.type === 'dispatcher') {
        // 使用undici dispatcher（支持Node.js fetch）
        fetchOptions.dispatcher = proxyConfig.dispatcher;
      } else if (proxyConfig.type === 'agent') {
        // 使用传统agent（降级支持）
        fetchOptions.agent = proxyConfig.agent;
      }
    }

    return fetchOptions;
  }
  
  /**
   * 处理网关错误
   */
  async handleGatewayError(response, options) {
    const status = response.status;
    
    // 检查是否是需要切换节点的错误
    if ([403, 429, 502, 503].includes(status)) {
      this.logger.warn(`Gateway error ${status}, triggering node switch`, {
        url: options.url,
        status
      });
      
      if (this.proxyProvider) {
        try {
          const currentNode = await this.proxyProvider.getCurrentNode();
          if (currentNode) {
            await this.proxyProvider.markNodeFailed(currentNode, `HTTP ${status} error`);
          }
        } catch (error) {
          this.logger.error('Failed to handle gateway error', error);
        }
      }
    }
  }
  
  /**
   * 处理网络错误
   */
  async handleNetworkError(error, options) {
    // 检查是否是连接相关错误
    if (error.name === 'TypeError' || error.message.includes('fetch')) {
      this.logger.warn('Network connectivity error, triggering node switch', {
        error: error.message,
        url: options.url
      });

      if (this.proxyProvider) {
        try {
          const currentNode = await this.proxyProvider.getCurrentNode();
          if (currentNode) {
            await this.proxyProvider.markNodeFailed(currentNode, `Network error: ${error.message}`);
          }
        } catch (providerError) {
          this.logger.error('Failed to handle network error', providerError);
        }
      }
    }
  }

  /**
   * 处理工作池错误
   */
  async handleWorkerPoolError(response, options, worker, nodeTag) {
    const status = response.status;

    // 检查是否是需要切换节点的错误
    if ([403, 429, 502, 503].includes(status)) {
      this.logger.warn(`Worker pool error ${status}, marking node as failed`, {
        url: options.url,
        status,
        workerId: worker.id,
        nodeTag
      });

      // 更新工人统计
      worker.failureCount++;

      // 标记节点为失败
      if (this.proxyProvider && typeof this.proxyProvider.removeNode === 'function') {
        try {
          this.proxyProvider.removeNode(nodeTag, `HTTP ${status} error`);
        } catch (error) {
          this.logger.error('Failed to mark node as failed', error);
        }
      }
    }
  }

  /**
   * 处理工作池网络错误
   */
  async handleWorkerPoolNetworkError(error, options, acquiredInfo) {
    // 检查是否是连接相关错误
    if (error.name === 'TypeError' || error.message.includes('fetch')) {
      this.logger.warn('Worker pool network connectivity error', {
        error: error.message,
        url: options.url,
        workerId: acquiredInfo?.worker?.id,
        nodeTag: acquiredInfo?.nodeTag
      });

      if (acquiredInfo && this.proxyProvider && typeof this.proxyProvider.removeNode === 'function') {
        try {
          // 更新工人统计
          acquiredInfo.worker.failureCount++;

          // 标记节点为失败
          this.proxyProvider.removeNode(acquiredInfo.nodeTag, `Network error: ${error.message}`);
        } catch (providerError) {
          this.logger.error('Failed to handle worker pool network error', providerError);
        }
      }
    }
  }

  /**
   * 简单代理请求（用于非TTS请求）
   */
  async requestViaSimpleProxy(options, proxyConfig) {
    const proxyUrls = proxyConfig.TTS_PROXY_URLS;
    let lastError;

    for (const proxyUrl of proxyUrls) {
      try {
        // 构建代理请求URL（这里需要根据代理服务器的具体实现调整）
        const proxyRequestUrl = `${proxyUrl}/proxy`;

        const proxyOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-proxy-secret': proxyConfig.TTS_PROXY_SECRET
          },
          body: JSON.stringify({
            url: options.url,
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body
          }),
          signal: options.signal || AbortSignal.timeout(proxyConfig.TTS_PROXY_TIMEOUT || 45000)
        };

        const response = await fetch(proxyRequestUrl, proxyOptions);

        if (response.ok) {
          return response;
        } else {
          throw new Error(`Proxy server error: ${response.status}`);
        }

      } catch (error) {
        lastError = error;
        this.logger.warn(`Proxy ${proxyUrl} failed, trying next`, { error: error.message });
      }
    }

    throw new Error(`All proxy servers failed. Last error: ${lastError?.message}`);
  }

  /**
   * 更新统计信息
   */
  updateStats(success, duration) {
    if (success) {
      this.stats.successCount++;
    } else {
      this.stats.failureCount++;
    }

    this.stats.totalResponseTime += duration;
    this.stats.averageResponseTime = this.stats.totalResponseTime / this.stats.requestCount;
  }

  // ========== INetworkClient接口实现 ==========

  /**
   * 获取当前网络模式
   */
  getMode() {
    return this.mode;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      const testUrl = 'https://httpbin.org/ip';
      const response = await this.request({
        url: testUrl,
        method: 'GET',
        timeout: 5000
      });

      const isHealthy = response.ok;

      this.logger.debug('Health check completed', {
        mode: this.mode,
        healthy: isHealthy,
        status: response.status
      });

      return isHealthy;

    } catch (error) {
      this.logger.warn('Health check failed', { error: error.message });
      return false;
    }
  }

  /**
   * 获取网络统计信息
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats = {
      mode: this.mode,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRequestTime: null,
      totalResponseTime: 0,
      averageResponseTime: 0
    };

    this.logger.debug('Network statistics reset');
  }

  /**
   * 设置代理提供者
   */
  setProxyProvider(proxyProvider) {
    this.proxyProvider = proxyProvider;
    this.logger.debug('Proxy provider updated');
  }

  /**
   * 切换网络模式
   */
  switchMode(newMode) {
    const validModes = ['direct', 'proxy', 'gateway', 'fallback'];

    if (!validModes.includes(newMode)) {
      throw new Error(`Invalid network mode: ${newMode}. Valid modes: ${validModes.join(', ')}`);
    }

    const oldMode = this.mode;
    this.mode = newMode;
    this.stats.mode = newMode;

    this.logger.info('Network mode switched', {
      oldMode,
      newMode
    });
  }
}

module.exports = { NetworkAdapter };
