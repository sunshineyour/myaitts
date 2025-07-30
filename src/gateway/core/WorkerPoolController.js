const { IProxyProvider } = require('../interfaces/IProxyProvider');
const { LoggerAdapter } = require('../adapters/LoggerAdapter');

/**
 * 工作池控制器
 * 实现"大脑管理的工作池(Worker Pool)"模型
 * 管理多个独立的代理工人，每个工人有专用端口和选择器
 */
class WorkerPoolController extends IProxyProvider {
  constructor(config, logger = null) {
    super();
    this.config = config;
    this.logger = logger || new LoggerAdapter('WORKER-POOL');

    // 节点状态管理
    this.healthyNodeTags = new Set(); // 健康节点池
    this.failedNodes = new Map(); // nodeId -> { reason, timestamp, retryCount }
    this.allNodes = new Set(); // 所有节点
    this.nodeIndex = -1; // 节点轮询索引，从-1开始，第一次调用时变为0

    // 工人池管理
    this.workers = [];
    this.workerIndex = -1; // 工人轮询索引，从-1开始，第一次调用时变为0
    this.initializeWorkers();

    // 统计信息
    this.stats = {
      totalNodes: 0,
      healthyNodes: 0,
      failedNodes: 0,
      totalWorkers: this.workers.length,
      busyWorkers: 0,
      idleWorkers: this.workers.length,
      workerSwitches: 0,
      lastWorkerSwitch: null,
      requestCount: 0,
      successCount: 0,
      failureCount: 0
    };

    this.initialized = false;
  }

  /**
   * 初始化工人池
   */
  initializeWorkers() {
    const poolSize = this.config.SINGBOX_WORKER_POOL_SIZE;
    const portStart = this.config.SINGBOX_WORKER_PORT_START;
    const selectorPrefix = this.config.SINGBOX_WORKER_SELECTOR_PREFIX;

    this.workers = [];
    for (let i = 1; i <= poolSize; i++) {
      this.workers.push({
        id: i,
        port: portStart + i - 1,
        selector: `${selectorPrefix}-${i}`,
        isBusy: false,
        currentNode: null,
        assignedAt: null,
        requestCount: 0,
        successCount: 0,
        failureCount: 0
      });
    }

    this.logger.info('Worker pool initialized', {
      poolSize,
      portRange: `${portStart}-${portStart + poolSize - 1}`,
      selectorPrefix
    });
  }

  /**
   * 初始化控制器
   */
  async initialize() {
    if (this.initialized) return;

    try {
      this.logger.info('Initializing WorkerPoolController with Clash API...');

      // 加载节点列表
      await this.loadNodes();

      // 加载持久化的隔离池数据
      await this.loadQuarantineData();

      // 验证工人选择器是否存在
      await this.validateWorkerSelectors();

      this.initialized = true;
      this.logger.info('WorkerPoolController initialized successfully', {
        totalNodes: this.stats.totalNodes,
        healthyNodes: this.stats.healthyNodes,
        quarantinedNodes: this.stats.failedNodes,
        totalWorkers: this.stats.totalWorkers,
        apiType: 'clash'
      });

    } catch (error) {
      this.logger.error('WorkerPoolController initialization failed', error);
      throw error;
    }
  }

  /**
   * 验证节点名称格式
   * @param {string} nodeName - 节点名称
   * @returns {boolean} 是否为有效的节点名称
   */
  validateNodeName(nodeName) {
    if (!nodeName || typeof nodeName !== 'string') {
      return false;
    }

    // 验证节点名称格式：国家代码-服务商-编号-索引
    // 例如：jp-awsjp-01-idx-0, us-us-01-0-1-hy2-idx-10
    const nodeNamePattern = /^[a-z]{2}-[a-z0-9]+-.*-idx-\d+$/i;
    return nodeNamePattern.test(nodeName);
  }

  /**
   * 从sing-box加载节点列表
   */
  async loadNodes() {
    try {
      this.logger.debug('Loading nodes from sing-box Clash API...');
      const response = await this.makeApiRequest('GET', '/proxies');

      // 导入TTS日志器
      const { ttsLogger } = require('../../utils/ttsLogger');
      const contextLogger = ttsLogger.createContextLogger({});

      if (response && response.proxies && typeof response.proxies === 'object') {
        // 过滤出真实的代理节点，排除选择器和工人选择器
        const proxyNodes = Object.entries(response.proxies).filter(([name, proxy]) =>
          proxy &&
          proxy.type !== 'Selector' &&
          proxy.type !== 'Direct' &&
          proxy.type !== 'Fallback' &&
          !name.startsWith(this.config.SINGBOX_WORKER_SELECTOR_PREFIX) && // 排除工人选择器
          name !== this.config.SINGBOX_SELECTOR_NAME // 排除主选择器
        );

        // 更新节点集合，应用emoji修复
        this.allNodes.clear();
        this.healthyNodeTags.clear();

        const validNodes = [];
        proxyNodes.forEach(([name, proxy]) => {
          // 验证节点名称格式
          if (this.validateNodeName(name)) {
            this.allNodes.add(name);
            this.healthyNodeTags.add(name); // 初始假设所有节点都健康
            validNodes.push({ name, type: proxy.type });
          } else {
            this.logger.warn(`Skipping invalid node name: ${name}`);
          }
        });

        this.updateStats();

        // 简化节点列表显示，避免日志过长
        const nodeListSample = Array.from(this.allNodes);
        const displayNodeList = nodeListSample.length > 10
          ? [...nodeListSample.slice(0, 10), `...${nodeListSample.length - 10} more`]
          : nodeListSample;

        const validNodeDetailsSample = validNodes.length > 10
          ? [...validNodes.slice(0, 10).map(node => ({ name: node.name, type: node.type })),
             { name: `...${validNodes.length - 10} more nodes`, type: 'truncated' }]
          : validNodes.map(node => ({ name: node.name, type: node.type }));

        contextLogger.logNode('Loaded nodes for worker pool', {
          totalNodes: this.allNodes.size,
          validNodes: validNodes.length,
          nodeList: displayNodeList,
          validNodeDetails: validNodeDetailsSample
        });

        this.logger.info('Loaded nodes from sing-box Clash API', {
          totalNodes: this.allNodes.size,
          validNodes: validNodes.length,
          nodeList: displayNodeList
        });
      } else {
        this.logger.warn('No proxies found in sing-box Clash API response');
      }

    } catch (error) {
      this.logger.error('Failed to load nodes from sing-box', error);
      // 如果无法从API加载，使用配置中的默认节点
      await this.loadDefaultNodes();
    }
  }

  /**
   * 加载默认节点（当API不可用时）
   */
  async loadDefaultNodes() {
    this.logger.warn('Loading default nodes as fallback...');
    
    // 这里可以从配置文件或环境变量加载默认节点
    const defaultNodes = ['SG-01-vless', 'US-01-hy2', 'US-02-hy2', 'US-03-hy2'];
    
    this.allNodes.clear();
    this.healthyNodeTags.clear();
    
    defaultNodes.forEach(node => {
      this.allNodes.add(node);
      this.healthyNodeTags.add(node);
    });
    
    this.updateStats();
    
    const defaultNodeList = Array.from(this.allNodes);
    const displayDefaultNodes = defaultNodeList.length > 10
      ? [...defaultNodeList.slice(0, 10), `...${defaultNodeList.length - 10} more`]
      : defaultNodeList;

    this.logger.info('Loaded default nodes', {
      totalNodes: this.allNodes.size,
      nodeList: displayDefaultNodes
    });
  }

  /**
   * 验证工人选择器是否存在
   */
  async validateWorkerSelectors() {
    this.logger.debug('Validating worker selectors...');
    
    const missingSelectors = [];
    
    for (const worker of this.workers) {
      try {
        const response = await this.makeApiRequest('GET', `/proxies/${worker.selector}`);
        if (!response || !response.type || response.type !== 'Selector') {
          missingSelectors.push(worker.selector);
        }
      } catch (error) {
        missingSelectors.push(worker.selector);
      }
    }
    
    if (missingSelectors.length > 0) {
      throw new Error(`Missing worker selectors in sing-box config: ${missingSelectors.join(', ')}`);
    }
    
    this.logger.info('All worker selectors validated successfully');
  }

  /**
   * 健康检查单个节点
   * @param {string} nodeTag - 节点标签
   * @param {number} timeout - 超时时间（毫秒），默认5秒
   * @returns {Promise<boolean>} 节点是否健康
   */
  async healthCheck(nodeTag, timeout = 5000) {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeout);

      const response = await fetch('http://www.gstatic.com/generate_204', {
        method: 'GET',
        signal: abortController.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      clearTimeout(timeoutId);

      // gstatic.com/generate_204 应该返回 204 No Content
      const isHealthy = response.status === 204;

      this.logger.debug(`Health check for node ${nodeTag}`, {
        nodeTag,
        status: response.status,
        healthy: isHealthy,
        duration: Date.now() - (Date.now() - timeout)
      });

      return isHealthy;

    } catch (error) {
      this.logger.debug(`Health check failed for node ${nodeTag}`, {
        nodeTag,
        error: error.message,
        healthy: false
      });
      return false;
    }
  }

  /**
   * 获取下一个健康节点（轮询）
   */
  getNextHealthyNode() {
    if (this.healthyNodeTags.size === 0) {
      throw new Error('No healthy nodes available');
    }

    const healthyNodes = Array.from(this.healthyNodeTags);
    this.nodeIndex = (this.nodeIndex + 1) % healthyNodes.length;
    return healthyNodes[this.nodeIndex];
  }

  /**
   * 签出一个工人并为其分配节点（带懒加载健康检查）
   * @returns {Promise<{worker: Object, nodeTag: string}>} 工人和分配的节点
   */
  async acquireWorker() {
    // 使用轮询方式选择工人，而不是总是选择第一个
    const availableWorkers = this.workers.filter(w => !w.isBusy);
    if (availableWorkers.length === 0) {
      throw new Error('所有代理工人都处于繁忙状态');
    }

    // 轮询选择工人，确保负载均衡
    this.workerIndex = (this.workerIndex + 1) % availableWorkers.length;
    const worker = availableWorkers[this.workerIndex];

    // 标记工人为繁忙
    worker.isBusy = true;
    worker.assignedAt = Date.now();

    // 懒加载健康检查：尝试获取健康节点，最多尝试所有健康节点
    const maxAttempts = this.healthyNodeTags.size;
    let nodeTagToUse = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.healthyNodeTags.size === 0) {
        worker.isBusy = false; // 释放工人
        throw new Error('已无健康节点可用');
      }

      // 获取下一个候选节点
      const candidateNode = this.getNextHealthyNode();

      this.logger.debug(`[LAZY CHECK] Testing node ${candidateNode} (attempt ${attempt + 1}/${maxAttempts})`);

      // 懒加载健康检查
      const isHealthy = await this.healthCheck(candidateNode);

      if (isHealthy) {
        // 节点健康，使用此节点
        nodeTagToUse = candidateNode;
        this.logger.debug(`[LAZY CHECK] Node ${candidateNode} passed health check`);
        break;
      } else {
        // 节点不健康，移入隔离池
        this.logger.warn(`[LAZY CHECK] Node ${candidateNode} failed health check, moving to quarantine`);
        this.moveNodeToQuarantine(candidateNode, 'Lazy health check failed');
      }
    }

    // 如果所有节点都不健康
    if (!nodeTagToUse) {
      worker.isBusy = false; // 释放工人
      throw new Error('所有健康节点都未通过懒加载健康检查');
    }

    // 指挥这个特定的工人去切换节点
    await this.commandSwitchNode(worker.selector, nodeTagToUse);

    worker.currentNode = nodeTagToUse;
    worker.requestCount++;
    this.stats.workerSwitches++;
    this.stats.lastWorkerSwitch = Date.now();

    this.updateStats();

    this.logger.debug(`Worker acquired with lazy health check`, {
      workerId: worker.id,
      port: worker.port,
      selector: worker.selector,
      assignedNode: nodeTagToUse
    });

    return { worker, nodeTag: nodeTagToUse };
  }

  /**
   * 归还一个工人
   * @param {Object} worker - 要归还的工人对象
   */
  releaseWorker(worker) {
    worker.isBusy = false;
    worker.assignedAt = null;

    this.updateStats();

    this.logger.debug(`Worker released`, {
      workerId: worker.id,
      port: worker.port,
      currentNode: worker.currentNode
    });
  }

  /**
   * 获取节点名称（现在节点名称已标准化，直接返回）
   * @param {string} nodeName - 节点名称
   * @returns {string} 节点名称
   */
  getNodeName(nodeName) {
    // 节点名称已经标准化，无需处理，直接返回
    return nodeName;
  }

  /**
   * 指挥特定工人切换节点
   * @param {string} selectorName - 工人选择器名称
   * @param {string} nodeTag - 目标节点标签（已修复的名称）
   */
  async commandSwitchNode(selectorName, nodeTag) {
    // 导入TTS日志器
    const { ttsLogger } = require('../../utils/ttsLogger');
    const contextLogger = ttsLogger.createContextLogger({});

    try {
      // 节点名称已标准化，直接使用
      const targetNodeName = this.getNodeName(nodeTag);

      this.logger.debug(`Commanding worker selector ${selectorName} to switch to node: ${targetNodeName}`);

      contextLogger.logNode('Worker node switch command', {
        selector: selectorName,
        targetNode: targetNodeName,
        originalNodeTag: nodeTag,
        apiType: 'clash',
        endpoint: `${this.config.SINGBOX_API_ENDPOINT}/proxies/${selectorName}`,
        requestBody: { name: targetNodeName }
      });

      // 使用Clash API格式进行节点切换，使用正确的节点名
      const success = await this.makeApiRequest('PUT', `/proxies/${selectorName}`, {
        name: targetNodeName
      });

      if (success) {
        contextLogger.logNode('Worker node switch successful', {
          selector: selectorName,
          newNode: targetNodeName,
          fixedNodeTag: nodeTag
        });

        this.logger.debug(`Worker selector ${selectorName} successfully switched to node: ${targetNodeName}`);
        return true;
      } else {
        throw new Error(`Failed to switch worker selector ${selectorName} to node ${targetNodeName}`);
      }

    } catch (error) {
      contextLogger.logError(error, 'worker-node-switch', {
        selector: selectorName,
        targetNode: nodeTag,
        originalTargetNode: this.findOriginalNodeName(nodeTag)
      });

      this.logger.error(`Failed to switch worker selector ${selectorName} to node ${nodeTag}`, error);
      throw error;
    }
  }

  /**
   * 从节点池中移除失效节点（保持向后兼容）
   * @param {string} nodeTag - 节点标签
   * @param {string} reason - 失败原因
   */
  removeNode(nodeTag, reason = 'Unknown error') {
    // 调用新的隔离池方法，保持向后兼容
    this.moveNodeToQuarantine(nodeTag, reason);
  }

  /**
   * 将节点移入隔离池
   * @param {string} nodeTag - 节点标签
   * @param {string} reason - 失败原因
   */
  moveNodeToQuarantine(nodeTag, reason = 'Unknown error') {
    this.logger.warn(`Moving failed node to quarantine: ${nodeTag}`, { reason });

    // 从健康池移除
    this.healthyNodeTags.delete(nodeTag);

    // 添加到隔离池（failedNodes作为隔离池）
    this.failedNodes.set(nodeTag, {
      reason,
      timestamp: Date.now(),
      retryCount: (this.failedNodes.get(nodeTag)?.retryCount || 0) + 1,
      quarantineType: this.determineQuarantineType(reason),
      lastHealthCheck: null,
      consecutiveFailures: (this.failedNodes.get(nodeTag)?.consecutiveFailures || 0) + 1,
      consecutiveSuccesses: 0
    });

    this.updateStats();

    // 异步保存隔离池数据（不阻塞主流程）
    this.saveQuarantineData().catch(error => {
      this.logger.warn('Failed to save quarantine data after node quarantine', error);
    });

    // 导入TTS日志器
    const { ttsLogger } = require('../../utils/ttsLogger');
    const contextLogger = ttsLogger.createContextLogger({});

    contextLogger.logNode('Node moved to quarantine', {
      nodeTag,
      reason,
      quarantineType: this.failedNodes.get(nodeTag).quarantineType,
      remainingHealthyNodes: this.healthyNodeTags.size,
      totalQuarantinedNodes: this.failedNodes.size
    });
  }

  /**
   * 确定隔离类型
   * @param {string} reason - 失败原因
   * @returns {string} 隔离类型：'permanent' 或 'temporary'
   */
  determineQuarantineType(reason) {
    const permanentReasons = [
      'quota_exceeded',
      'Too Many Requests',
      'HTTP 403',
      'HTTP 429',
      'Account suspended',
      'API key invalid'
    ];

    const lowerReason = reason.toLowerCase();
    const isPermanent = permanentReasons.some(pr =>
      lowerReason.includes(pr.toLowerCase())
    );

    return isPermanent ? 'permanent' : 'temporary';
  }

  /**
   * 加载持久化的隔离池数据
   */
  async loadQuarantineData() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const quarantineFile = path.join(__dirname, '../../../logs', 'quarantine-nodes.json');

      const data = await fs.readFile(quarantineFile, 'utf8');
      const quarantineData = JSON.parse(data);

      // 恢复隔离池数据
      for (const [nodeTag, nodeInfo] of Object.entries(quarantineData)) {
        if (this.allNodes.has(nodeTag)) {
          this.failedNodes.set(nodeTag, {
            ...nodeInfo,
            timestamp: nodeInfo.timestamp || Date.now(),
            quarantineType: nodeInfo.quarantineType || 'temporary',
            consecutiveFailures: nodeInfo.consecutiveFailures || 1,
            consecutiveSuccesses: nodeInfo.consecutiveSuccesses || 0,
            lastHealthCheck: nodeInfo.lastHealthCheck || null
          });

          // 从健康池移除
          this.healthyNodeTags.delete(nodeTag);
        }
      }

      this.logger.info(`Loaded quarantine data for ${Object.keys(quarantineData).length} nodes`);

    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn('Failed to load quarantine data', error);
      }
    }
  }

  /**
   * 保存隔离池数据到文件
   */
  async saveQuarantineData() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const quarantineFile = path.join(__dirname, '../../../logs', 'quarantine-nodes.json');

      // 确保目录存在
      await fs.mkdir(path.dirname(quarantineFile), { recursive: true });

      // 转换Map为普通对象
      const quarantineData = Object.fromEntries(this.failedNodes);

      await fs.writeFile(quarantineFile, JSON.stringify(quarantineData, null, 2));

      this.logger.debug(`Saved quarantine data for ${this.failedNodes.size} nodes`);

    } catch (error) {
      this.logger.error('Failed to save quarantine data', error);
    }
  }

  /**
   * 发起sing-box Clash API请求（支持UTF-8编码）
   */
  async makeApiRequest(method, path, data = null) {
    const url = `${this.config.SINGBOX_API_ENDPOINT}${path}`;

    const timeoutMs = this.config.SINGBOX_NODE_TIMEOUT || 15000;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json; charset=utf-8',
        'Accept-Charset': 'utf-8'
      },
      signal: abortController.signal
    };

    if (data) {
      // 确保JSON序列化时保持UTF-8编码
      options.body = JSON.stringify(data, null, 0);
    }

    try {
      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      if (!response.ok) {
        // 尝试获取错误响应内容
        let errorText = '';
        try {
          errorText = await response.text();
        } catch (e) {
          // 忽略读取错误内容的异常
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`);
      }

      // 确保响应以UTF-8编码解析
      const responseText = await response.text();

      // 如果响应为空，返回空对象而不是抛出异常
      if (!responseText.trim()) {
        this.logger.debug(`Empty response from ${method} ${path}`);
        return {};
      }

      try {
        const result = JSON.parse(responseText);
        return result;
      } catch (parseError) {
        this.logger.warn(`Failed to parse JSON response from ${method} ${path}`, {
          responseText: responseText.substring(0, 200),
          parseError: parseError.message
        });
        throw new Error(`Invalid JSON response: ${parseError.message}`);
      }

    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }

      throw error;
    }
  }

  /**
   * 更新统计信息
   */
  updateStats() {
    this.stats.totalNodes = this.allNodes.size;
    this.stats.healthyNodes = this.healthyNodeTags.size;
    this.stats.failedNodes = this.failedNodes.size;
    this.stats.busyWorkers = this.workers.filter(w => w.isBusy).length;
    this.stats.idleWorkers = this.workers.filter(w => !w.isBusy).length;
  }

  // ========== IProxyProvider接口实现 ==========

  /**
   * 获取可用代理节点列表
   */
  async getAvailableNodes() {
    return Array.from(this.healthyNodeTags);
  }

  /**
   * 获取当前使用的节点（返回所有工人的当前节点）
   */
  async getCurrentNode() {
    const busyWorkers = this.workers.filter(w => w.isBusy);
    if (busyWorkers.length === 0) {
      return null;
    }

    // 返回第一个忙碌工人的节点，或者可以返回所有忙碌工人的节点列表
    return busyWorkers[0].currentNode;
  }

  /**
   * 切换到指定节点（工作池模式下不直接支持，应使用acquireWorker）
   */
  async switchToNode(nodeId) {
    throw new Error('WorkerPoolController does not support direct node switching. Use acquireWorker() instead.');
  }

  /**
   * 标记节点为失败状态
   */
  async markNodeFailed(nodeId, reason = 'Unknown error') {
    this.removeNode(nodeId, reason);
  }

  /**
   * 恢复节点为健康状态（带连续成功检查逻辑）
   * @param {string} nodeId - 节点ID
   * @param {boolean} forceRestore - 是否强制恢复（跳过连续成功检查）
   */
  async markNodeHealthy(nodeId, forceRestore = false) {
    if (!this.allNodes.has(nodeId)) {
      this.logger.warn(`Cannot mark unknown node as healthy: ${nodeId}`);
      return false;
    }

    const quarantineInfo = this.failedNodes.get(nodeId);
    if (!quarantineInfo) {
      // 节点不在隔离池中，可能已经是健康的
      if (!this.healthyNodeTags.has(nodeId)) {
        this.healthyNodeTags.add(nodeId);
        this.updateStats();
      }
      return true;
    }

    // 检查是否为永久隔离节点
    if (quarantineInfo.quarantineType === 'permanent' && !forceRestore) {
      this.logger.debug(`Node ${nodeId} is permanently quarantined, skipping recovery`);
      return false;
    }

    // 更新连续成功次数
    quarantineInfo.consecutiveSuccesses = (quarantineInfo.consecutiveSuccesses || 0) + 1;
    quarantineInfo.consecutiveFailures = 0;
    quarantineInfo.lastHealthCheck = Date.now();

    // 检查是否满足恢复条件
    const requiredSuccesses = quarantineInfo.quarantineType === 'permanent' ? 3 : 2;
    const canRestore = forceRestore || quarantineInfo.consecutiveSuccesses >= requiredSuccesses;

    if (canRestore) {
      // 恢复节点到健康池
      this.healthyNodeTags.add(nodeId);
      this.failedNodes.delete(nodeId);
      this.updateStats();

      // 异步保存隔离池数据
      this.saveQuarantineData().catch(error => {
        this.logger.warn('Failed to save quarantine data after node recovery', error);
      });

      this.logger.info(`Node ${nodeId} restored to healthy pool`, {
        consecutiveSuccesses: quarantineInfo.consecutiveSuccesses,
        quarantineType: quarantineInfo.quarantineType,
        forceRestore
      });

      // 导入TTS日志器
      const { ttsLogger } = require('../../utils/ttsLogger');
      const contextLogger = ttsLogger.createContextLogger({});

      contextLogger.logNode('Node restored to healthy pool', {
        nodeTag: nodeId,
        consecutiveSuccesses: quarantineInfo.consecutiveSuccesses,
        quarantineType: quarantineInfo.quarantineType,
        healthyNodes: this.healthyNodeTags.size,
        forceRestore
      });

      return true;
    } else {
      // 更新隔离池信息但不恢复
      this.failedNodes.set(nodeId, quarantineInfo);

      this.logger.debug(`Node ${nodeId} health check passed but needs more successes`, {
        consecutiveSuccesses: quarantineInfo.consecutiveSuccesses,
        requiredSuccesses,
        quarantineType: quarantineInfo.quarantineType
      });

      return false;
    }
  }

  /**
   * 获取节点健康状态
   */
  async isNodeHealthy(nodeId) {
    return this.healthyNodeTags.has(nodeId);
  }

  /**
   * 获取隔离池中的节点列表
   * @param {string} quarantineType - 隔离类型过滤：'temporary', 'permanent', 或 null（全部）
   * @returns {Array} 隔离节点列表
   */
  getQuarantinedNodes(quarantineType = null) {
    const quarantinedNodes = [];

    for (const [nodeTag, nodeInfo] of this.failedNodes.entries()) {
      if (!quarantineType || nodeInfo.quarantineType === quarantineType) {
        quarantinedNodes.push({
          nodeTag,
          ...nodeInfo
        });
      }
    }

    return quarantinedNodes;
  }

  /**
   * 获取隔离池统计信息
   */
  getQuarantineStats() {
    const stats = {
      total: this.failedNodes.size,
      temporary: 0,
      permanent: 0,
      oldestQuarantine: null,
      newestQuarantine: null
    };

    let oldestTime = Infinity;
    let newestTime = 0;

    for (const [nodeTag, nodeInfo] of this.failedNodes.entries()) {
      if (nodeInfo.quarantineType === 'temporary') {
        stats.temporary++;
      } else if (nodeInfo.quarantineType === 'permanent') {
        stats.permanent++;
      }

      if (nodeInfo.timestamp < oldestTime) {
        oldestTime = nodeInfo.timestamp;
        stats.oldestQuarantine = { nodeTag, timestamp: nodeInfo.timestamp };
      }

      if (nodeInfo.timestamp > newestTime) {
        newestTime = nodeInfo.timestamp;
        stats.newestQuarantine = { nodeTag, timestamp: nodeInfo.timestamp };
      }
    }

    return stats;
  }

  /**
   * 获取代理统计信息
   */
  async getStats() {
    return {
      ...this.stats,
      workerDetails: this.workers.map(worker => ({
        id: worker.id,
        port: worker.port,
        selector: worker.selector,
        isBusy: worker.isBusy,
        currentNode: worker.currentNode,
        assignedAt: worker.assignedAt,
        requestCount: worker.requestCount,
        successCount: worker.successCount,
        failureCount: worker.failureCount
      })),
      failedNodeDetails: Object.fromEntries(this.failedNodes),
      apiType: 'clash-worker-pool'
    };
  }

  /**
   * 获取工人池状态
   */
  getWorkerPoolStatus() {
    return {
      totalWorkers: this.workers.length,
      busyWorkers: this.stats.busyWorkers,
      idleWorkers: this.stats.idleWorkers,
      workers: this.workers.map(worker => ({
        id: worker.id,
        port: worker.port,
        selector: worker.selector,
        isBusy: worker.isBusy,
        currentNode: worker.currentNode,
        assignedAt: worker.assignedAt
      }))
    };
  }

  /**
   * 重新加载节点配置
   */
  async reload() {
    this.logger.info('Reloading WorkerPoolController...');

    try {
      await this.loadNodes();
      await this.validateWorkerSelectors();

      this.logger.info('WorkerPoolController reloaded successfully');
    } catch (error) {
      this.logger.error('Failed to reload WorkerPoolController', error);
      throw error;
    }
  }

  /**
   * 清理资源
   */
  async cleanup() {
    this.logger.info('Cleaning up WorkerPoolController...');

    // 释放所有忙碌的工人
    this.workers.forEach(worker => {
      if (worker.isBusy) {
        this.releaseWorker(worker);
      }
    });

    this.logger.info('WorkerPoolController cleanup completed');
  }
}

module.exports = { WorkerPoolController };
