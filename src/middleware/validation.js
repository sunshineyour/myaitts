const { validateRequestSize } = require('../utils/validators');

// 请求体大小验证中间件
function requestSizeMiddleware(maxSizeBytes = 10 * 1024 * 1024) {
  return (req, res, next) => {
    if (req.body) {
      const validation = validateRequestSize(req.body, maxSizeBytes);
      if (!validation.isValid) {
        return res.status(413).json({
          error: validation.error,
          code: 'REQUEST_TOO_LARGE'
        });
      }
    }
    next();
  };
}

// JSON解析错误处理中间件
function jsonErrorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Invalid JSON format',
      code: 'INVALID_JSON'
    });
  }
  next(err);
}

// 内容类型验证中间件
function contentTypeMiddleware(allowedTypes = ['application/json']) {
  return (req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const contentType = req.get('Content-Type');
      
      if (!contentType) {
        return res.status(400).json({
          error: 'Content-Type header is required',
          code: 'CONTENT_TYPE_REQUIRED'
        });
      }

      const isValidType = allowedTypes.some(type => 
        contentType.toLowerCase().includes(type.toLowerCase())
      );

      if (!isValidType) {
        return res.status(415).json({
          error: `Unsupported content type. Allowed types: ${allowedTypes.join(', ')}`,
          code: 'UNSUPPORTED_CONTENT_TYPE'
        });
      }
    }
    next();
  };
}

// 字段验证中间件工厂
function validateFields(requiredFields = [], optionalFields = []) {
  return (req, res, next) => {
    const errors = [];
    const body = req.body || {};

    // 检查必需字段
    for (const field of requiredFields) {
      if (!(field in body) || body[field] === null || body[field] === undefined) {
        errors.push(`Field '${field}' is required`);
      } else if (typeof body[field] === 'string' && body[field].trim() === '') {
        errors.push(`Field '${field}' cannot be empty`);
      }
    }

    // 检查未知字段
    const allowedFields = [...requiredFields, ...optionalFields];
    for (const field in body) {
      if (!allowedFields.includes(field)) {
        errors.push(`Unknown field '${field}'`);
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: errors
      });
    }

    next();
  };
}

// 参数类型验证中间件工厂
function validateTypes(fieldTypes = {}) {
  return (req, res, next) => {
    const errors = [];
    const body = req.body || {};

    for (const [field, expectedType] of Object.entries(fieldTypes)) {
      if (field in body && body[field] !== null && body[field] !== undefined) {
        const actualType = typeof body[field];
        
        if (expectedType === 'array' && !Array.isArray(body[field])) {
          errors.push(`Field '${field}' must be an array`);
        } else if (expectedType !== 'array' && actualType !== expectedType) {
          errors.push(`Field '${field}' must be of type ${expectedType}, got ${actualType}`);
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Type validation failed',
        code: 'TYPE_VALIDATION_ERROR',
        details: errors
      });
    }

    next();
  };
}

// 数值范围验证中间件工厂
function validateRanges(fieldRanges = {}) {
  return (req, res, next) => {
    const errors = [];
    const body = req.body || {};

    for (const [field, range] of Object.entries(fieldRanges)) {
      if (field in body && body[field] !== null && body[field] !== undefined) {
        const value = body[field];
        
        if (typeof value === 'number') {
          if (range.min !== undefined && value < range.min) {
            errors.push(`Field '${field}' must be at least ${range.min}`);
          }
          if (range.max !== undefined && value > range.max) {
            errors.push(`Field '${field}' must be at most ${range.max}`);
          }
        } else if (typeof value === 'string') {
          if (range.minLength !== undefined && value.length < range.minLength) {
            errors.push(`Field '${field}' must be at least ${range.minLength} characters long`);
          }
          if (range.maxLength !== undefined && value.length > range.maxLength) {
            errors.push(`Field '${field}' must be at most ${range.maxLength} characters long`);
          }
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Range validation failed',
        code: 'RANGE_VALIDATION_ERROR',
        details: errors
      });
    }

    next();
  };
}

module.exports = {
  requestSizeMiddleware,
  jsonErrorHandler,
  contentTypeMiddleware,
  validateFields,
  validateTypes,
  validateRanges
};
