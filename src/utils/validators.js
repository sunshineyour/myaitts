// 邮箱验证
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// 用户名验证
function isValidUsername(username) {
  // 用户名：3-20个字符，只能包含字母、数字、下划线
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  return usernameRegex.test(username);
}

// 密码验证
function isValidPassword(password) {
  // 密码：至少6个字符
  return password && password.length >= 6;
}

// 卡密验证
function isValidCardCode(code) {
  // 卡密：32位字符，只能包含字母和数字
  const cardCodeRegex = /^[a-zA-Z0-9]{32}$/;
  return cardCodeRegex.test(code);
}

// 验证码验证
function isValidVerificationCode(code) {
  // 验证码：6位数字
  const codeRegex = /^\d{6}$/;
  return codeRegex.test(code);
}

// TTS参数验证
function validateTTSParams(params) {
  const errors = [];

  // 必需参数
  if (!params.input || typeof params.input !== 'string') {
    errors.push('input is required and must be a string');
  } else if (params.input.length === 0) {
    errors.push('input cannot be empty');
  } else if (params.input.length > 50000) {
    errors.push('input text is too long (max 50000 characters)');
  }

  if (!params.voice || typeof params.voice !== 'string') {
    errors.push('voice is required and must be a string');
  }

  // 可选参数验证
  if (params.stability !== undefined) {
    const stability = parseFloat(params.stability);
    if (isNaN(stability) || stability < 0 || stability > 1) {
      errors.push('stability must be a number between 0 and 1');
    }
  }

  if (params.similarity_boost !== undefined) {
    const similarity_boost = parseFloat(params.similarity_boost);
    if (isNaN(similarity_boost) || similarity_boost < 0 || similarity_boost > 1) {
      errors.push('similarity_boost must be a number between 0 and 1');
    }
  }

  if (params.style !== undefined) {
    const style = parseFloat(params.style);
    if (isNaN(style) || style < 0 || style > 1) {
      errors.push('style must be a number between 0 and 1');
    }
  }

  if (params.speed !== undefined) {
    const speed = parseFloat(params.speed);
    if (isNaN(speed) || speed < 0.25 || speed > 4.0) {
      errors.push('speed must be a number between 0.25 and 4.0');
    }
  }

  if (params.model && typeof params.model !== 'string') {
    errors.push('model must be a string');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

// 对话TTS参数验证
function validateDialogueTTSParams(params) {
  const errors = [];

  if (!params.dialogue || !Array.isArray(params.dialogue)) {
    errors.push('dialogue is required and must be an array');
  } else {
    params.dialogue.forEach((item, index) => {
      if (!item.text || typeof item.text !== 'string') {
        errors.push(`dialogue[${index}].text is required and must be a string`);
      }
      if (!item.voice || typeof item.voice !== 'string') {
        errors.push(`dialogue[${index}].voice is required and must be a string`);
      }
      if (item.speaker && typeof item.speaker !== 'string') {
        errors.push(`dialogue[${index}].speaker must be a string`);
      }
    });
  }

  // 验证其他TTS参数
  const ttsValidation = validateTTSParams({
    input: 'dummy', // 对话模式下不验证input
    voice: 'dummy', // 对话模式下不验证voice
    ...params
  });

  // 过滤掉input和voice的错误
  const filteredErrors = ttsValidation.errors.filter(error => 
    !error.includes('input') && !error.includes('voice')
  );

  errors.push(...filteredErrors);

  return {
    isValid: errors.length === 0,
    errors
  };
}

// 分页参数验证
function validatePaginationParams(params) {
  const errors = [];
  const result = {
    limit: 20,
    offset: 0
  };

  if (params.limit !== undefined) {
    const limit = parseInt(params.limit);
    if (isNaN(limit) || limit < 1 || limit > 1000) {
      errors.push('limit must be a number between 1 and 1000');
    } else {
      result.limit = limit;
    }
  }

  if (params.offset !== undefined) {
    const offset = parseInt(params.offset);
    if (isNaN(offset) || offset < 0) {
      errors.push('offset must be a non-negative number');
    } else {
      result.offset = offset;
    }
  }

  if (params.page !== undefined) {
    const page = parseInt(params.page);
    if (isNaN(page) || page < 1) {
      errors.push('page must be a positive number');
    } else {
      result.offset = (page - 1) * result.limit;
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    params: result
  };
}

// 请求体大小验证
function validateRequestSize(body, maxSizeBytes = 10 * 1024 * 1024) { // 默认10MB
  const bodySize = JSON.stringify(body).length;
  if (bodySize > maxSizeBytes) {
    return {
      isValid: false,
      error: `Request body too large (${bodySize} bytes, max ${maxSizeBytes} bytes)`
    };
  }
  return { isValid: true };
}

module.exports = {
  isValidEmail,
  isValidUsername,
  isValidPassword,
  isValidCardCode,
  isValidVerificationCode,
  validateTTSParams,
  validateDialogueTTSParams,
  validatePaginationParams,
  validateRequestSize
};
