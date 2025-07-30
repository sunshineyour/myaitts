/**
 * 代理提供者接口定义
 * 定义代理节点管理的标准接口
 */
class IProxyProvider {
  /**
   * 获取可用代理节点列表
   * @returns {Promise<Array<string>>} 代理节点ID列表
   */
  async getAvailableNodes() {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 获取当前使用的节点
   * @returns {Promise<string|null>} 当前节点ID
   */
  async getCurrentNode() {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 切换到指定节点
   * @param {string} nodeId - 节点ID
   * @returns {Promise<boolean>} 切换结果
   */
  async switchToNode(nodeId) {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 标记节点为失败状态
   * @param {string} nodeId - 节点ID
   * @param {string} reason - 失败原因
   * @returns {Promise<void>}
   */
  async markNodeFailed(nodeId, reason = 'Unknown error') {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 恢复节点为健康状态
   * @param {string} nodeId - 节点ID
   * @returns {Promise<void>}
   */
  async markNodeHealthy(nodeId) {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 获取节点健康状态
   * @param {string} nodeId - 节点ID
   * @returns {Promise<boolean>} 健康状态
   */
  async isNodeHealthy(nodeId) {
    throw new Error('Method must be implemented by subclass');
  }
  
  /**
   * 获取代理统计信息
   * @returns {Promise<Object>} 统计信息
   */
  async getStats() {
    return {
      totalNodes: 0,
      healthyNodes: 0,
      failedNodes: 0,
      currentNode: null,
      switchCount: 0,
      lastSwitchTime: null
    };
  }
}

module.exports = { IProxyProvider };
