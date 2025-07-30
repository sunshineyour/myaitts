/**
 * 错误安全处理工具
 * 防止敏感信息泄露，提供用户友好的错误消息
 */

// 安全的错误消息白名单
const SAFE_ERROR_MESSAGES = {
  // 认证相关
  'TOKEN_EXPIRED': '登录会话已过期，请重新登录',
  'TOKEN_INVALID': '登录信息无效，请重新登录',
  'TOKEN_TYPE_INVALID': '登录类型错误，请重新登录',
  'AUTH_ERROR': '认证失败，请重新登录',
  'UNAUTHORIZED': '未授权访问，请先登录',
  'FORBIDDEN': '权限不足，无法执行此操作',
  
  // 业务相关
  'VALIDATION_ERROR': '输入数据格式不正确，请检查后重试',
  'REQUEST_TOO_LARGE': '请求数据过大，请减少内容后重试',
  'INVALID_JSON': '数据格式错误，请检查输入内容',
  'NOT_FOUND': '请求的资源不存在',
  'CONFLICT': '操作冲突，请稍后重试',
  'RATE_LIMIT_EXCEEDED': '请求过于频繁，请稍后再试',
  
  // 内容相关
  'CONTENT_VIOLATION': '内容可能违反服务条款，请修改后重试',
  'QUOTA_EXCEEDED': '配额已用完，请充值后继续使用',
  
  // 系统相关
  'SYSTEM_ERROR': '系统暂时繁忙，请稍后再试',
  'NETWORK_ERROR': '网络连接异常，请检查网络后重试',
  'SERVICE_UNAVAILABLE': '服务暂时不可用，请稍后再试',
  'TIMEOUT_ERROR': '请求超时，请稍后重试'
};

// 敏感信息检测模式
const SENSITIVE_PATTERNS = [
  // 文件路径
  /[A-Za-z]:\\[\w\\.-]+/g,                    // Windows路径
  /\/[\w\/.-]+\.(js|ts|json|sql|env)/g,       // Unix路径和文件
  
  // 数据库相关
  /table\s+["']?\w+["']?/gi,                  // 表名
  /column\s+["']?\w+["']?/gi,                 // 列名
  /constraint\s+["']?\w+["']?/gi,             // 约束名
  /duplicate\s+entry/gi,                      // 重复条目
  /foreign\s+key/gi,                          // 外键
  
  // API和网络
  /https?:\/\/[\w.-]+\/[\w\/.-]*/g,           // 完整URL
  /api[_-]?key/gi,                           // API密钥
  /secret/gi,                                // 密钥
  /token/gi,                                 // 令牌
  
  // 系统信息
  /node_modules/gi,                          // Node模块路径
  /at\s+[\w.]+\s+\(/g,                       // 堆栈跟踪
  /error:\s*\w+error/gi,                     // 错误类型
  /errno\s*:\s*\d+/gi,                       // 错误码
  
  // IP和端口
  /\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g,        // IP:端口
  /localhost:\d+/g,                          // 本地端口
];

// 错误类型分类
const ERROR_CATEGORIES = {
  // 用户错误 - 可以显示具体信息
  USER_ERRORS: [
    'ValidationError',
    'VALIDATION_ERROR',
    'REQUEST_TOO_LARGE',
    'INVALID_JSON',
    'CONTENT_VIOLATION',
    'QUOTA_EXCEEDED'
  ],
  
  // 认证错误 - 显示标准认证消息
  AUTH_ERRORS: [
    'UnauthorizedError',
    'TOKEN_EXPIRED',
    'TOKEN_INVALID',
    'TOKEN_TYPE_INVALID',
    'AUTH_ERROR',
    'UNAUTHORIZED',
    'FORBIDDEN'
  ],
  
  // 系统错误 - 隐藏详细信息
  SYSTEM_ERRORS: [
    'DatabaseError',
    'NetworkError',
    'TimeoutError',
    'InternalError',
    'SYSTEM_ERROR',
    'SERVICE_UNAVAILABLE'
  ]
};

/**
 * 检测错误消息中的敏感信息
 * @param {string} message - 错误消息
 * @returns {boolean} 是否包含敏感信息
 */
function containsSensitiveInfo(message) {
  if (!message || typeof message !== 'string') {
    return false;
  }
  
  return SENSITIVE_PATTERNS.some(pattern => pattern.test(message));
}

/**
 * 清理错误消息中的敏感信息
 * @param {string} message - 原始错误消息
 * @returns {string} 清理后的错误消息
 */
function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') {
    return '系统错误';
  }
  
  let sanitized = message;
  
  // 替换敏感信息
  SENSITIVE_PATTERNS.forEach(pattern => {
    sanitized = sanitized.replace(pattern, '[已隐藏]');
  });
  
  return sanitized;
}

/**
 * 获取错误类别
 * @param {Error|string} error - 错误对象或错误类型
 * @returns {string} 错误类别
 */
function getErrorCategory(error) {
  const errorType = typeof error === 'string' ? error : (error.name || error.code || 'Unknown');
  
  if (ERROR_CATEGORIES.USER_ERRORS.includes(errorType)) {
    return 'USER';
  }
  
  if (ERROR_CATEGORIES.AUTH_ERRORS.includes(errorType)) {
    return 'AUTH';
  }
  
  return 'SYSTEM';
}

/**
 * 生成安全的错误响应
 * @param {Error} error - 原始错误对象
 * @param {Object} options - 选项
 * @param {boolean} options.includeCode - 是否包含错误码
 * @param {boolean} options.isDevelopment - 是否为开发环境
 * @returns {Object} 安全的错误响应
 */
function createSafeErrorResponse(error, options = {}) {
  const { includeCode = true, isDevelopment = false } = options;
  
  // 基本错误信息
  const errorType = error.name || error.code || 'INTERNAL_ERROR';
  const originalMessage = error.message || '未知错误';
  const category = getErrorCategory(error);
  
  // 生成安全的错误消息
  let safeMessage;
  let errorCode = errorType;
  
  // 根据错误类别处理
  switch (category) {
    case 'USER':
      // 用户错误：检查是否包含敏感信息
      if (containsSensitiveInfo(originalMessage)) {
        safeMessage = SAFE_ERROR_MESSAGES[errorType] || '输入数据有误，请检查后重试';
      } else {
        safeMessage = originalMessage;
      }
      break;
      
    case 'AUTH':
      // 认证错误：使用标准认证消息
      safeMessage = SAFE_ERROR_MESSAGES[errorType] || SAFE_ERROR_MESSAGES.AUTH_ERROR;
      break;
      
    case 'SYSTEM':
    default:
      // 系统错误：使用通用消息
      safeMessage = SAFE_ERROR_MESSAGES[errorType] || SAFE_ERROR_MESSAGES.SYSTEM_ERROR;
      errorCode = 'INTERNAL_ERROR';
      break;
  }
  
  // 构建响应对象
  const response = {
    error: safeMessage,
    timestamp: new Date().toISOString()
  };
  
  if (includeCode) {
    response.code = errorCode;
  }
  
  // 开发环境额外信息
  if (isDevelopment) {
    response.debug = {
      originalError: originalMessage,
      errorType: errorType,
      category: category,
      hasSensitiveInfo: containsSensitiveInfo(originalMessage)
    };
    
    // 只在开发环境且非敏感错误时包含堆栈
    if (!containsSensitiveInfo(error.stack || '')) {
      response.debug.stack = error.stack;
    }
  }
  
  return response;
}

module.exports = {
  SAFE_ERROR_MESSAGES,
  ERROR_CATEGORIES,
  containsSensitiveInfo,
  sanitizeErrorMessage,
  getErrorCategory,
  createSafeErrorResponse
};
