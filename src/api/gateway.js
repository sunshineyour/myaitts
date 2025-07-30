const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

/**
 * 代理网关管理API
 * 提供网关状态查询、统计信息和管理功能
 */

/**
 * GET /api/gateway/status
 * 获取代理网关状态
 */
router.get('/status', async (req, res) => {
  try {
    const { networkManager } = require('../utils/networkManager');
    
    // 获取网络管理器状态
    const status = networkManager.getStatus();
    
    // 获取配置信息
    const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
    const config = configAdapter.getConfig();
    
    const response = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      networkManager: status,
      configuration: {
        networkMode: config.NETWORK_MODE,
        singboxEnabled: config.ENABLE_SINGBOX_GATEWAY,
        proxyEnabled: config.ENABLE_TTS_PROXY,
        fallbackEnabled: config.SINGBOX_FALLBACK_ENABLED,
        debugMode: config.SINGBOX_DEBUG,
        apiType: 'clash'
      },
      features: {
        gateway: config.ENABLE_SINGBOX_GATEWAY,
        healthCheck: config.SINGBOX_HEALTH_CHECK_INTERVAL > 0,
        autoUpdate: config.SINGBOX_AUTO_UPDATE,
        statistics: config.SINGBOX_ENABLE_STATS
      }
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Gateway status error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/gateway/stats
 * 获取代理网关统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    const { networkManager } = require('../utils/networkManager');
    
    // 获取详细统计信息
    const stats = await networkManager.getStats();
    
    // 计算成功率
    const successRate = stats.manager.totalRequests > 0 
      ? (stats.manager.successfulRequests / stats.manager.totalRequests * 100).toFixed(2)
      : 0;
    
    const response = {
      timestamp: new Date().toISOString(),
      summary: {
        totalRequests: stats.manager.totalRequests,
        successfulRequests: stats.manager.successfulRequests,
        failedRequests: stats.manager.failedRequests,
        successRate: `${successRate}%`,
        currentMode: stats.mode,
        initialized: stats.initialized
      },
      details: stats
    };
    
    res.json(response);
    
  } catch (error) {
    console.error('Gateway stats error:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/gateway/health-check
 * 执行健康检查
 */
router.post('/health-check', async (req, res) => {
  try {
    const { networkManager } = require('../utils/networkManager');
    
    const startTime = Date.now();
    const isHealthy = await networkManager.healthCheck();
    const duration = Date.now() - startTime;
    
    res.json({
      healthy: isHealthy,
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
      mode: networkManager.getMode()
    });
    
  } catch (error) {
    console.error('Gateway health check error:', error);
    res.status(500).json({
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/gateway/switch-mode
 * 切换网络模式（需要认证）
 */
router.post('/switch-mode', authMiddleware, async (req, res) => {
  try {
    const { mode } = req.body;
    const username = req.user.username;
    
    // 验证输入
    if (!mode) {
      return res.status(400).json({
        error: 'Network mode is required',
        validModes: ['direct', 'proxy', 'gateway', 'fallback']
      });
    }
    
    const validModes = ['direct', 'proxy', 'gateway', 'fallback'];
    if (!validModes.includes(mode)) {
      return res.status(400).json({
        error: `Invalid network mode: ${mode}`,
        validModes
      });
    }
    
    // 检查管理员权限
    const { checkAdminPermission } = require('../utils/helpers');
    await checkAdminPermission(username);
    
    const { networkManager } = require('../utils/networkManager');
    
    const oldMode = networkManager.getMode();
    await networkManager.switchMode(mode);
    const newMode = networkManager.getMode();
    
    console.log(`[GATEWAY-API] User ${username} switched network mode from ${oldMode} to ${newMode}`);
    
    res.json({
      success: true,
      oldMode,
      newMode,
      timestamp: new Date().toISOString(),
      switchedBy: username
    });
    
  } catch (error) {
    console.error('Gateway mode switch error:', error);
    
    if (error.message.includes('权限')) {
      res.status(403).json({
        error: '需要管理员权限才能切换网络模式',
        code: 'ADMIN_REQUIRED'
      });
    } else {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

/**
 * POST /api/gateway/reload
 * 重新加载配置（需要认证）
 */
router.post('/reload', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    
    // 检查管理员权限
    const { checkAdminPermission } = require('../utils/helpers');
    await checkAdminPermission(username);
    
    const { networkManager } = require('../utils/networkManager');
    
    await networkManager.reload();
    
    console.log(`[GATEWAY-API] User ${username} reloaded gateway configuration`);
    
    res.json({
      success: true,
      message: 'Gateway configuration reloaded successfully',
      timestamp: new Date().toISOString(),
      reloadedBy: username
    });
    
  } catch (error) {
    console.error('Gateway reload error:', error);
    
    if (error.message.includes('权限')) {
      res.status(403).json({
        error: '需要管理员权限才能重新加载配置',
        code: 'ADMIN_REQUIRED'
      });
    } else {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

/**
 * GET /api/gateway/nodes
 * 获取sing-box节点信息（需要认证）
 */
router.get('/nodes', authMiddleware, async (req, res) => {
  try {
    const username = req.user.username;
    
    // 检查管理员权限
    const { checkAdminPermission } = require('../utils/helpers');
    await checkAdminPermission(username);
    
    const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
    const config = configAdapter.getConfig();
    
    if (!config.ENABLE_SINGBOX_GATEWAY) {
      return res.status(400).json({
        error: 'sing-box gateway is not enabled',
        code: 'GATEWAY_DISABLED'
      });
    }
    
    const { SingboxController } = require('../gateway/core/SingboxController');
    const controller = new SingboxController(config);
    
    try {
      await controller.initialize();
      
      const availableNodes = await controller.getAvailableNodes();
      const currentNode = await controller.getCurrentNode();
      const stats = await controller.getStats();
      
      await controller.cleanup();
      
      res.json({
        currentNode,
        availableNodes,
        stats,
        timestamp: new Date().toISOString()
      });
      
    } catch (controllerError) {
      res.status(503).json({
        error: 'Failed to connect to sing-box',
        details: controllerError.message,
        code: 'SINGBOX_UNAVAILABLE'
      });
    }
    
  } catch (error) {
    console.error('Gateway nodes error:', error);
    
    if (error.message.includes('权限')) {
      res.status(403).json({
        error: '需要管理员权限才能查看节点信息',
        code: 'ADMIN_REQUIRED'
      });
    } else {
      res.status(500).json({
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

module.exports = router;
