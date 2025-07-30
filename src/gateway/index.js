/**
 * 代理网关模块统一导出
 * 提供高内聚低耦合的代理网关功能
 */

// 核心组件
const { ProxyGateway } = require('./core/ProxyGateway');
const { SingboxController } = require('./core/SingboxController');
const { WorkerPoolController } = require('./core/WorkerPoolController');

// 适配器
const { NetworkAdapter } = require('./adapters/NetworkAdapter');
const { ConfigAdapter, configAdapter } = require('./adapters/ConfigAdapter');
const { LoggerAdapter } = require('./adapters/LoggerAdapter');

// 接口定义
const { INetworkClient } = require('./interfaces/INetworkClient');
const { IProxyProvider } = require('./interfaces/IProxyProvider');
const { IHealthChecker } = require('./interfaces/IHealthChecker');

/**
 * 创建代理网关实例的工厂函数
 * @param {Object} config - 配置对象
 * @param {Object} logger - 日志对象
 * @returns {ProxyGateway} 代理网关实例
 */
function createProxyGateway(config = null, logger = null) {
  const gatewayConfig = config || configAdapter.getConfig();
  const gatewayLogger = logger || new LoggerAdapter('GATEWAY-FACTORY');
  
  return new ProxyGateway(gatewayConfig, gatewayLogger);
}

/**
 * 创建网络适配器实例的工厂函数
 * @param {string} mode - 网络模式
 * @param {Object} config - 配置对象
 * @param {Object} proxyProvider - 代理提供者
 * @param {Object} logger - 日志对象
 * @returns {NetworkAdapter} 网络适配器实例
 */
function createNetworkAdapter(mode = 'direct', config = null, proxyProvider = null, logger = null) {
  const adapterConfig = config || configAdapter.getConfig();
  adapterConfig.NETWORK_MODE = mode;
  
  const adapterLogger = logger || new LoggerAdapter('ADAPTER-FACTORY');
  
  return new NetworkAdapter(adapterConfig, proxyProvider, adapterLogger);
}

/**
 * 创建sing-box控制器实例的工厂函数
 * @param {Object} config - 配置对象
 * @param {Object} logger - 日志对象
 * @returns {SingboxController} sing-box控制器实例
 */
function createSingboxController(config = null, logger = null) {
  const controllerConfig = config || configAdapter.getConfig();
  const controllerLogger = logger || new LoggerAdapter('CONTROLLER-FACTORY');
  
  return new SingboxController(controllerConfig, controllerLogger);
}

/**
 * 获取默认配置
 * @returns {Object} 默认配置对象
 */
function getDefaultConfig() {
  return configAdapter.getConfig();
}

/**
 * 检查功能是否可用
 * @param {string} feature - 功能名称
 * @returns {boolean} 功能可用性
 */
function isFeatureAvailable(feature) {
  try {
    return configAdapter.isEnabled(feature);
  } catch (error) {
    return false;
  }
}

/**
 * 获取模块版本信息
 * @returns {Object} 版本信息
 */
function getVersion() {
  return {
    version: '1.0.0',
    name: 'ProxyGateway',
    description: 'High-availability API proxy gateway with sing-box integration',
    author: 'TTS Team',
    features: [
      'sing-box integration',
      'intelligent node switching',
      'health monitoring',
      'multiple network modes',
      'fallback mechanisms'
    ]
  };
}

/**
 * 模块健康检查
 * @returns {Promise<Object>} 健康状态
 */
async function healthCheck() {
  const status = {
    healthy: true,
    timestamp: new Date().toISOString(),
    components: {}
  };
  
  try {
    // 检查配置
    const config = configAdapter.getConfig();
    status.components.config = {
      healthy: true,
      mode: config.NETWORK_MODE,
      gatewayEnabled: config.ENABLE_SINGBOX_GATEWAY
    };
  } catch (error) {
    status.healthy = false;
    status.components.config = {
      healthy: false,
      error: error.message
    };
  }
  
  // 检查sing-box连接（如果启用）
  if (isFeatureAvailable('gateway')) {
    try {
      const controller = createSingboxController();
      await controller.initialize();
      
      status.components.singbox = {
        healthy: true,
        nodes: await controller.getAvailableNodes()
      };
      
      await controller.cleanup();
    } catch (error) {
      status.healthy = false;
      status.components.singbox = {
        healthy: false,
        error: error.message
      };
    }
  }
  
  return status;
}

// 导出所有组件和工具函数
module.exports = {
  // 核心组件
  ProxyGateway,
  SingboxController,
  WorkerPoolController,
  
  // 适配器
  NetworkAdapter,
  ConfigAdapter,
  LoggerAdapter,
  configAdapter,
  
  // 接口
  INetworkClient,
  IProxyProvider,
  IHealthChecker,
  
  // 工厂函数
  createProxyGateway,
  createNetworkAdapter,
  createSingboxController,
  
  // 工具函数
  getDefaultConfig,
  isFeatureAvailable,
  getVersion,
  healthCheck
};
