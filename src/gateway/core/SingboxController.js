const { IProxyProvider } = require('../interfaces/IProxyProvider');
const { LoggerAdapter } = require('../adapters/LoggerAdapter');

/**
 * sing-box控制器
 * 负责管理sing-box代理节点的切换和健康状态
 * 使用Clash API进行节点控制
 */
class SingboxController extends IProxyProvider {
  constructor(config, logger = null) {
    super();
    this.config = config;
    this.logger = logger || new LoggerAdapter('SINGBOX');

    // 节点状态管理
    this.currentNode = null;
    this.healthyNodes = new Set();
    this.failedNodes = new Map(); // nodeId -> { reason, timestamp, retryCount }
    this.allNodes = new Set();
    
    // 统计信息
    this.stats = {
      totalNodes: 0,
      healthyNodes: 0,
      failedNodes: 0,
      switchCount: 0,
      lastSwitchTime: null,
      requestCount: 0,
      successCount: 0,
      failureCount: 0
    };
    
    this.initialized = false;
  }
  
  /**
   * 初始化控制器
   */
  async initialize() {
    if (this.initialized) return;

    try {
      this.logger.info('Initializing SingboxController with Clash API...');

      // 加载节点列表
      await this.loadNodes();

      // 选择初始节点
      if (this.healthyNodes.size > 0) {
        await this.selectInitialNode();
      } else {
        this.logger.warn('No healthy nodes available during initialization');
      }

      // 验证当前节点状态
      const verifiedNode = await this.verifyCurrentNode();

      this.initialized = true;
      this.logger.info('SingboxController initialized successfully', {
        totalNodes: this.stats.totalNodes,
        healthyNodes: this.stats.healthyNodes,
        currentNode: this.currentNode,
        verifiedNode: verifiedNode,
        apiType: 'clash'
      });

    } catch (error) {
      this.logger.error('SingboxController initialization failed', error);
      throw error;
    }
  }
  
  /**
   * 加载节点列表（使用Clash API）
   */
  async loadNodes() {
    try {
      // 从sing-box Clash API获取节点列表
      const response = await this.makeApiRequest('GET', '/proxies');

      // 【修复】正确访问嵌套的proxies对象
      if (response && response.proxies && typeof response.proxies === 'object') {
        // Clash API返回格式: { "proxies": { "节点名": {节点信息}, ... } }
        // 需要访问 response.proxies 而不是 response
        const proxyNodes = Object.entries(response.proxies).filter(([name, proxy]) =>
          proxy &&
          proxy.type !== 'Selector' &&    // 排除选择器节点
          proxy.type !== 'Direct' &&      // 排除直连节点
          proxy.type !== 'Fallback' &&    // 排除组合节点（如GLOBAL）
          name !== this.config.SINGBOX_SELECTOR_NAME  // 排除配置的选择器名称
        );

        // 更新节点集合
        this.allNodes.clear();
        this.healthyNodes.clear();

        proxyNodes.forEach(([name]) => {
          this.allNodes.add(name);
          this.healthyNodes.add(name); // 初始假设所有节点都健康
        });

        this.updateStats();

        this.logger.info('Loaded nodes from sing-box Clash API', {
          totalNodes: this.allNodes.size,
          nodeList: Array.from(this.allNodes),
          rawResponse: Object.keys(response.proxies), // 调试信息：显示原始响应中的所有节点
          filteredNodes: proxyNodes.map(([name, proxy]) => ({ name, type: proxy.type })) // 调试信息：显示过滤后的节点
        });
      } else {
        this.logger.warn('No proxies found in sing-box Clash API response', {
          responseStructure: response ? Object.keys(response) : 'null',
          hasProxies: !!(response && response.proxies)
        });
      }

    } catch (error) {
      this.logger.error('Failed to load nodes from sing-box', error);
      // 如果无法从API加载，使用配置中的默认节点
      await this.loadDefaultNodes();
    }
  }
  
  /**
   * 加载默认节点（降级方案）
   */
  async loadDefaultNodes() {
    // 从配置中获取默认节点列表
    const defaultNodes = this.config.SINGBOX_DEFAULT_NODES || [];
    
    if (defaultNodes.length > 0) {
      this.allNodes.clear();
      this.healthyNodes.clear();
      
      defaultNodes.forEach(nodeId => {
        this.allNodes.add(nodeId);
        this.healthyNodes.add(nodeId);
      });
      
      this.updateStats();
      this.logger.info('Loaded default nodes from config', {
        totalNodes: this.allNodes.size,
        nodeList: defaultNodes
      });
    } else {
      this.logger.warn('No default nodes configured');
    }
  }
  
  /**
   * 选择初始节点
   */
  async selectInitialNode() {
    const availableNodes = Array.from(this.healthyNodes);
    if (availableNodes.length === 0) {
      throw new Error('No healthy nodes available for initial selection');
    }
    
    // 选择第一个健康节点作为初始节点
    const initialNode = availableNodes[0];
    const success = await this.switchToNode(initialNode);
    
    if (!success) {
      this.logger.warn(`Failed to switch to initial node: ${initialNode}, trying next...`);
      // 尝试下一个节点
      for (let i = 1; i < availableNodes.length; i++) {
        const nextNode = availableNodes[i];
        const nextSuccess = await this.switchToNode(nextNode);
        if (nextSuccess) {
          break;
        }
      }
    }
  }
  
  /**
   * 切换到指定节点（使用Clash API）
   */
  async switchToNode(nodeId) {
    if (!nodeId) {
      this.logger.error('Cannot switch to empty nodeId');
      return false;
    }

    // 导入TTS日志器
    const { ttsLogger } = require('../../utils/ttsLogger');
    const contextLogger = ttsLogger.createContextLogger({});

    try {
      this.logger.debug(`Attempting to switch to node: ${nodeId} using Clash API`);

      contextLogger.logNode('Attempting node switch', {
        targetNode: nodeId,
        currentNode: this.currentNode,
        selector: this.config.SINGBOX_SELECTOR_NAME,
        apiType: 'clash',
        endpoint: `${this.config.SINGBOX_API_ENDPOINT}/proxies/${this.config.SINGBOX_SELECTOR_NAME}`,
        requestBody: { name: nodeId }
      });

      // 使用Clash API格式进行节点切换
      // PUT /proxies/{selector_name} with { "name": "节点名称" }
      const success = await this.makeApiRequest('PUT', `/proxies/${this.config.SINGBOX_SELECTOR_NAME}`, {
        name: nodeId  // Clash API使用 "name" 字段
      });

      if (success) {
        const oldNode = this.currentNode;
        this.currentNode = nodeId;
        this.stats.switchCount++;
        this.stats.lastSwitchTime = Date.now();

        this.logger.info(`Successfully switched to node: ${nodeId}`, {
          oldNode,
          newNode: nodeId,
          switchCount: this.stats.switchCount,
          apiType: 'clash'
        });

        contextLogger.logNode('Node switch successful', {
          oldNode,
          newNode: nodeId,
          switchCount: this.stats.switchCount,
          totalNodes: this.stats.totalNodes,
          healthyNodes: this.stats.healthyNodes
        });

        return true;
      } else {
        this.logger.error(`Failed to switch to node: ${nodeId}`);

        contextLogger.logNode('Node switch failed', {
          targetNode: nodeId,
          currentNode: this.currentNode,
          reason: 'API request returned false'
        });

        return false;
      }

    } catch (error) {
      this.logger.error(`Error switching to node: ${nodeId}`, error);

      contextLogger.logError(error, 'node-switch', {
        targetNode: nodeId,
        currentNode: this.currentNode,
        selector: this.config.SINGBOX_SELECTOR_NAME
      });

      return false;
    }
  }
  
  /**
   * 发起sing-box Clash API请求
   */
  async makeApiRequest(method, path, data = null) {
    const url = `${this.config.SINGBOX_API_ENDPOINT}${path}`;

    // 【修复】使用AbortController实现超时，兼容Node.js 18+ fetch API
    const timeoutMs = this.config.SINGBOX_NODE_TIMEOUT || 15000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      signal: abortController.signal  // 使用AbortController替代timeout选项
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);

      // 清除超时定时器
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // 如果是GET请求，返回JSON数据
      if (method === 'GET') {
        return await response.json();
      }

      // 其他请求返回成功状态
      return true;

    } catch (error) {
      // 清除超时定时器
      clearTimeout(timeoutId);

      // 处理不同类型的错误
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`Request timeout after ${timeoutMs}ms`);
        this.logger.error(`sing-box Clash API request timeout: ${method} ${path}`, {
          timeout: timeoutMs,
          url
        });
        throw timeoutError;
      }

      this.logger.error(`sing-box Clash API request failed: ${method} ${path}`, {
        error: error.message,
        url,
        method
      });
      throw error;
    }
  }
  
  /**
   * 更新统计信息
   */
  updateStats() {
    this.stats.totalNodes = this.allNodes.size;
    this.stats.healthyNodes = this.healthyNodes.size;
    this.stats.failedNodes = this.failedNodes.size;
  }

  // ========== IProxyProvider接口实现 ==========

  /**
   * 获取可用代理节点列表
   */
  async getAvailableNodes() {
    return Array.from(this.healthyNodes);
  }

  /**
   * 获取当前使用的节点
   */
  async getCurrentNode() {
    return this.currentNode;
  }

  /**
   * 验证当前节点状态（从API获取实际状态）
   */
  async verifyCurrentNode() {
    try {
      const response = await this.makeApiRequest('GET', `/proxies/${this.config.SINGBOX_SELECTOR_NAME}`);

      if (response && response.now) {
        const actualCurrentNode = response.now;

        // 如果API返回的当前节点与我们记录的不一致，更新记录
        if (actualCurrentNode !== this.currentNode) {
          this.logger.warn('Node state mismatch detected', {
            recorded: this.currentNode,
            actual: actualCurrentNode,
            selector: this.config.SINGBOX_SELECTOR_NAME
          });

          // 更新我们的记录以匹配实际状态
          this.currentNode = actualCurrentNode;
        }

        return actualCurrentNode;
      }

      return this.currentNode;
    } catch (error) {
      this.logger.error('Failed to verify current node', error);
      return this.currentNode;
    }
  }

  /**
   * 标记节点为失败状态
   */
  async markNodeFailed(nodeId, reason = 'Unknown error') {
    if (!this.allNodes.has(nodeId)) {
      this.logger.warn(`Attempted to mark unknown node as failed: ${nodeId}`);
      return;
    }

    // 导入TTS日志器
    const { ttsLogger } = require('../../utils/ttsLogger');
    const contextLogger = ttsLogger.createContextLogger({});

    const wasHealthy = this.healthyNodes.has(nodeId);
    const oldRetryCount = this.failedNodes.get(nodeId)?.retryCount || 0;

    // 从健康节点中移除
    this.healthyNodes.delete(nodeId);

    // 添加到失败节点
    this.failedNodes.set(nodeId, {
      reason,
      timestamp: Date.now(),
      retryCount: oldRetryCount + 1
    });

    this.updateStats();

    this.logger.warn(`Node marked as failed: ${nodeId}`, {
      reason,
      retryCount: this.failedNodes.get(nodeId).retryCount,
      remainingHealthyNodes: this.healthyNodes.size
    });

    // 记录节点状态变化
    contextLogger.logNode('Node marked as failed', {
      nodeId,
      reason,
      retryCount: this.failedNodes.get(nodeId).retryCount,
      wasHealthy,
      remainingHealthyNodes: this.healthyNodes.size,
      totalNodes: this.allNodes.size,
      isCurrentNode: this.currentNode === nodeId
    });

    // 如果当前节点失败，自动切换到下一个健康节点
    if (this.currentNode === nodeId) {
      contextLogger.logNode('Current node failed, selecting next healthy node', {
        failedNode: nodeId,
        availableNodes: Array.from(this.healthyNodes)
      });

      await this.selectNextHealthyNode();
    }
  }

  /**
   * 恢复节点为健康状态
   */
  async markNodeHealthy(nodeId) {
    if (!this.allNodes.has(nodeId)) {
      this.logger.warn(`Attempted to mark unknown node as healthy: ${nodeId}`);
      return;
    }

    const wasFailedBefore = this.failedNodes.has(nodeId);

    // 添加到健康节点
    this.healthyNodes.add(nodeId);

    // 从失败节点中移除
    this.failedNodes.delete(nodeId);

    this.updateStats();

    if (wasFailedBefore) {
      this.logger.info(`Node recovered: ${nodeId}`, {
        healthyNodes: this.healthyNodes.size
      });
    }
  }

  /**
   * 获取节点健康状态
   */
  async isNodeHealthy(nodeId) {
    return this.healthyNodes.has(nodeId);
  }

  /**
   * 选择下一个健康节点
   */
  async selectNextHealthyNode() {
    const availableNodes = Array.from(this.healthyNodes);

    if (availableNodes.length === 0) {
      this.logger.error('No healthy nodes available for switching');
      throw new Error('No healthy nodes available');
    }

    // 选择第一个可用节点
    const nextNode = availableNodes[0];
    const success = await this.switchToNode(nextNode);

    if (!success) {
      // 如果切换失败，标记该节点为失败并尝试下一个
      await this.markNodeFailed(nextNode, 'Switch operation failed');

      if (availableNodes.length > 1) {
        // 递归尝试下一个节点
        await this.selectNextHealthyNode();
      } else {
        throw new Error('All nodes failed during switching');
      }
    }
  }

  /**
   * 获取代理统计信息
   */
  async getStats() {
    return {
      ...this.stats,
      currentNode: this.currentNode,
      failedNodeDetails: Object.fromEntries(this.failedNodes),
      apiType: 'clash'
    };
  }

  /**
   * 重新加载节点配置
   */
  async reload() {
    this.logger.info('Reloading SingboxController...');

    try {
      await this.loadNodes();

      // 如果当前节点不在新的节点列表中，选择新的节点
      if (this.currentNode && !this.allNodes.has(this.currentNode)) {
        this.logger.warn(`Current node ${this.currentNode} not found in new node list, selecting new node`);
        this.currentNode = null;
        await this.selectInitialNode();
      }

      this.logger.info('SingboxController reloaded successfully');
    } catch (error) {
      this.logger.error('Failed to reload SingboxController', error);
      throw error;
    }
  }

  /**
   * 清理资源
   */
  async cleanup() {
    this.logger.info('Cleaning up SingboxController...');

    // 清理状态
    this.currentNode = null;
    this.healthyNodes.clear();
    this.failedNodes.clear();
    this.allNodes.clear();
    this.initialized = false;

    this.logger.info('SingboxController cleanup completed');
  }
}

module.exports = { SingboxController };
