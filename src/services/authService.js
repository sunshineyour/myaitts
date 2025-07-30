const crypto = require('crypto');
const dbClient = require('./dbClient');
const { getPackageConfig } = require('../utils/config');

// JWT相关函数 (从worker.js迁移)
async function hmacSha256(data, key) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function btoa(str) {
  return Buffer.from(str).toString('base64');
}

function atob(str) {
  return Buffer.from(str, 'base64').toString();
}

async function verifyToken(token, allowRefresh = false) {
  const JWT_SECRET = process.env.JWT_SECRET;

  try {
    const [header, payload, signature] = token.split('.');
    const expectedSignature = btoa(
      await hmacSha256(`${header}.${payload}`, JWT_SECRET)
    );

    if (signature !== expectedSignature) {
      throw new Error('Invalid signature');
    }

    const decoded = JSON.parse(atob(payload));

    // 检查 token 类型
    if (!allowRefresh && decoded.type === 'refresh') {
      throw new Error('Invalid token type');
    }

    if (Date.now() > decoded.exp) {
      throw new Error('Token expired');
    }

    return decoded.sub;
  } catch (error) {
    // 【修复】保留原始错误信息，不要统一转换为 'Invalid token'
    // 这样认证中间件就能正确区分不同类型的错误
    if (error.message === 'Token expired' ||
        error.message === 'Invalid signature' ||
        error.message === 'Invalid token type') {
      throw error; // 保留原始错误
    }

    // 对于其他错误（如JSON解析失败、token格式错误等），统一为 'Invalid token'
    throw new Error('Invalid token');
  }
}

async function generateToken(username, type = 'access') {
  const JWT_SECRET = process.env.JWT_SECRET;
  const now = Date.now();
  
  const expireTime = type === 'access' 
    ? now + (parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200) * 1000
    : now + (parseInt(process.env.REFRESH_TOKEN_EXPIRE) || 604800) * 1000;

  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: username,
    type: type,
    iat: now,
    exp: expireTime
  }));

  const signature = btoa(await hmacSha256(`${header}.${payload}`, JWT_SECRET));
  
  return `${header}.${payload}.${signature}`;
}

async function checkVip(username, requiredTier = 'STANDARD', requestedChars = 0) {
  const result = await dbClient.query(
    'SELECT vip_info, usage_stats FROM users WHERE username = $1',
    [username]
  );

  if (result.rows.length === 0) {
    throw new Error('用户不存在', { cause: 'quota' });
  }

  const { vip_info: vip, usage_stats: usage } = result.rows[0];

  // 基础检查：是否有会员资格
  if (!vip || Object.keys(vip).length === 0) {
    throw new Error('请先开通会员', { cause: 'quota' });
  }

  // 时间检查：会员是否已过期
  if (Date.now() > vip.expireAt) {
    throw new Error('会员已过期，请续费', { cause: 'quota' });
  }

  // 字符数配额检查 (新规则用户)
  const isNewRuleUser = vip.quotaChars !== undefined;

  if (isNewRuleUser && requestedChars > 0) {
    console.log(`[QUOTA-CHECK] User ${username} is under new quota rule. Checking quota...`);

    const currentUsed = vip.usedChars || 0;
    const totalQuota = vip.quotaChars || 0;

    if (currentUsed + requestedChars > totalQuota) {
      const remaining = Math.max(0, totalQuota - currentUsed);
      throw new Error(`字符数配额不足。剩余 ${remaining} 字符，本次需要 ${requestedChars} 字符。请升级或续费套餐。`, { cause: 'quota' });
    }
  } else if (requestedChars > 0) {
    console.log(`[QUOTA-CHECK] User ${username} is a legacy user. Skipping quota check.`);
  }

  // 等级检查：如果要求PRO权限
  if (requiredTier === 'PRO') {
    const userTier = vip.type;
    if (!userTier || !userTier.startsWith('P')) {
      throw new Error('此功能需要PRO会员权限', { cause: 'quota' });
    }
  }

  // 测试套餐的特殊逻辑
  if (vip.type === 'PT') {
    const remainingTime = Math.max(0, vip.expireAt - Date.now()) / 1000;
    if (remainingTime <= 0) {
      throw new Error('测试时间已用完，请充值', { cause: 'quota' });
    }
    console.log(`测试套餐剩余时间: ${remainingTime.toFixed(1)}秒`);
  }
}

async function updateUserUsage(username, charCount) {
  const client = await dbClient.getClient();

  try {
    await client.query('BEGIN');

    // 获取当前用户数据
    const result = await client.query(
      'SELECT vip_info, usage_stats FROM users WHERE username = $1 FOR UPDATE',
      [username]
    );

    if (result.rows.length === 0) {
      throw new Error('用户不存在');
    }

    const { vip_info: vip, usage_stats: usage } = result.rows[0];

    // 更新VIP使用量 (如果是新规则用户)
    if (vip.quotaChars !== undefined) {
      vip.usedChars = (vip.usedChars || 0) + charCount;
    }

    // 更新使用统计
    usage.totalChars = (usage.totalChars || 0) + charCount;
    usage.monthlyChars = (usage.monthlyChars || 0) + charCount;

    // 检查月度重置
    const now = Date.now();
    if (now >= (usage.monthlyResetAt || 0)) {
      usage.monthlyChars = charCount;
      usage.monthlyResetAt = getNextMonthResetTimestamp();
    }

    // 更新数据库
    await client.query(
      'UPDATE users SET vip_info = $1, usage_stats = $2, updated_at = CURRENT_TIMESTAMP WHERE username = $3',
      [JSON.stringify(vip), JSON.stringify(usage), username]
    );

    await client.query('COMMIT');
    console.log(`Updated usage for user ${username}: +${charCount} chars`);

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function getNextMonthResetTimestamp() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.getTime();
}

// 【新增】计算用户配额详细信息 - 与参考代码完全一致
function calculateQuotaDetails(userData) {
  const vip = userData.vip_info || { expireAt: 0 };

  // 判断是否为老用户（没有quotaChars字段）
  const isLegacyUser = vip.quotaChars === undefined;

  if (isLegacyUser) {
    // 老用户：无限制
    return {
      isLegacyUser: true,
      quotaChars: undefined,
      usedChars: undefined,
      remainingChars: undefined,
      usagePercentage: 0
    };
  }

  // 新用户：计算具体配额信息
  const totalQuota = vip.quotaChars || 0;
  const usedQuota = vip.usedChars || 0;
  const remainingQuota = Math.max(0, totalQuota - usedQuota);
  const usagePercentage = totalQuota > 0 ? Math.min(100, (usedQuota / totalQuota) * 100) : 0;

  return {
    isLegacyUser: false,
    quotaChars: totalQuota,
    usedChars: usedQuota,
    remainingChars: remainingQuota,
    usagePercentage: Math.round(usagePercentage * 100) / 100 // 保留2位小数
  };
}

// 卡密验证函数
async function verifyCard(code) {
  const result = await dbClient.query(
    'SELECT * FROM cards WHERE code = $1',
    [code]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const card = result.rows[0];

  // 检查卡密状态
  if (card.status !== 'unused') {
    return null;
  }

  return {
    code: card.code,
    type: card.package_type,
    packageInfo: card.package_info
  };
}

// 【完全重写】卡密使用函数 - 与参考代码逻辑完全一致
async function useCard(code, username) {
  const client = await dbClient.getClient();

  try {
    await client.query('BEGIN');

    // 获取卡密信息
    const cardResult = await client.query(
      'SELECT * FROM cards WHERE code = $1 FOR UPDATE',
      [code]
    );

    if (cardResult.rows.length === 0) {
      throw new Error('无效的卡密');
    }

    const card = cardResult.rows[0];

    if (card.status !== 'unused') {
      throw new Error('该卡密已被使用');
    }

    // 【新增】如果是测试套餐，检查是否已有其他有效套餐
    if (card.package_type === 'PT') {
      const userResult = await client.query(
        'SELECT vip_info FROM users WHERE username = $1',
        [username]
      );

      if (userResult.rows.length > 0) {
        const userData = userResult.rows[0];
        const vip = userData.vip_info || {};
        if (vip && Date.now() < (vip.expireAt || 0) && vip.type !== 'PT') {
          throw new Error('已有正式会员，无需使用测试套餐');
        }
      }
    }

    // 先标记卡密为使用中
    await client.query(
      'UPDATE cards SET status = $1 WHERE code = $2',
      ['using', code]
    );

    // 获取用户信息
    const userResult = await client.query(
      'SELECT * FROM users WHERE username = $1 FOR UPDATE',
      [username]
    );

    if (userResult.rows.length === 0) {
      throw new Error('用户不存在');
    }

    const userData = userResult.rows[0];
    let vip = userData.vip_info || {};

    // 【关键】获取新套餐的配置 - 使用统一的套餐配置
    const newPackage = getPackageConfig(card.package_type);
    if (!newPackage) {
      throw new Error('未知的套餐类型');
    }

    // 【关键】初始化VIP对象（如果不存在）
    if (!vip || Object.keys(vip).length === 0) {
      vip = {
        expireAt: 0,
        type: null,
        quotaChars: 0, // 新增：总配额
        usedChars: 0   // 新增：已用配额
      };
    } else {
      // 【核心修改】统一迁移逻辑 - 与参考代码完全一致
      // 如果用户的配额系统还未初始化 (无论是新用户还是老用户)
      if (vip.quotaChars === undefined) {
        // 打印一条迁移日志，方便追踪
        console.log(`[MIGRATION] Migrating user ${username} to new quota system upon renewal.`);

        // 强制为该用户初始化配额系统，这是"单向阀门"
        vip.quotaChars = 0;
        vip.usedChars = 0;
      }
    }

    // 1. 【修复】先判断是否过期（使用旧的到期时间）
    const oldExpireAt = vip.expireAt || 0;
    const isExpired = Date.now() > oldExpireAt;

    // 2. 【核心修改】叠加字符数配额（现在对所有用户生效）
    if (vip.quotaChars !== undefined) {
      // 如果会员已过期，则不保留剩余字符；否则，保留剩余字符
      const oldRemainingChars = isExpired ? 0 : Math.max(0, vip.quotaChars - vip.usedChars);

      // 新的总配额 = 剩余配额 + 新套餐配额
      vip.quotaChars = oldRemainingChars + newPackage.chars;

      // 已用配额清零
      vip.usedChars = 0;

      console.log(`[CARD-USE] Updated quota for user ${username}: ${vip.quotaChars} chars (expired: ${isExpired}, old remaining: ${oldRemainingChars})`);
    }

    // 3. 计算新的到期时间（在配额计算之后）
    const baseTime = Math.max(oldExpireAt, Date.now());
    vip.expireAt = baseTime + (newPackage.days * 86400000);

    // 3. 更新套餐类型
    vip.type = card.package_type;

    // 更新用户数据
    await client.query(
      'UPDATE users SET vip_info = $1, updated_at = CURRENT_TIMESTAMP WHERE username = $2',
      [JSON.stringify(vip), username]
    );

    // 标记卡密为已使用
    await client.query(
      'UPDATE cards SET status = $1, used_at = CURRENT_TIMESTAMP, used_by = $2 WHERE code = $3',
      ['used', username, code]
    );

    await client.query('COMMIT');

    console.log(`Card ${code} used successfully by ${username}`);
    return vip;

  } catch (error) {
    // 如果出错，恢复卡密状态
    try {
      await client.query(
        'UPDATE cards SET status = $1 WHERE code = $2',
        ['unused', code]
      );
    } catch (rollbackError) {
      console.error('Failed to rollback card status:', rollbackError);
    }

    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 密码加密函数（从worker.js迁移）
async function bcrypt(password) {
  const crypto = require('crypto');
  const data = password + process.env.JWT_SECRET;
  const hash = crypto.createHash('sha256').update(data).digest();
  return Buffer.from(hash).toString('base64');
}

// 生成验证码
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6位数字验证码
}

// 腾讯云签名生成函数
async function generateTencentCloudSignature(secretId, secretKey, service, region, action, payload, timestamp) {
  const crypto = require('crypto');

  // 步骤1：拼接规范请求串
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${service}.tencentcloudapi.com\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  // 步骤2：拼接待签名字符串
  const algorithm = 'TC3-HMAC-SHA256';
  const date = new Date(timestamp * 1000).toISOString().substr(0, 10);
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  // 步骤3：计算签名
  const secretDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
  const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
  const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

  // 步骤4：拼接Authorization
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    authorization,
    timestamp: timestamp.toString()
  };
}

// 调用腾讯云 SES API 发送邮件
async function sendEmailViaTencentSES(toEmail, templateData) {
  const service = 'ses';
  const action = 'SendEmail';
  const version = '2020-10-02';
  const timestamp = Math.floor(Date.now() / 1000);

  // 获取配置
  const secretId = process.env.TENCENT_SECRET_ID;
  const secretKey = process.env.TENCENT_SECRET_KEY;
  const region = process.env.SES_REGION || 'ap-guangzhou';
  const fromEmail = process.env.FROM_EMAIL;
  const fromEmailName = process.env.FROM_EMAIL_NAME || '验证服务';
  const templateId = process.env.VERIFICATION_TEMPLATE_ID;

  // 调试日志
  console.log('SES Config check:', {
    hasSecretId: !!secretId,
    hasSecretKey: !!secretKey,
    region: region,
    fromEmail: fromEmail,
    templateId: templateId
  });

  if (!secretId || !secretKey || !fromEmail || !templateId) {
    throw new Error('腾讯云SES配置不完整，请检查环境变量');
  }

  // 构建请求体
  const payload = JSON.stringify({
    FromEmailAddress: `${fromEmailName} <${fromEmail}>`,
    Destination: [toEmail],
    Subject: '邮箱验证码',
    Template: {
      TemplateID: parseInt(templateId),
      TemplateData: JSON.stringify(templateData)
    },
    TriggerType: 1 // 触发类邮件
  });

  // 生成签名
  const signatureInfo = await generateTencentCloudSignature(
    secretId,
    secretKey,
    service,
    region,
    action,
    payload,
    timestamp
  );

  // 构建请求头
  const headers = {
    'Authorization': signatureInfo.authorization,
    'Content-Type': 'application/json; charset=utf-8',
    'Host': `${service}.tencentcloudapi.com`,
    'X-TC-Action': action,
    'X-TC-Timestamp': signatureInfo.timestamp,
    'X-TC-Version': version,
    'X-TC-Region': region
  };

  console.log(`Sending email to ${toEmail} with template data:`, templateData);

  // 发送请求
  const response = await fetch(`https://${service}.tencentcloudapi.com/`, {
    method: 'POST',
    headers: headers,
    body: payload
  });

  const result = await response.json();

  if (!response.ok || result.Response.Error) {
    console.error('SES API Error:', result.Response.Error);
    throw new Error(result.Response.Error?.Message || 'Failed to send email');
  }

  console.log('Email sent successfully, MessageId:', result.Response.MessageId);
  return result.Response.MessageId;
}

// 检查邮箱发送频率限制
async function checkEmailSendLimit(email) {
  const result = await dbClient.query(
    'SELECT last_send_time FROM email_send_limits WHERE email = $1',
    [email]
  );

  if (result.rows.length > 0) {
    const lastSendTime = result.rows[0].last_send_time.getTime();
    const timeDiff = Date.now() - lastSendTime;
    if (timeDiff < 60000) { // 1分钟内不能重复发送
      const remainingTime = Math.ceil((60000 - timeDiff) / 1000);
      throw new Error(`请等待 ${remainingTime} 秒后再试`);
    }
  }

  // 记录发送时间
  await dbClient.query(
    'INSERT INTO email_send_limits (email, last_send_time) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (email) DO UPDATE SET last_send_time = CURRENT_TIMESTAMP',
    [email]
  );
}

// 存储验证码
async function storeVerificationCode(email, code) {
  // 先检查发送频率限制
  await checkEmailSendLimit(email);

  const verificationData = {
    code,
    expireTime: Date.now() + 10 * 60 * 1000, // 10分钟过期
    attempts: 0,
    maxAttempts: 5
  };

  // 使用PostgreSQL存储验证码（替代KV）
  await dbClient.query(
    'INSERT INTO verification_codes (email, code, expire_time, attempts, max_attempts) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO UPDATE SET code = $2, expire_time = $3, attempts = 0',
    [email, code, new Date(verificationData.expireTime), verificationData.attempts, verificationData.maxAttempts]
  );
}

// 验证邮箱验证码
async function verifyEmailCode(email, inputCode) {
  const result = await dbClient.query(
    'SELECT * FROM verification_codes WHERE email = $1',
    [email]
  );

  if (result.rows.length === 0) {
    throw new Error('验证码不存在或已过期');
  }

  const data = result.rows[0];

  // 检查是否过期
  if (Date.now() > data.expire_time.getTime()) {
    await dbClient.query('DELETE FROM verification_codes WHERE email = $1', [email]);
    throw new Error('验证码已过期');
  }

  // 检查尝试次数
  if (data.attempts >= data.max_attempts) {
    await dbClient.query('DELETE FROM verification_codes WHERE email = $1', [email]);
    throw new Error('验证码尝试次数过多，请重新获取');
  }

  // 验证码错误，增加尝试次数
  if (data.code !== inputCode) {
    await dbClient.query(
      'UPDATE verification_codes SET attempts = attempts + 1 WHERE email = $1',
      [email]
    );
    throw new Error('验证码错误');
  }

  // 验证成功，删除验证码
  await dbClient.query('DELETE FROM verification_codes WHERE email = $1', [email]);
  return true;
}

module.exports = {
  verifyToken,
  generateToken,
  checkVip,
  updateUserUsage,
  verifyCard,
  useCard,
  bcrypt,
  generateVerificationCode,
  sendEmailViaTencentSES,
  storeVerificationCode,
  verifyEmailCode,
  checkEmailSendLimit,
  generateTencentCloudSignature,
  calculateQuotaDetails,
  getNextMonthResetTimestamp,
  hmacSha256,
  btoa,
  atob
};
