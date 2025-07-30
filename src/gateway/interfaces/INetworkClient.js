/**
 * 网络客户端接口定义
 * 提供统一的网络请求抽象，支持多种网络模式
 */
class INetworkClient {
  /**
   * 发起网络请求的统一接口
   * @param {Object} options - 请求选项
   * @param {string} options.url - 请求URL
   * @param {string} options.method - HTTP方法
   * @param {Object} options.headers - 请求头
   * @param {string|Object} options.body - 请求体
   * @param {number} options.timeout - 超时时间
   * @returns {Promise<Response>} 响应结果
   */
  async request(options) {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 获取当前网络模式
   * @returns {string} 网络模式 (direct|proxy|gateway)
   */
  getMode() {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 健康检查
   * @returns {Promise<boolean>} 健康状态
   */
  async healthCheck() {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 获取网络统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      mode: this.getMode(),
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRequestTime: null
    };
  }
}

module.exports = { INetworkClient };
