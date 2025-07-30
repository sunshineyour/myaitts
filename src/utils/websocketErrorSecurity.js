/**
 * WebSocket错误安全处理工具
 * 专门处理WebSocket通信中的错误消息安全化
 */

const { containsSensitiveInfo, sanitizeErrorMessage, getErrorCategory } = require('./errorSecurity');

// WebSocket错误类型映射
const WEBSOCKET_ERROR_MESSAGES = {
  // 认证相关
  'authentication_failed': '登录会话已过期，请重新登录',
  'token_expired': '登录会话已过期，请重新登录',
  'token_invalid': '登录信息无效，请重新登录',
  'unauthorized': '未授权访问，请先登录',
  
  // 内容相关
  'content_violation': '内容可能违反服务条款，请修改后重试',
  'quota_exceeded': '配额已用完，请充值后继续使用',
  'rate_limit_exceeded': '请求过于频繁，请稍后再试',
  
  // 系统相关
  'system_error': '系统暂时繁忙，请稍后再试',
  'network_error': '网络连接异常，请检查网络后重试',
  'service_unavailable': '服务暂时不可用，请稍后再试',
  'timeout_error': '请求超时，请稍后重试',
  'processing_failed': '处理失败，请稍后重试',
  
  // 任务相关
  'task_failed': '任务处理失败，请重新尝试',
  'invalid_input': '输入参数无效，请检查后重试',
  'invalid_format': '数据格式错误，请检查输入内容',
  
  // 通用错误
  'unknown_error': '发生未知错误，请稍后重试',
  'internal_error': '系统内部错误，请联系客服'
};

// 错误类型到errorType的映射
const ERROR_TYPE_MAPPING = {
  // 认证错误
  'Token expired': 'authentication_failed',
  'Invalid token': 'authentication_failed',
  'Authentication failed': 'authentication_failed',
  'Unauthorized': 'unauthorized',
  
  // 内容违规
  'content violation': 'content_violation',
  'violates': 'content_violation',
  '违反': 'content_violation',
  '屏蔽': 'content_violation',
  
  // 配额相关
  'quota': 'quota_exceeded',
  '配额': 'quota_exceeded',
  '会员': 'quota_exceeded',
  '权限': 'quota_exceeded',
  
  // 网络相关
  'network': 'network_error',
  'timeout': 'timeout_error',
  'connection': 'network_error',
  'fetch': 'network_error',
  
  // 系统相关
  'database': 'system_error',
  'redis': 'system_error',
  'internal': 'internal_error'
};

/**
 * 检测错误类型
 * @param {string} message - 错误消息
 * @param {string} existingErrorType - 已有的错误类型
 * @returns {string} 检测到的错误类型
 */
function detectErrorType(message, existingErrorType) {
  if (existingErrorType) {
    return existingErrorType;
  }
  
  if (!message || typeof message !== 'string') {
    return 'unknown_error';
  }
  
  const lowerMessage = message.toLowerCase();
  
  // 检查错误类型映射
  for (const [keyword, errorType] of Object.entries(ERROR_TYPE_MAPPING)) {
    if (lowerMessage.includes(keyword.toLowerCase())) {
      return errorType;
    }
  }
  
  return 'unknown_error';
}

/**
 * 判断是否为可重试错误
 * @param {string} errorType - 错误类型
 * @param {string} message - 错误消息
 * @returns {boolean} 是否可重试
 */
function isRetryableError(errorType, message) {
  const retryableTypes = [
    'system_error',
    'network_error',
    'timeout_error',
    'service_unavailable',
    'rate_limit_exceeded'
  ];
  
  if (retryableTypes.includes(errorType)) {
    return true;
  }
  
  // 检查消息中的可重试关键词
  if (message && typeof message === 'string') {
    const retryableKeywords = [
      'timeout', 'network', 'connection', 'temporary', 
      'temporarily', 'busy', 'overload', 'retry'
    ];
    
    const lowerMessage = message.toLowerCase();
    return retryableKeywords.some(keyword => lowerMessage.includes(keyword));
  }
  
  return false;
}

/**
 * 创建安全的WebSocket错误响应
 * @param {Error|Object} error - 错误对象
 * @param {Object} options - 选项
 * @param {boolean} options.preserveContentViolation - 是否保留内容违规的原始消息
 * @param {boolean} options.isDevelopment - 是否为开发环境
 * @returns {Object} 安全的WebSocket错误响应
 */
function createSafeWebSocketError(error, options = {}) {
  const { preserveContentViolation = true, isDevelopment = false } = options;
  
  // 提取错误信息
  const originalMessage = error.message || error.error || '未知错误';
  const existingErrorType = error.errorType || null;
  const isRetryable = error.isRetryable;
  
  // 检测错误类型
  const errorType = detectErrorType(originalMessage, existingErrorType);
  
  // 生成安全的错误消息
  let safeMessage;
  
  // 特殊处理内容违规错误
  if (errorType === 'content_violation' && preserveContentViolation) {
    // 内容违规错误保留原始消息（通常来自第三方服务，用户需要知道具体原因）
    safeMessage = originalMessage;
  } else if (containsSensitiveInfo(originalMessage)) {
    // 包含敏感信息，使用安全消息
    safeMessage = WEBSOCKET_ERROR_MESSAGES[errorType] || WEBSOCKET_ERROR_MESSAGES.unknown_error;
  } else {
    // 检查是否为已知的安全消息类型
    const category = getErrorCategory(error);
    if (category === 'USER' || category === 'AUTH') {
      // 用户错误和认证错误可以显示原始消息
      safeMessage = originalMessage;
    } else {
      // 系统错误使用安全消息
      safeMessage = WEBSOCKET_ERROR_MESSAGES[errorType] || WEBSOCKET_ERROR_MESSAGES.unknown_error;
    }
  }
  
  // 构建响应对象
  const response = {
    type: 'error',
    message: safeMessage,
    errorType: errorType
  };
  
  // 添加重试信息
  if (isRetryable !== undefined) {
    response.isRetryable = isRetryable;
  } else {
    response.isRetryable = isRetryableError(errorType, originalMessage);
  }
  
  // 开发环境调试信息
  if (isDevelopment) {
    response.debug = {
      originalMessage: originalMessage,
      detectedErrorType: errorType,
      hasSensitiveInfo: containsSensitiveInfo(originalMessage),
      category: getErrorCategory(error)
    };
  }
  
  return response;
}

/**
 * 创建安全的任务失败响应
 * @param {Error} error - 错误对象
 * @param {string} taskId - 任务ID
 * @param {Object} options - 选项
 * @returns {Object} 安全的任务失败响应
 */
function createSafeTaskFailure(error, taskId, options = {}) {
  const safeError = createSafeWebSocketError(error, options);
  
  return {
    ...safeError,
    taskId: taskId,
    timestamp: new Date().toISOString(),
    status: 'failed'
  };
}

/**
 * 创建安全的认证失败响应
 * @param {Error} error - 认证错误
 * @param {Object} options - 选项
 * @returns {Object} 安全的认证失败响应
 */
function createSafeAuthFailure(error, options = {}) {
  return {
    type: 'error',
    message: WEBSOCKET_ERROR_MESSAGES.authentication_failed,
    errorType: 'authentication_failed',
    isRetryable: false,
    shouldRedirect: true
  };
}

module.exports = {
  WEBSOCKET_ERROR_MESSAGES,
  ERROR_TYPE_MAPPING,
  detectErrorType,
  isRetryableError,
  createSafeWebSocketError,
  createSafeTaskFailure,
  createSafeAuthFailure
};
