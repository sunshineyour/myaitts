const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

class Logger {
  constructor() {
    this.logDir = process.env.LOG_DIR || './logs';
    this.ensureLogDir();

    // 日志轮转配置
    this.maxFileSize = this.parseSize(process.env.LOG_MAX_FILE_SIZE || '50MB');
    this.maxFiles = parseInt(process.env.LOG_MAX_FILES || '30');
    this.enableCompression = process.env.LOG_ENABLE_COMPRESSION !== 'false';
    this.cleanupInterval = parseInt(process.env.LOG_CLEANUP_INTERVAL || '86400000'); // 24小时

    // 启动定期清理
    this.startCleanupTimer();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 解析文件大小字符串 (如 "50MB", "1GB")
   */
  parseSize(sizeStr) {
    const units = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024
    };

    const match = sizeStr.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)$/i);
    if (!match) {
      console.warn(`Invalid size format: ${sizeStr}, using default 50MB`);
      return 50 * 1024 * 1024; // 默认50MB
    }

    const [, size, unit] = match;
    return parseFloat(size) * units[unit.toUpperCase()];
  }

  /**
   * 启动定期清理定时器
   */
  startCleanupTimer() {
    // 避免重复启动定时器
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupOldLogs();
    }, this.cleanupInterval);

    // 立即执行一次清理
    setTimeout(() => this.cleanupOldLogs(), 5000);
  }

  formatMessage(level, message, data = {}, context = {}) {
    const timestamp = new Date().toISOString();
    const username = context.username || 'system';
    const taskId = context.taskId || 'N/A';

    let contextParts = `[user:${username}] [task:${taskId}]`;
    if (context.chunkIndex) {
      contextParts += ` [chunk:${context.chunkIndex}]`;
    }

    const logString = `[${level}] [${timestamp}] ${contextParts} - ${message}`;

    if (Object.keys(data).length > 0) {
      return `${logString} ${JSON.stringify(data)}`;
    }
    return logString;
  }

  log(level, message, data = {}, context = {}) {
    // 只有在DEBUG模式下才输出DEBUG级别的日志
    if (level === 'DEBUG' && !(process.env.DEBUG === 'true' || process.env.DEBUG === true)) {
      return;
    }

    const formattedMessage = this.formatMessage(level, message, data, context);
    
    // 输出到控制台
    console.log(formattedMessage);

    // 写入日志文件
    this.writeToFile(level, formattedMessage);
  }

  writeToFile(level, message) {
    try {
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const logFile = path.join(this.logDir, `${date}.log`);

      // 检查文件大小，如果超过限制则进行轮转
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size >= this.maxFileSize) {
          this.rotateLogFile(logFile, date);
        }
      }

      fs.appendFileSync(logFile, message + '\n');
    } catch (error) {
      console.error('Failed to write log to file:', error);
    }
  }

  debug(message, data = {}, context = {}) {
    this.log('DEBUG', message, data, context);
  }

  info(message, data = {}, context = {}) {
    this.log('INFO', message, data, context);
  }

  warn(message, data = {}, context = {}) {
    this.log('WARN', message, data, context);
  }

  error(error, context = {}, additionalData = {}) {
    const message = error.message || 'Unknown error';
    const data = {
      ...additionalData,
      error: message,
      stack: error.stack?.substring(0, 500) // 限制堆栈长度
    };
    this.log('ERROR', message, data, context);
  }

  /**
   * 轮转日志文件
   */
  rotateLogFile(logFile) {
    try {
      const baseName = path.basename(logFile, '.log');
      const logDir = path.dirname(logFile);

      // 查找现有的轮转文件，确定下一个序号
      let rotateIndex = 1;
      while (fs.existsSync(path.join(logDir, `${baseName}.log.${rotateIndex}`))) {
        rotateIndex++;
      }

      const rotatedFile = path.join(logDir, `${baseName}.log.${rotateIndex}`);

      // 移动当前日志文件
      fs.renameSync(logFile, rotatedFile);

      // 如果启用压缩，压缩轮转的文件
      if (this.enableCompression) {
        this.compressLogFile(rotatedFile);
      }

      console.log(`[LOGGER] Log file rotated: ${logFile} -> ${rotatedFile}`);
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }

  /**
   * 压缩日志文件
   */
  compressLogFile(filePath) {
    try {
      const compressedPath = `${filePath}.gz`;
      const readStream = fs.createReadStream(filePath);
      const writeStream = fs.createWriteStream(compressedPath);
      const gzip = zlib.createGzip();

      readStream.pipe(gzip).pipe(writeStream);

      writeStream.on('finish', () => {
        // 压缩完成后删除原文件
        fs.unlinkSync(filePath);
        console.log(`[LOGGER] Log file compressed: ${compressedPath}`);
      });

      writeStream.on('error', (error) => {
        console.error('Failed to compress log file:', error);
      });
    } catch (error) {
      console.error('Failed to compress log file:', error);
    }
  }

  /**
   * 清理旧的日志文件
   */
  cleanupOldLogs() {
    try {
      const files = fs.readdirSync(this.logDir);
      const logFiles = files.filter(file =>
        file.match(/^\d{4}-\d{2}-\d{2}\.log(\.\d+)?(\.gz)?$/)
      );

      // 按文件名排序（日期 + 序号）
      logFiles.sort((a, b) => {
        const aMatch = a.match(/^(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?/);
        const bMatch = b.match(/^(\d{4}-\d{2}-\d{2})\.log(?:\.(\d+))?/);

        if (aMatch[1] !== bMatch[1]) {
          return aMatch[1].localeCompare(bMatch[1]);
        }

        const aIndex = parseInt(aMatch[2] || '0');
        const bIndex = parseInt(bMatch[2] || '0');
        return aIndex - bIndex;
      });

      // 保留最新的文件，删除超出限制的文件
      if (logFiles.length > this.maxFiles) {
        const filesToDelete = logFiles.slice(0, logFiles.length - this.maxFiles);

        for (const file of filesToDelete) {
          const filePath = path.join(this.logDir, file);
          fs.unlinkSync(filePath);
          console.log(`[LOGGER] Cleaned up old log file: ${file}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  /**
   * 销毁Logger实例，清理定时器
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// 创建全局logger实例
const logger = new Logger();

// 增强环境对象的日志功能
function enhanceEnvWithLogging(env, logContext = {}) {
  // 在env中注入日志相关属性
  env._logContext = logContext;
  env._logger = logger;

  // 提供便捷的日志方法，自动使用上下文
  env._log = {
    debug: (message, data = {}) => logger.debug(message, data, env._logContext),
    info: (message, data = {}) => logger.info(message, data, env._logContext),
    warn: (message, data = {}) => logger.warn(message, data, env._logContext),
    error: (error, additionalData = {}) => logger.error(error, env._logContext, additionalData)
  };

  return env;
}

module.exports = {
  logger,
  enhanceEnvWithLogging
};
