const { logger } = require('../utils/logger');
const { createSafeErrorResponse } = require('../utils/errorSecurity');

// 错误处理中间件
function errorHandler(err, req, res, next) {
  // 记录错误日志（包含完整错误信息用于调试）
  logger.error(err, {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    errorName: err.name,
    errorCode: err.code
  });

  // 确定HTTP状态码
  let status = 500;

  // 根据错误类型设置状态码
  if (err.name === 'ValidationError') {
    status = 400;
    err.code = 'VALIDATION_ERROR';
  } else if (err.name === 'UnauthorizedError' || err.message.includes('Token')) {
    status = 401;
    err.code = 'UNAUTHORIZED';
  } else if (err.name === 'ForbiddenError' || err.message.includes('权限')) {
    status = 403;
    err.code = 'FORBIDDEN';
  } else if (err.name === 'NotFoundError') {
    status = 404;
    err.code = 'NOT_FOUND';
  } else if (err.name === 'ConflictError') {
    status = 409;
    err.code = 'CONFLICT';
  } else if (err.name === 'TooManyRequestsError') {
    status = 429;
    err.code = 'RATE_LIMIT_EXCEEDED';
  } else {
    // 默认为内部错误
    err.code = err.code || 'INTERNAL_ERROR';
  }

  // 使用安全错误处理生成响应
  const isDevelopment = process.env.NODE_ENV === 'development';
  const safeResponse = createSafeErrorResponse(err, {
    includeCode: true,
    isDevelopment: isDevelopment
  });

  res.status(status).json(safeResponse);
}

// 异步错误包装器
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// 404处理中间件
function notFoundHandler(req, res, next) {
  const error = new Error(`Route ${req.originalUrl} not found`);
  error.name = 'NotFoundError';
  next(error);
}

module.exports = {
  errorHandler,
  asyncHandler,
  notFoundHandler
};
