/**
 * 健康检查器接口定义
 * 定义节点健康检查的标准接口
 */
class IHealthChecker {
  /**
   * 检查单个节点的健康状态
   * @param {string} nodeId - 节点ID
   * @param {Object} options - 检查选项
   * @returns {Promise<Object>} 健康检查结果
   */
  async checkNodeHealth(nodeId, options = {}) {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 批量检查多个节点的健康状态
   * @param {Array<string>} nodeIds - 节点ID列表
   * @param {Object} options - 检查选项
   * @returns {Promise<Map<string, Object>>} 健康检查结果映射
   */
  async checkMultipleNodes(nodeIds, options = {}) {
    const results = new Map();
    
    for (const nodeId of nodeIds) {
      try {
        const result = await this.checkNodeHealth(nodeId, options);
        results.set(nodeId, result);
      } catch (error) {
        results.set(nodeId, {
          healthy: false,
          error: error.message,
          timestamp: Date.now()
        });
      }
    }
    
    return results;
  }
  
  /**
   * 启动定期健康检查
   * @param {Array<string>} nodeIds - 要监控的节点ID列表
   * @param {number} interval - 检查间隔（毫秒）
   * @param {Function} callback - 结果回调函数
   * @returns {Object} 监控控制器
   */
  startPeriodicCheck(nodeIds, interval = 30000, callback = null) {
    const controller = {
      running: true,
      intervalId: null
    };
    
    const performCheck = async () => {
      if (!controller.running) return;
      
      try {
        const results = await this.checkMultipleNodes(nodeIds);
        if (callback) {
          callback(results);
        }
      } catch (error) {
        console.error('[HEALTH-CHECKER] Periodic check failed:', error);
      }
    };
    
    // 立即执行一次检查
    performCheck();
    
    // 设置定期检查
    controller.intervalId = setInterval(performCheck, interval);
    
    // 返回控制器
    controller.stop = () => {
      controller.running = false;
      if (controller.intervalId) {
        clearInterval(controller.intervalId);
        controller.intervalId = null;
      }
    };
    
    return controller;
  }
  
  /**
   * 获取健康检查统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      totalChecks: 0,
      successfulChecks: 0,
      failedChecks: 0,
      averageResponseTime: 0,
      lastCheckTime: null
    };
  }
}

module.exports = { IHealthChecker };
