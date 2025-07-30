/**
 * TTS路径追踪日志工具
 * 提供统一的TTS生成路径日志记录功能，支持环境变量控制
 */

const { logger } = require('./logger');

/**
 * TTS路径追踪日志器
 */
class TTSRouteLogger {
  constructor() {
    // 从环境变量读取配置
    this.enabled = process.env.ENABLE_TTS_ROUTE_LOGGING === 'true';
    this.logLevel = process.env.TTS_ROUTE_LOG_LEVEL || 'detailed'; // basic, detailed, verbose
    this.gatewayNodeLogging = process.env.ENABLE_GATEWAY_NODE_LOGGING === 'true';
    this.networkRequestLogging = process.env.ENABLE_NETWORK_REQUEST_LOGGING === 'true';
    
    // 日志标识符
    this.tags = {
      ROUTE: '[TTS-ROUTE]',
      GATEWAY: '[TTS-GATEWAY]',
      PROXY: '[TTS-PROXY]',
      DIRECT: '[TTS-DIRECT]',
      NODE: '[TTS-NODE]',
      SUCCESS: '[TTS-SUCCESS]',
      FALLBACK: '[TTS-FALLBACK]',
      ERROR: '[TTS-ERROR]',
      NETWORK: '[TTS-NETWORK]'
    };
  }

  /**
   * 检查是否应该记录日志
   */
  shouldLog(level = 'basic') {
    if (!this.enabled) return false;
    
    const levels = ['basic', 'detailed', 'verbose'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const requestedLevelIndex = levels.indexOf(level);
    
    return requestedLevelIndex <= currentLevelIndex;
  }

  /**
   * 格式化日志消息
   */
  formatMessage(tag, message, data = {}) {
    const baseMessage = `${tag} ${message}`;
    
    if (Object.keys(data).length > 0) {
      // 过滤敏感信息
      const filteredData = this.filterSensitiveData(data);
      return `${baseMessage} ${JSON.stringify(filteredData)}`;
    }
    
    return baseMessage;
  }

  /**
   * 过滤敏感信息
   */
  filterSensitiveData(data) {
    const filtered = { ...data };
    
    // 移除或脱敏敏感字段
    if (filtered.secret) filtered.secret = '***';
    if (filtered.token) filtered.token = '***';
    if (filtered.apiKey) filtered.apiKey = '***';
    if (filtered.body && typeof filtered.body === 'string' && filtered.body.length > 200) {
      filtered.body = filtered.body.substring(0, 200) + '...';
    }
    
    return filtered;
  }

  /**
   * 记录路由决策日志
   */
  logRoute(decision, config = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      decision,
      networkMode: config.NETWORK_MODE,
      gatewayEnabled: config.ENABLE_SINGBOX_GATEWAY,
      textLength: context.textLength,
      voiceId: context.voiceId,
      modelId: context.modelId
    };
    
    const message = this.formatMessage(
      this.tags.ROUTE,
      `Route decision: ${decision}`,
      this.shouldLog('detailed') ? data : { decision, networkMode: config.NETWORK_MODE }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录网关模式日志
   */
  logGateway(action, details = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      action,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.GATEWAY,
      action,
      this.shouldLog('detailed') ? data : { action }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录代理模式日志
   */
  logProxy(action, details = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      action,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.PROXY,
      action,
      this.shouldLog('detailed') ? data : { action }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录直连模式日志
   */
  logDirect(action, details = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      action,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.DIRECT,
      action,
      this.shouldLog('detailed') ? data : { action }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录节点相关日志
   */
  logNode(action, details = {}, context = {}) {
    if (!this.gatewayNodeLogging || !this.shouldLog('basic')) return;
    
    const data = {
      action,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.NODE,
      action,
      this.shouldLog('detailed') ? data : { action, nodeId: details.nodeId }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录网络请求日志
   */
  logNetwork(method, url, status, duration, details = {}, context = {}) {
    if (!this.networkRequestLogging || !this.shouldLog('detailed')) return;
    
    const data = {
      method,
      url: this.sanitizeUrl(url),
      status,
      duration: `${duration}ms`,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.NETWORK,
      `${method} ${this.sanitizeUrl(url)}`,
      data
    );
    
    if (status >= 400) {
      logger.warn(message, {}, context.logContext || {});
    } else {
      logger.info(message, {}, context.logContext || {});
    }
  }

  /**
   * 记录成功日志
   */
  logSuccess(mode, details = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      mode,
      audioSize: details.audioSize,
      duration: details.duration,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.SUCCESS,
      `Generated via ${mode}`,
      this.shouldLog('detailed') ? data : { mode, audioSize: details.audioSize }
    );
    
    logger.info(message, {}, context.logContext || {});
  }

  /**
   * 记录降级日志
   */
  logFallback(from, to, reason, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      from,
      to,
      reason
    };
    
    const message = this.formatMessage(
      this.tags.FALLBACK,
      `Fallback from ${from} to ${to}`,
      data
    );
    
    logger.warn(message, {}, context.logContext || {});
  }

  /**
   * 记录错误日志
   */
  logError(error, mode, details = {}, context = {}) {
    if (!this.shouldLog('basic')) return;
    
    const data = {
      mode,
      error: error.message,
      ...details
    };
    
    const message = this.formatMessage(
      this.tags.ERROR,
      `Failed in ${mode} mode`,
      data
    );
    
    logger.error(new Error(message), context.logContext || {}, data);
  }

  /**
   * 清理URL中的敏感信息
   */
  sanitizeUrl(url) {
    if (!url) return url;
    
    // 移除查询参数中的敏感信息
    try {
      const urlObj = new URL(url);
      // 保留基本路径，移除可能的敏感查询参数
      return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
    } catch (e) {
      return url;
    }
  }

  /**
   * 创建带上下文的日志器
   */
  createContextLogger(context) {
    return {
      logRoute: (decision, config) => this.logRoute(decision, config, context),
      logGateway: (action, details) => this.logGateway(action, details, context),
      logProxy: (action, details) => this.logProxy(action, details, context),
      logDirect: (action, details) => this.logDirect(action, details, context),
      logNode: (action, details) => this.logNode(action, details, context),
      logNetwork: (method, url, status, duration, details) => 
        this.logNetwork(method, url, status, duration, details, context),
      logSuccess: (mode, details) => this.logSuccess(mode, details, context),
      logFallback: (from, to, reason) => this.logFallback(from, to, reason, context),
      logError: (error, mode, details) => this.logError(error, mode, details, context)
    };
  }
}

// 创建全局实例
const ttsLogger = new TTSRouteLogger();

module.exports = {
  TTSRouteLogger,
  ttsLogger
};
