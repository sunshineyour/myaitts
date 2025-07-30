const express = require('express');
const router = express.Router();
const {
  verifyToken,
  generateToken,
  bcrypt,
  generateVerificationCode,
  sendEmailViaTencentSES,
  storeVerificationCode,
  verifyEmailCode
} = require('../services/authService');
const dbClient = require('../services/dbClient');
const {
  isValidEmail,
  isValidUsername,
  isValidPassword,
  isValidVerificationCode
} = require('../utils/validators');
const { corsHeaders } = require('../utils/helpers');
const { createSafeErrorResponse } = require('../utils/errorSecurity');

// 用户登录
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }

    // 支持邮箱登录
    let actualUsername = username;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (emailRegex.test(username)) {
      const result = await dbClient.query(
        'SELECT username FROM users WHERE email = $1',
        [username]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: '用户名或密码错误' });
      }

      actualUsername = result.rows[0].username;
    }

    // 验证用户密码
    const result = await dbClient.query(
      'SELECT * FROM users WHERE username = $1',
      [actualUsername]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: '用户名或密码错误' });
    }

    const user = result.rows[0];
    const hashedPassword = await bcrypt(password);

    if (hashedPassword !== user.password_hash) {
      return res.status(400).json({ error: '用户名或密码错误' });
    }

    // 生成JWT token
    const accessToken = await generateToken(actualUsername, 'access');
    const refreshToken = await generateToken(actualUsername, 'refresh');

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200,
      username: actualUsername
    });
  } catch (error) {
    console.error('Login error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    // 登录失败统一返回通用错误消息（安全考虑）
    res.status(500).json({
      error: '登录失败，请检查用户名和密码后重试',
      timestamp: safeResponse.timestamp
    });
  }
});

// 用户注册（兼容旧版本，推荐使用 /verify-email）
router.post('/register', async (req, res) => {
  try {
    const { username, password, email, verificationCode } = req.body;

    // 验证输入
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: '用户名格式不正确（3-20个字符，只能包含字母、数字、下划线）' });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({ error: '密码至少需要6个字符' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    if (!isValidVerificationCode(verificationCode)) {
      return res.status(400).json({ error: '验证码格式不正确' });
    }

    // 验证邮箱验证码
    await verifyEmailCode(email, verificationCode);

    // 检查用户名是否已存在
    const existingUser = await dbClient.query(
      'SELECT username FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: '用户名或邮箱已存在' });
    }

    // 创建新用户
    const hashedPassword = await bcrypt(password);
    await dbClient.query(
      'INSERT INTO users (username, password_hash, email, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [username, hashedPassword, email]
    );

    // 生成JWT token
    const accessToken = await generateToken(username, 'access');
    const refreshToken = await generateToken(username, 'refresh');

    res.status(201).json({
      message: '注册成功',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200,
      username: username
    });
  } catch (error) {
    console.error('Register error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    // 根据错误类型返回适当的状态码和消息
    if (error.name === 'ValidationError' || error.message.includes('验证码')) {
      res.status(400).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else if (error.name === 'ConflictError' || error.code === 'DUPLICATE_ENTRY') {
      res.status(409).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else {
      res.status(500).json({
        error: '注册失败，请稍后重试',
        timestamp: safeResponse.timestamp
      });
    }
  }
});

// 发送邮箱验证码（注册第一步）
router.post('/send-verification', async (req, res) => {
  try {
    const { username, password, email } = req.body;

    // 验证输入
    if (!username || !password || !email) {
      return res.status(400).json({ error: '用户名、密码和邮箱不能为空' });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: '用户名格式不正确（3-20个字符，只能包含字母、数字、下划线）' });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({ error: '密码至少需要6个字符' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 检查用户名和邮箱是否已注册
    const existingUser = await dbClient.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: '用户名或邮箱已存在' });
    }

    // 生成验证码
    const code = generateVerificationCode();

    // 存储验证码
    await storeVerificationCode(email, code);

    // 临时存储用户注册信息（10分钟过期）
    const hashedPassword = await bcrypt(password);
    const tempUserData = {
      username,
      passwordHash: hashedPassword,
      email,
      createdAt: Date.now()
    };

    // 使用Redis存储临时用户数据
    const redisClient = require('../services/redisClient');
    await redisClient.setex(`pending:user:${username}`, 600, JSON.stringify(tempUserData)); // 10分钟TTL

    // 发送邮件
    await sendEmailViaTencentSES(email, {
      code: code,
      email: email
    });

    res.json({
      message: '验证码已发送到您的邮箱，请查收',
      email: email
    });
  } catch (error) {
    console.error('Send verification error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    res.status(500).json({
      error: '发送验证码失败，请稍后重试',
      timestamp: safeResponse.timestamp
    });
  }
});

// 验证邮箱并完成注册（注册第二步）
router.post('/verify-email', async (req, res) => {
  try {
    const { username, email, code } = req.body;

    // 基本参数验证
    if (!username || !email || !code) {
      return res.status(400).json({ error: '用户名、邮箱和验证码不能为空' });
    }

    // 验证输入格式
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    if (!isValidVerificationCode(code)) {
      return res.status(400).json({ error: '验证码格式不正确' });
    }

    // 验证验证码
    await verifyEmailCode(email, code);

    // 获取临时存储的用户数据
    const redisClient = require('../services/redisClient');
    const tempUserDataString = await redisClient.get(`pending:user:${username}`);

    if (!tempUserDataString) {
      return res.status(400).json({ error: '注册信息已过期，请重新注册' });
    }

    const tempUserData = JSON.parse(tempUserDataString);

    // 验证邮箱是否匹配
    if (tempUserData.email !== email) {
      return res.status(400).json({ error: '邮箱信息不匹配' });
    }

    // 检查用户名和邮箱是否已存在（再次检查，防止并发注册）
    const existingUser = await dbClient.query(
      'SELECT username FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: '用户名或邮箱已存在' });
    }

    // 创建新用户（使用临时存储的密码哈希）
    await dbClient.query(
      'INSERT INTO users (username, password_hash, email, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [username, tempUserData.passwordHash, email]
    );

    // 清理临时数据
    await redisClient.del(`pending:user:${username}`);

    // 生成JWT token
    const accessToken = await generateToken(username, 'access');
    const refreshToken = await generateToken(username, 'refresh');

    res.status(201).json({
      message: '注册成功',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200,
      username: username
    });
  } catch (error) {
    console.error('Verify email error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    // 根据错误类型返回适当的响应
    if (error.name === 'ValidationError' || error.message.includes('验证码')) {
      res.status(400).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else if (error.name === 'ConflictError' || error.code === 'DUPLICATE_ENTRY') {
      res.status(409).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else {
      res.status(500).json({
        error: '验证失败，请稍后重试',
        timestamp: safeResponse.timestamp
      });
    }
  }
});

// 刷新token
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token is required' });
    }

    // 验证refresh token
    const username = await verifyToken(refresh_token, true);

    // 生成新的access token
    const newAccessToken = await generateToken(username, 'access');

    res.json({
      access_token: newAccessToken,
      expires_in: parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200
    });
  } catch (error) {
    console.error('Refresh token error:', error);

    // 设置错误类型以便安全处理识别
    if (error.message === 'Token expired') {
      error.code = 'TOKEN_EXPIRED';
    } else if (error.message === 'Invalid token' || error.message === 'Invalid signature') {
      error.code = 'TOKEN_INVALID';
    } else if (error.message === 'Invalid token type') {
      error.code = 'TOKEN_TYPE_INVALID';
    } else {
      error.code = 'AUTH_ERROR';
    }

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: true,
      isDevelopment: isDevelopment
    });

    res.status(401).json(safeResponse);
  }
});

// 验证token（用于前端检查token有效性）
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token);

    res.json({
      valid: true,
      username: username
    });
  } catch (error) {
    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    res.status(401).json({
      valid: false,
      error: safeResponse.error,
      timestamp: safeResponse.timestamp
    });
  }
});

// 修改密码
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // 验证输入
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '当前密码和新密码不能为空' });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: '新密码至少需要6个字符' });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({ error: '新密码不能与当前密码相同' });
    }

    // 验证token并获取用户名
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token);

    // 获取用户信息
    const result = await dbClient.query(
      'SELECT password_hash FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const user = result.rows[0];

    // 验证当前密码
    const currentPasswordHash = await bcrypt(currentPassword);
    if (currentPasswordHash !== user.password_hash) {
      return res.status(400).json({ error: '当前密码错误' });
    }

    // 生成新密码哈希
    const newPasswordHash = await bcrypt(newPassword);

    // 更新密码
    await dbClient.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE username = $2',
      [newPasswordHash, username]
    );

    res.json({
      message: '密码修改成功'
    });
  } catch (error) {
    console.error('Change password error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else {
      res.status(500).json({
        error: '修改密码失败，请稍后重试',
        timestamp: safeResponse.timestamp
      });
    }
  }
});

// 忘记密码 - 发送重置验证码
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    // 验证输入
    if (!email) {
      return res.status(400).json({ error: '邮箱不能为空' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    // 检查邮箱是否已注册
    const result = await dbClient.query(
      'SELECT username FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: '该邮箱未注册' });
    }

    const username = result.rows[0].username;

    // 生成验证码
    const code = generateVerificationCode();

    // 存储重置密码验证码（使用特殊前缀区分注册验证码）
    const redisClient = require('../services/redisClient');
    const resetData = {
      code,
      username,
      expireTime: Date.now() + 10 * 60 * 1000, // 10分钟过期
      attempts: 0,
      maxAttempts: 5
    };

    // 使用Redis存储重置验证码，key前缀为reset:
    await redisClient.setex(`reset:${email}`, 600, JSON.stringify(resetData)); // 10分钟TTL

    // 发送邮件
    await sendEmailViaTencentSES(email, {
      code: code,
      email: email,
      username: username
    });

    res.json({
      message: '重置密码验证码已发送到您的邮箱，请查收',
      email: email
    });
  } catch (error) {
    console.error('Forgot password error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    if (error.message.includes('请等待')) {
      res.status(429).json({
        error: safeResponse.error,
        timestamp: safeResponse.timestamp
      });
    } else {
      res.status(500).json({
        error: '发送验证码失败，请稍后重试',
        timestamp: safeResponse.timestamp
      });
    }
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;

    // 验证输入
    if (!email || !code || !newPassword) {
      return res.status(400).json({ error: '邮箱、验证码和新密码不能为空' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }

    if (!isValidVerificationCode(code)) {
      return res.status(400).json({ error: '验证码格式不正确' });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: '新密码至少需要6个字符' });
    }

    // 获取重置验证码数据
    const redisClient = require('../services/redisClient');
    const resetDataString = await redisClient.get(`reset:${email}`);

    if (!resetDataString) {
      return res.status(400).json({ error: '验证码不存在或已过期' });
    }

    const resetData = JSON.parse(resetDataString);

    // 检查是否过期
    if (Date.now() > resetData.expireTime) {
      await redisClient.del(`reset:${email}`);
      return res.status(400).json({ error: '验证码已过期' });
    }

    // 检查尝试次数
    if (resetData.attempts >= resetData.maxAttempts) {
      await redisClient.del(`reset:${email}`);
      return res.status(400).json({ error: '验证码尝试次数过多，请重新获取' });
    }

    // 验证码错误，增加尝试次数
    if (resetData.code !== code) {
      resetData.attempts += 1;
      await redisClient.setex(`reset:${email}`, 600, JSON.stringify(resetData));
      return res.status(400).json({ error: '验证码错误' });
    }

    // 验证成功，更新密码
    const newPasswordHash = await bcrypt(newPassword);

    await dbClient.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE username = $2',
      [newPasswordHash, resetData.username]
    );

    // 删除重置验证码
    await redisClient.del(`reset:${email}`);

    res.json({
      message: '密码重置成功，请使用新密码登录'
    });
  } catch (error) {
    console.error('Reset password error:', error);

    // 使用安全错误处理
    const isDevelopment = process.env.NODE_ENV === 'development';
    const safeResponse = createSafeErrorResponse(error, {
      includeCode: false,
      isDevelopment: isDevelopment
    });

    res.status(500).json({
      error: '重置密码失败，请稍后重试',
      timestamp: safeResponse.timestamp
    });
  }
});

module.exports = router;
