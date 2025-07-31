// 认证配置
const getAuthConfig = () => ({
  JWT_SECRET: process.env.JWT_SECRET,
  ACCESS_TOKEN_EXPIRE: parseInt(process.env.ACCESS_TOKEN_EXPIRE) || 7200, // 2小时
  REFRESH_TOKEN_EXPIRE: parseInt(process.env.REFRESH_TOKEN_EXPIRE) || 604800, // 7天
  SALT_ROUNDS: parseInt(process.env.SALT_ROUNDS) || 10
});

// 腾讯云SES邮件配置
const getSESConfig = () => ({
  TENCENT_SECRET_ID: process.env.TENCENT_SECRET,
  TENCENT_SECRET_KEY: process.env.TENCENT_SECRET_KEY,
  SES_REGION: process.env.SES_REGION || 'ap-guangzhou',
  FROM_EMAIL: process.env.FROM_EMAIL,
  FROM_EMAIL_NAME: process.env.FROM_EMAIL_NAME || '验证服务',
  VERIFICATION_TEMPLATE_ID: process.env.VERIFICATION_TEMPLATE_ID
});

// 进度消息配置
const getProgressConfig = () => ({
  ENABLE_PROGRESS_MESSAGES: process.env.ENABLE_PROGRESS_MESSAGES === 'true' || process.env.ENABLE_PROGRESS_MESSAGES === true,
  ENABLE_DEBUG_PROGRESS: process.env.DEBUG === 'true' || process.env.DEBUG === true
});

// TTS 代理配置
const getTTSProxyConfig = () => {
  // 智能解析代理URL配置，支持新旧两种格式
  let proxyUrls = [];

  // 优先使用新的多URL配置 TTS_PROXY_URLS
  if (process.env.TTS_PROXY_URLS) {
    proxyUrls = process.env.TTS_PROXY_URLS
      .split(',')
      .map(url => url.trim())
      .filter(Boolean); // 移除空项
  }
  // 向后兼容：如果没有新配置，使用旧的单URL配置
  else if (process.env.TTS_PROXY_URL) {
    proxyUrls = [process.env.TTS_PROXY_URL];
  }

  return {
    // 基础代理配置
    ENABLE_TTS_PROXY: process.env.ENABLE_TTS_PROXY === 'true' || process.env.ENABLE_TTS_PROXY === true,

    // 多代理URL列表（主要配置）
    TTS_PROXY_URLS: proxyUrls,

    // 单一代理URL（向后兼容，从列表中取第一个）
    TTS_PROXY_URL: proxyUrls.length > 0 ? proxyUrls[0] : null,

    TTS_PROXY_SECRET: process.env.TTS_PROXY_SECRET || process.env.PROXY_SECRET || null, // 代理认证密钥

    // 代理策略配置
    TTS_PROXY_MODE: process.env.TTS_PROXY_MODE || 'fallback', // 'direct', 'proxy', 'balanced', 'fallback'
    TTS_PROXY_TIMEOUT: parseInt(process.env.TTS_PROXY_TIMEOUT || '45000'), // 代理请求超时时间（毫秒）
    TTS_PROXY_RETRY_COUNT: parseInt(process.env.TTS_PROXY_RETRY_COUNT || '2'), // 代理重试次数

    // 负载均衡配置（当模式为 'balanced' 时使用）
    TTS_PROXY_BALANCE_RATIO: parseFloat(process.env.TTS_PROXY_BALANCE_RATIO || '0.9'), // 90% 流量走代理

    // 【新增】健康检查配置
    TTS_HEALTH_CHECK_ENABLED: process.env.TTS_HEALTH_CHECK_ENABLED === 'true', // 是否启用健康检查
    TTS_HEALTH_CHECK_TIMEOUT: parseInt(process.env.TTS_HEALTH_CHECK_TIMEOUT || '3000'), // 健康检查超时时间（毫秒）
    TTS_HEALTHY_PROXY_TIMEOUT: parseInt(process.env.TTS_HEALTHY_PROXY_TIMEOUT || '60000'), // 健康代理的请求超时时间（毫秒）

    // 故障转移配置
    TTS_FALLBACK_THRESHOLD: parseInt(process.env.TTS_FALLBACK_THRESHOLD || '2'), // 连续失败N次后启用预防性代理
    TTS_FALLBACK_WINDOW: parseInt(process.env.TTS_FALLBACK_WINDOW || '300'), // 故障检测时间窗口（秒）

    // 集群级重试和退避配置
    TTS_CLUSTER_RETRY_COUNT: parseInt(process.env.TTS_CLUSTER_RETRY_COUNT || '3'), // 集群级重试次数
    TTS_CLUSTER_MAX_DELAY: parseInt(process.env.TTS_CLUSTER_MAX_DELAY || '8000'), // 集群重试最大延迟（毫秒）
    TTS_SINGLE_MAX_DELAY: parseInt(process.env.TTS_SINGLE_MAX_DELAY || '5000'), // 单代理重试最大延迟（毫秒）
    TTS_DIRECT_MAX_DELAY: parseInt(process.env.TTS_DIRECT_MAX_DELAY || '8000'), // 直连重试最大延迟（毫秒）
    TTS_ENABLE_BACKOFF: process.env.TTS_ENABLE_BACKOFF !== 'false', // 默认启用指数退避

    // 代理选择策略配置
    TTS_PROXY_SELECTION_STRATEGY: process.env.TTS_PROXY_SELECTION_STRATEGY || 'sequential',

    // 调试和监控
    ENABLE_PROXY_STATS: process.env.ENABLE_PROXY_STATS !== 'false', // 默认启用代理统计
    ENABLE_PROXY_DEBUG: process.env.ENABLE_PROXY_DEBUG === 'true' || process.env.DEBUG === 'true'
  };
};

// 任务级重试配置
const getTaskRetryConfig = () => ({
  // 任务级重试开关
  ENABLE_TASK_RETRY: process.env.ENABLE_TASK_RETRY !== 'false', // 默认启用

  // 重试次数配置（保守设置）
  MAX_TASK_RETRIES: parseInt(process.env.MAX_TASK_RETRIES || '2'), // 最多重试2次（总共尝试3次）

  // 重试延迟配置（渐进式）
  TASK_RETRY_DELAYS: [
    parseInt(process.env.TASK_RETRY_DELAY_1 || '6000'),  // 第一次重试：6秒
    parseInt(process.env.TASK_RETRY_DELAY_2 || '12000')  // 第二次重试：12秒
  ],

  // 绝对超时限制（防止用户无限等待）
  TASK_ABSOLUTE_TIMEOUT: parseInt(process.env.TASK_ABSOLUTE_TIMEOUT || '600000'), // 10分钟绝对上限

  // 调试和监控
  ENABLE_TASK_RETRY_DEBUG: process.env.ENABLE_TASK_RETRY_DEBUG === 'true' || process.env.DEBUG === 'true'
});

// 智能超时配置
const getSmartTimeoutConfig = () => ({
  // 基础超时配置（可通过环境变量调整）
  INIT_TIMEOUT: parseInt(process.env.TTS_INIT_TIMEOUT || '30000'), // 初始化超时：30秒
  TEXT_PROCESSING_TIMEOUT: parseInt(process.env.TTS_TEXT_PROCESSING_TIMEOUT || '60000'), // 文本处理：1分钟
  AUDIO_MERGING_TIMEOUT: parseInt(process.env.TTS_AUDIO_MERGING_TIMEOUT || '120000'), // 音频合并：2分钟
  FILE_STORAGE_TIMEOUT: parseInt(process.env.TTS_FILE_STORAGE_TIMEOUT || '60000'), // 文件存储：1分钟
  DEFAULT_TIMEOUT: parseInt(process.env.TTS_DEFAULT_TIMEOUT || '300000'), // 默认：5分钟

  // 音频生成的智能超时配置
  CHUNK_BASE_TIMEOUT: parseInt(process.env.TTS_CHUNK_TIMEOUT || '40000'), // 每chunk基础超时：40秒
  MIN_AUDIO_TIMEOUT: parseInt(process.env.TTS_MIN_TIMEOUT || '120000'), // 音频生成最少：2分钟
  MAX_AUDIO_TIMEOUT: parseInt(process.env.TTS_MAX_TIMEOUT || '900000'), // 音频生成最多：15分钟

  // 复杂度调整因子
  ENABLE_COMPLEXITY_ADJUSTMENT: process.env.TTS_ENABLE_COMPLEXITY_ADJUSTMENT !== 'false', // 默认启用复杂度调整
  LARGE_CHUNK_THRESHOLD: parseInt(process.env.TTS_LARGE_CHUNK_THRESHOLD || '10'), // 大量chunk阈值
  HUGE_CHUNK_THRESHOLD: parseInt(process.env.TTS_HUGE_CHUNK_THRESHOLD || '20'), // 超大量chunk阈值
  LARGE_TEXT_THRESHOLD: parseInt(process.env.TTS_LARGE_TEXT_THRESHOLD || '5000'), // 大文本字符数阈值
  HUGE_TEXT_THRESHOLD: parseInt(process.env.TTS_HUGE_TEXT_THRESHOLD || '10000'), // 超大文本字符数阈值

  // 调试开关
  ENABLE_TIMEOUT_DEBUG: process.env.TTS_ENABLE_TIMEOUT_DEBUG === 'true' || process.env.DEBUG === 'true'
});

// 【新增】卡密套餐配置 - 与参考代码完全一致
const PACKAGES = {
  // --- 标准套餐 ---
  'M': { days: 30, price: 25, chars: 80000 },     // 月套餐，8万字符
  'Q': { days: 90, price: 55, chars: 250000 },    // 季度套餐，25万字符
  'H': { days: 180, price: 99, chars: 550000 },   // 半年套餐，55万字符

  // --- 新增：PRO套餐 ---
  'PM': { days: 30, price: 45, chars: 250000 },   // 月度PRO，25万字符
  'PQ': { days: 90, price: 120, chars: 800000 },  // 季度PRO，80万字符
  'PH': { days: 180, price: 220, chars: 2000000 }, // 半年PRO，200万字符

  // --- 特殊套餐 ---
  'PT': { days: 0.0208, price: 0, chars: 2000 }   // 30分钟测试套餐，2千字符
};

// 【新增】获取套餐配置
const getPackageConfig = (packageType) => {
  return PACKAGES[packageType] || null;
};

// 【新增】获取所有套餐配置
const getAllPackages = () => {
  return PACKAGES;
};

module.exports = {
  getAuthConfig,
  getSESConfig,
  getProgressConfig,
  getTTSProxyConfig,
  getTaskRetryConfig,
  getSmartTimeoutConfig,
  PACKAGES,
  getPackageConfig,
  getAllPackages
};
