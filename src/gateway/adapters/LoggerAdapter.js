/**
 * 日志适配器
 * 为代理网关提供统一的日志接口，适配现有日志系统
 */
class LoggerAdapter {
  constructor(module = 'GATEWAY') {
    this.module = module;
    this.logger = null;
    this.initialized = false;
  }
  
  /**
   * 初始化日志适配器
   */
  initialize() {
    if (this.initialized) return;
    
    try {
      // 使用现有的日志系统
      const { logger } = require('../../utils/logger');
      this.logger = logger;
      this.initialized = true;
    } catch (error) {
      // 降级到console日志
      console.warn('[LOGGER-ADAPTER] Failed to load logger, falling back to console:', error.message);
      this.logger = console;
      this.initialized = true;
    }
  }
  
  /**
   * 格式化日志消息
   */
  formatMessage(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const prefix = `[${this.module}]`;
    
    if (Object.keys(data).length > 0) {
      return `${prefix} ${message} ${JSON.stringify(data)}`;
    }
    return `${prefix} ${message}`;
  }
  
  /**
   * Debug级别日志
   */
  debug(message, data = {}) {
    if (!this.initialized) this.initialize();
    
    const formattedMessage = this.formatMessage('DEBUG', message, data);
    
    if (this.logger.debug) {
      this.logger.debug(formattedMessage);
    } else {
      console.debug(formattedMessage);
    }
  }
  
  /**
   * Info级别日志
   */
  info(message, data = {}) {
    if (!this.initialized) this.initialize();
    
    const formattedMessage = this.formatMessage('INFO', message, data);
    
    if (this.logger.info) {
      this.logger.info(formattedMessage);
    } else {
      console.info(formattedMessage);
    }
  }
  
  /**
   * Warning级别日志
   */
  warn(message, data = {}) {
    if (!this.initialized) this.initialize();
    
    const formattedMessage = this.formatMessage('WARN', message, data);
    
    if (this.logger.warn) {
      this.logger.warn(formattedMessage);
    } else {
      console.warn(formattedMessage);
    }
  }
  
  /**
   * Error级别日志
   */
  error(message, error = null, data = {}) {
    if (!this.initialized) this.initialize();
    
    let errorData = { ...data };
    if (error) {
      errorData.error = error.message;
      errorData.stack = error.stack?.substring(0, 500);
    }
    
    const formattedMessage = this.formatMessage('ERROR', message, errorData);
    
    if (this.logger.error && typeof this.logger.error === 'function') {
      // 如果logger.error接受Error对象
      if (error && this.logger.error.length > 1) {
        this.logger.error(error, { message: formattedMessage });
      } else {
        this.logger.error(formattedMessage);
      }
    } else {
      console.error(formattedMessage);
    }
  }
  
  /**
   * 性能日志
   */
  performance(operation, duration, data = {}) {
    const perfData = {
      operation,
      duration: `${duration}ms`,
      ...data
    };
    
    if (duration > 1000) {
      this.warn(`Slow operation detected: ${operation}`, perfData);
    } else {
      this.debug(`Performance: ${operation}`, perfData);
    }
  }
  
  /**
   * 网络请求日志
   */
  network(method, url, status, duration, data = {}) {
    const networkData = {
      method,
      url,
      status,
      duration: `${duration}ms`,
      ...data
    };
    
    if (status >= 400) {
      this.error(`Network request failed: ${method} ${url}`, null, networkData);
    } else if (duration > 5000) {
      this.warn(`Slow network request: ${method} ${url}`, networkData);
    } else {
      this.debug(`Network request: ${method} ${url}`, networkData);
    }
  }
  
  /**
   * 节点状态变化日志
   */
  nodeStatus(nodeId, oldStatus, newStatus, reason = '') {
    const statusData = {
      nodeId,
      oldStatus,
      newStatus,
      reason,
      timestamp: new Date().toISOString()
    };
    
    if (newStatus === 'failed') {
      this.warn(`Node marked as failed: ${nodeId}`, statusData);
    } else if (newStatus === 'healthy' && oldStatus === 'failed') {
      this.info(`Node recovered: ${nodeId}`, statusData);
    } else {
      this.debug(`Node status changed: ${nodeId}`, statusData);
    }
  }
  
  /**
   * 创建子模块日志器
   */
  createSubLogger(subModule) {
    return new LoggerAdapter(`${this.module}:${subModule}`);
  }
}

module.exports = { LoggerAdapter };
