// 生成基于年月日时分秒的文件名
function generateDateBasedFilename() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `tts_${year}${month}${day}_${hours}${minutes}${seconds}.mp3`;
}

// 获取下个月第一天的时间戳，用于月度重置
function getNextMonthResetTimestamp() {
  const now = new Date();
  // 设置为下个月的第一天的 0 点 0 分 0 秒
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.getTime();
}

// 检查管理员权限
async function checkAdminPermission(username) {
  // 从环境变量获取管理员列表，默认为空数组
  const adminList = process.env.ADMIN_USERS?.split(',').map(u => u.trim()).filter(u => u) || [];

  if (adminList.length === 0) {
    console.warn('[ADMIN-CHECK] No admin users configured in ADMIN_USERS environment variable');
    throw new Error('管理员功能未配置');
  }

  if (!adminList.includes(username)) {
    console.warn(`[ADMIN-CHECK] User ${username} attempted to access admin function`);
    throw new Error('需要管理员权限');
  }

  console.log(`[ADMIN-CHECK] Admin access granted for user: ${username}`);
}

// CORS头部配置
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// 处理 OPTIONS 请求
function handleOptions(request) {
  return {
    status: 200,
    headers: corsHeaders()
  };
}

// 统一的认证错误处理函数
function createAuthErrorResponse(error) {
  // 根据错误消息判断错误类型
  let errorCode = 'AUTH_ERROR';
  let errorMessage = error.message;

  if (error.message === 'Token expired') {
    errorCode = 'TOKEN_EXPIRED';
  } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
    errorCode = 'TOKEN_INVALID';
  } else if (error.message === 'Invalid token type') {
    errorCode = 'TOKEN_TYPE_INVALID';
  }

  return {
    status: 401,
    body: {
      error: errorMessage,
      code: errorCode // 新增错误码字段，便于前端统一处理
    },
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  };
}

// 判断是否为认证相关错误的辅助函数
function isAuthError(error) {
  return error.message === 'Token expired' ||
         error.message === 'Invalid token' ||
         error.message === 'Invalid signature' ||
         error.message === 'Invalid token type';
}

// 检测是否为内容违规错误（不可重试）
function isContentViolationError(status, errorData, errorMessage) {
  // 1. 必须是403状态码
  if (status !== 403) {
    return false;
  }

  // 2. 检查detail.status字段
  if (errorData?.detail?.status === 'content_against_policy') {
    return true;
  }

  // 3. 检查特定的违规消息
  const violationMessage = "We are sorry but text you are trying to use may violate our Terms of Service and has been blocked.";
  if (errorMessage && errorMessage.includes(violationMessage)) {
    return true;
  }

  // 4. 检查detail.message字段
  if (errorData?.detail?.message && errorData.detail.message.includes(violationMessage)) {
    return true;
  }

  // 5. 检查其他可能的违规关键词
  const violationKeywords = [
    "violate our Terms",
    "violates our Terms",
    "content_against_policy",
    "content policy violation",
    "terms of service",
    "policy violation"
  ];
  const lowerErrorMessage = errorMessage?.toLowerCase() || '';
  if (violationKeywords.some(keyword => lowerErrorMessage.includes(keyword.toLowerCase()))) {
    return true;
  }

  return false;
}

// 检测是否为数据中心级别的可重试错误
function isDataCenterRetryableError(error, status, originalErrorData = null) {
  // 优先检查是否为内容违规错误
  if (isContentViolationError(status, originalErrorData, error.message)) {
    return false; // 内容违规错误绝对不可重试
  }

  // 1. HTTP 429 (Too Many Requests) - 明确的配额限制
  if (status === 429) {
    return true;
  }

  // 2. HTTP 503 (Service Unavailable) - 服务暂时不可用
  if (status === 503) {
    return true;
  }

  // 3. HTTP 401 配额相关错误
  if (status === 401) {
    // 检查是否是配额相关的401错误
    if (originalErrorData?.detail?.status === 'quota_exceeded') {
      return true;
    }
  }

  // 4. 检查错误消息中的关键词
  const errorMessage = error.message?.toLowerCase() || '';
  const retryableKeywords = [
    'quota',
    'quota_exceeded',
    'rate limit',
    'too many requests',
    'service unavailable',
    'temporarily unavailable',
    'capacity',
    'overloaded',
    'reached the limit'
  ];

  const isRetryableByMessage = retryableKeywords.some(keyword =>
    errorMessage.includes(keyword)
  );

  if (isRetryableByMessage) {
    return true;
  }

  // 5. 检查原始错误数据中的状态字段
  if (originalErrorData?.detail?.status) {
    const detailStatus = originalErrorData.detail.status.toLowerCase();
    const retryableStatuses = ['quota_exceeded', 'rate_limited', 'capacity_exceeded'];
    if (retryableStatuses.includes(detailStatus)) {
      return true;
    }
  }

  // 6. 网络级别错误（可能是数据中心网络问题）
  if (error.name === 'TypeError' && errorMessage.includes('fetch')) {
    return true;
  }

  // 7. 超时错误
  if (errorMessage.includes('timeout') || errorMessage.includes('timed out')) {
    return true;
  }

  return false;
}

// 格式化错误响应
function formatErrorResponse(error, status = 500) {
  return {
    status,
    body: {
      error: error.message || 'Internal server error',
      timestamp: new Date().toISOString()
    },
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  };
}

module.exports = {
  generateDateBasedFilename,
  getNextMonthResetTimestamp,
  checkAdminPermission,
  corsHeaders,
  handleOptions,
  createAuthErrorResponse,
  isAuthError,
  isContentViolationError,
  isDataCenterRetryableError,
  formatErrorResponse
};
