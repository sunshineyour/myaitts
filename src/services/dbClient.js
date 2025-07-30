const { Pool } = require('pg');

class DatabaseClient {
  constructor() {
    // 根据环境动态配置连接池
    const isProduction = process.env.NODE_ENV === 'production';

    // 获取配置参数（优先使用环境变量，否则使用默认值）
    const poolConfig = {
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.DB_POOL_MAX) || (isProduction ? 50 : 20),
      min: parseInt(process.env.DB_POOL_MIN) || (isProduction ? 5 : 2),
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT) || 30000,
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 5000,
      acquireTimeoutMillis: parseInt(process.env.DB_ACQUIRE_TIMEOUT) || 60000,
    };

    // 生产环境启用SSL
    if (isProduction && process.env.DB_SSL_ENABLED === 'true') {
      poolConfig.ssl = { rejectUnauthorized: false };
    }

    this.pool = new Pool(poolConfig);

    // 连接池事件监听
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });

    this.pool.on('connect', (client) => {
      if (process.env.DEBUG === 'true') {
        console.log('New database client connected');
      }
    });

    this.pool.on('remove', (client) => {
      if (process.env.DEBUG === 'true') {
        console.log('Database client removed');
      }
    });

    // 输出连接池配置信息
    console.log(`Database pool initialized: max=${poolConfig.max}, min=${poolConfig.min}, env=${process.env.NODE_ENV}`);
  }

  async query(text, params) {
    const start = Date.now();
    try {
      const res = await this.pool.query(text, params);
      const duration = Date.now() - start;
      if (process.env.DEBUG === 'true') {
        console.log('Executed query', { text, duration, rows: res.rowCount });
      }
      return res;
    } catch (error) {
      const duration = Date.now() - start;

      // 记录完整的数据库错误信息（仅用于日志）
      console.error('Database query error:', {
        text: text.substring(0, 100) + '...', // 截断长查询
        duration: `${duration}ms`,
        errorCode: error.code,
        errorMessage: error.message,
        constraint: error.constraint,
        detail: error.detail
      });

      // 创建安全的错误对象抛出
      const safeError = this.createSafeDatabaseError(error);
      throw safeError;
    }
  }

  /**
   * 创建安全的数据库错误
   * @param {Error} dbError - 原始数据库错误
   * @returns {Error} 安全的错误对象
   */
  createSafeDatabaseError(dbError) {
    const safeError = new Error();

    // 根据数据库错误码映射到安全的错误类型
    switch (dbError.code) {
      case '23505': // unique_violation
        safeError.name = 'ConflictError';
        safeError.message = '数据已存在，请检查后重试';
        safeError.code = 'DUPLICATE_ENTRY';
        break;

      case '23503': // foreign_key_violation
        safeError.name = 'ValidationError';
        safeError.message = '关联数据不存在，请检查输入';
        safeError.code = 'INVALID_REFERENCE';
        break;

      case '23502': // not_null_violation
        safeError.name = 'ValidationError';
        safeError.message = '必填字段不能为空';
        safeError.code = 'MISSING_REQUIRED_FIELD';
        break;

      case '23514': // check_violation
        safeError.name = 'ValidationError';
        safeError.message = '数据格式不符合要求';
        safeError.code = 'INVALID_DATA_FORMAT';
        break;

      case '42P01': // undefined_table
      case '42703': // undefined_column
        safeError.name = 'InternalError';
        safeError.message = '系统配置错误，请联系管理员';
        safeError.code = 'SYSTEM_CONFIG_ERROR';
        break;

      case '53300': // too_many_connections
        safeError.name = 'ServiceUnavailableError';
        safeError.message = '系统繁忙，请稍后重试';
        safeError.code = 'SERVICE_BUSY';
        break;

      case '57P01': // admin_shutdown
      case '57P02': // crash_shutdown
      case '57P03': // cannot_connect_now
        safeError.name = 'ServiceUnavailableError';
        safeError.message = '数据库服务暂时不可用，请稍后重试';
        safeError.code = 'DATABASE_UNAVAILABLE';
        break;

      default:
        // 未知数据库错误，使用通用错误
        safeError.name = 'DatabaseError';
        safeError.message = '数据库操作失败，请稍后重试';
        safeError.code = 'DATABASE_ERROR';
        break;
    }

    // 保留原始错误信息用于调试（仅在开发环境）
    if (process.env.NODE_ENV === 'development') {
      safeError.originalError = {
        code: dbError.code,
        message: dbError.message,
        detail: dbError.detail,
        constraint: dbError.constraint
      };
    }

    return safeError;
  }

  async getClient() {
    return await this.pool.connect();
  }

  async end() {
    await this.pool.end();
  }
}

module.exports = new DatabaseClient();
