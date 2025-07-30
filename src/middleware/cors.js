// CORS中间件配置
function corsMiddleware(req, res, next) {
  const isProduction = process.env.NODE_ENV === 'production';
  const origin = req.headers.origin;

  // 生产环境：使用配置的允许域名列表
  // 开发环境：允许所有域名（保持原有行为）
  if (isProduction && process.env.CORS_ALLOWED_ORIGINS) {
    // 解析允许的域名列表
    const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
      .split(',')
      .map(domain => domain.trim())
      .filter(domain => domain.length > 0);

    // 检查请求来源是否在允许列表中
    if (origin && allowedOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
      // 处理非浏览器请求（如Postman、curl等）
      res.header('Access-Control-Allow-Origin', allowedOrigins[0] || '*');
    } else {
      // 不在允许列表中的域名，拒绝访问
      console.warn(`CORS: Blocked request from unauthorized origin: ${origin}`);
      res.header('Access-Control-Allow-Origin', 'null');
    }
  } else {
    // 开发环境或未配置CORS_ALLOWED_ORIGINS时，允许所有域名
    res.header('Access-Control-Allow-Origin', origin || '*');

    // 开发环境提示
    if (!isProduction) {
      console.log(`CORS: Development mode - allowing all origins (current: ${origin || 'none'})`);
    }
  }

  // 设置其他CORS头部（保持原有配置）
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24小时

  // 处理预检请求
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
}

module.exports = corsMiddleware;
