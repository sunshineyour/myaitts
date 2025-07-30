#!/usr/bin/env node

/**
 * 代理网关使用示例
 * 展示如何在实际项目中使用新的代理网关功能
 * 包含混合健康检查策略的使用示例
 */

require('dotenv').config();

// 示例1: 使用智能音频生成函数（推荐）
async function example1_SmartTTSGeneration() {
  console.log('\n📝 示例1: 智能音频生成');
  console.log('=====================================');
  
  try {
    const { generateSpeechSmart } = require('../src/utils/ttsUtils');
    
    // 自动根据配置选择最佳网络模式
    const audioBuffer = await generateSpeechSmart(
      '这是一个智能代理网关测试示例。',
      'pNInz6obpgDQGcFmaJgB', // Adam voice
      'eleven_turbo_v2',
      0.5,
      0.75,
      0.5,
      1.0
    );
    
    console.log('✅ 音频生成成功');
    console.log(`   音频大小: ${audioBuffer.byteLength} bytes`);
    console.log(`   音频大小: ${(audioBuffer.byteLength / 1024).toFixed(2)} KB`);
    
  } catch (error) {
    console.error('❌ 音频生成失败:', error.message);
  }
}

// 示例2: 直接使用网络管理器
async function example2_NetworkManager() {
  console.log('\n🌐 示例2: 网络管理器使用');
  console.log('=====================================');
  
  try {
    const { networkManager } = require('../src/utils/networkManager');
    
    // 初始化网络管理器
    await networkManager.initialize();
    
    console.log('✅ 网络管理器初始化成功');
    console.log(`   当前模式: ${networkManager.getMode()}`);
    
    // 发起HTTP请求
    const response = await networkManager.get('https://httpbin.org/ip', {
      timeout: 10000
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ 网络请求成功');
      console.log(`   客户端IP: ${data.origin}`);
    }
    
    // 获取统计信息
    const stats = await networkManager.getStats();
    console.log('📊 网络统计:');
    console.log(`   总请求数: ${stats.manager.totalRequests}`);
    console.log(`   成功率: ${((stats.manager.successfulRequests / stats.manager.totalRequests) * 100).toFixed(2)}%`);
    
  } catch (error) {
    console.error('❌ 网络管理器使用失败:', error.message);
  }
}

// 示例3: 使用代理网关核心功能
async function example3_ProxyGateway() {
  console.log('\n🚪 示例3: 代理网关核心功能');
  console.log('=====================================');
  
  try {
    const { createProxyGateway } = require('../src/gateway');
    
    // 创建代理网关实例
    const gateway = createProxyGateway();
    await gateway.initialize();
    
    console.log('✅ 代理网关初始化成功');
    
    // 获取网络客户端
    const networkClient = gateway.getNetworkClient();
    console.log(`   网络模式: ${networkClient.getMode()}`);
    
    // 执行健康检查
    const isHealthy = await networkClient.healthCheck();
    console.log(`   健康状态: ${isHealthy ? '健康' : '异常'}`);
    
    // 获取统计信息
    const stats = await gateway.getStats();
    console.log('📊 网关统计:');
    console.log(`   运行时间: ${Math.round(stats.gateway.uptime / 1000)}秒`);
    console.log(`   总请求数: ${stats.gateway.totalRequests}`);
    
    // 清理资源
    await gateway.stop();
    
  } catch (error) {
    console.error('❌ 代理网关使用失败:', error.message);
  }
}

// 示例4: 网络模式切换
async function example4_ModeSwitching() {
  console.log('\n🔄 示例4: 网络模式切换');
  console.log('=====================================');
  
  try {
    const { networkManager } = require('../src/utils/networkManager');
    
    await networkManager.initialize();
    
    const originalMode = networkManager.getMode();
    console.log(`   原始模式: ${originalMode}`);
    
    // 切换到不同模式（仅演示，实际使用需要相应的配置）
    const modes = ['direct', 'proxy', 'fallback'];
    
    for (const mode of modes) {
      try {
        console.log(`   尝试切换到: ${mode}`);
        await networkManager.switchMode(mode);
        console.log(`   ✅ 成功切换到: ${networkManager.getMode()}`);
        
        // 测试新模式
        const isHealthy = await networkManager.healthCheck();
        console.log(`   健康检查: ${isHealthy ? '通过' : '失败'}`);
        
      } catch (error) {
        console.log(`   ❌ 切换失败: ${error.message}`);
      }
    }
    
    // 恢复原始模式
    await networkManager.switchMode(originalMode);
    console.log(`   恢复到原始模式: ${networkManager.getMode()}`);
    
  } catch (error) {
    console.error('❌ 模式切换失败:', error.message);
  }
}

// 示例5: 配置管理
async function example5_ConfigManagement() {
  console.log('\n⚙️  示例5: 配置管理');
  console.log('=====================================');
  
  try {
    const { configAdapter } = require('../src/gateway/adapters/ConfigAdapter');
    
    // 获取配置
    const config = configAdapter.getConfig();
    
    console.log('📋 当前配置:');
    console.log(`   网络模式: ${config.NETWORK_MODE}`);
    console.log(`   sing-box启用: ${config.ENABLE_SINGBOX_GATEWAY}`);
    console.log(`   代理启用: ${config.ENABLE_TTS_PROXY}`);
    console.log(`   降级启用: ${config.SINGBOX_FALLBACK_ENABLED}`);
    console.log(`   调试模式: ${config.SINGBOX_DEBUG}`);
    
    // 检查功能启用状态
    const features = ['gateway', 'fallback', 'auto_update', 'debug', 'stats'];
    console.log('\n🔧 功能状态:');
    features.forEach(feature => {
      const enabled = configAdapter.isEnabled(feature);
      console.log(`   ${feature}: ${enabled ? '启用' : '禁用'}`);
    });
    
    // 获取特定配置项
    console.log('\n📊 关键配置:');
    console.log(`   健康检查间隔: ${configAdapter.get('SINGBOX_HEALTH_CHECK_INTERVAL')}ms`);
    console.log(`   节点超时: ${configAdapter.get('SINGBOX_NODE_TIMEOUT')}ms`);
    console.log(`   最大重试次数: ${configAdapter.get('SINGBOX_MAX_RETRIES')}`);
    
  } catch (error) {
    console.error('❌ 配置管理失败:', error.message);
  }
}

// 示例6: 错误处理和降级
async function example6_ErrorHandling() {
  console.log('\n🛡️  示例6: 错误处理和降级');
  console.log('=====================================');
  
  try {
    const { generateSpeechSmart, generateSpeech } = require('../src/utils/ttsUtils');
    
    const testText = '测试错误处理和降级机制。';
    const voiceId = 'pNInz6obpgDQGcFmaJgB';
    
    console.log('🔄 测试智能降级机制...');
    
    try {
      // 使用智能函数（会自动处理错误和降级）
      const audioBuffer = await generateSpeechSmart(
        testText, voiceId, 'eleven_turbo_v2', 0.5, 0.75, 0.5, 1.0
      );
      
      console.log('✅ 智能函数成功');
      console.log(`   音频大小: ${(audioBuffer.byteLength / 1024).toFixed(2)} KB`);
      
    } catch (smartError) {
      console.log('⚠️  智能函数失败，尝试传统函数...');
      
      try {
        // 降级到传统函数
        const audioBuffer = await generateSpeech(
          testText, voiceId, 'eleven_turbo_v2', 0.5, 0.75, 0.5, 1.0
        );
        
        console.log('✅ 传统函数成功（降级成功）');
        console.log(`   音频大小: ${(audioBuffer.byteLength / 1024).toFixed(2)} KB`);
        
      } catch (fallbackError) {
        console.log('❌ 所有方法都失败了');
        console.log(`   智能函数错误: ${smartError.message}`);
        console.log(`   传统函数错误: ${fallbackError.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ 错误处理测试失败:', error.message);
  }
}

// 主函数：运行所有示例
async function runAllExamples() {
  console.log('🚀 代理网关使用示例演示');
  console.log('=====================================');
  console.log('本示例将演示如何使用新集成的代理网关功能');
  
  try {
    await example1_SmartTTSGeneration();
    await example2_NetworkManager();
    await example3_ProxyGateway();
    await example4_ModeSwitching();
    await example5_ConfigManagement();
    await example6_ErrorHandling();
    
    console.log('\n🎉 所有示例演示完成！');
    console.log('=====================================');
    console.log('💡 提示:');
    console.log('   - 在生产环境中，建议使用 generateSpeechSmart() 函数');
    console.log('   - 通过环境变量配置网络模式和代理设置');
    console.log('   - 定期检查 /api/gateway/stats 获取系统状态');
    console.log('   - 启用 SINGBOX_DEBUG=true 获取详细日志');
    
  } catch (error) {
    console.error('💥 示例演示失败:', error.message);
  }
}

// 如果直接运行此文件，执行所有示例
if (require.main === module) {
  runAllExamples().catch(error => {
    console.error('💥 示例执行失败:', error);
    process.exit(1);
  });
}

// 示例7: 健康检查策略监控
async function example7_HealthCheckStrategy() {
  console.log('\n🏥 示例7: 健康检查策略监控');
  console.log('=====================================');

  try {
    const { ProxyGateway } = require('../src/gateway/core/ProxyGateway');
    const { ConfigAdapter } = require('../src/gateway/adapters/ConfigAdapter');

    // 初始化配置
    const configAdapter = new ConfigAdapter();
    const config = configAdapter.initialize();

    // 创建代理网关
    const gateway = new ProxyGateway(config);
    await gateway.initialize();

    console.log('✅ 代理网关初始化成功');

    // 获取工作池控制器
    const controller = gateway.getSingboxController();

    if (controller && typeof controller.getQuarantinedNodes === 'function') {
      // 显示当前隔离池状态
      const quarantinedNodes = controller.getQuarantinedNodes();
      const quarantineStats = controller.getQuarantineStats();

      console.log('\n📊 隔离池状态:');
      console.log(`   总隔离节点: ${quarantineStats.total}`);
      console.log(`   临时隔离: ${quarantineStats.temporary}`);
      console.log(`   永久隔离: ${quarantineStats.permanent}`);

      if (quarantinedNodes.length > 0) {
        console.log('\n🏥 隔离节点详情:');
        quarantinedNodes.forEach(node => {
          console.log(`   - ${node.nodeTag}: ${node.quarantineType} (${node.reason})`);
          console.log(`     连续失败: ${node.consecutiveFailures}, 连续成功: ${node.consecutiveSuccesses}`);
        });
      } else {
        console.log('   🎉 当前没有隔离节点');
      }

      // 显示系统状态
      const status = gateway.getStatus();
      console.log('\n⚙️ 系统状态:');
      console.log(`   健康检查运行: ${status.healthCheckRunning ? '✅' : '❌'}`);
      console.log(`   隔离池检查运行: ${status.quarantineCheckRunning ? '✅' : '❌'}`);
      console.log(`   隔离池检查间隔: ${status.quarantineCheckInterval}ms`);

      // 演示手动节点管理
      console.log('\n🔧 手动节点管理演示:');

      // 获取健康节点列表
      const healthyNodes = await controller.getAvailableNodes();
      if (healthyNodes.length > 0) {
        const testNode = healthyNodes[0];
        console.log(`   测试节点: ${testNode}`);

        // 模拟节点故障
        console.log('   模拟节点故障...');
        await controller.markNodeFailed(testNode, 'Demo: simulated failure');

        // 检查隔离状态
        const isHealthy = await controller.isNodeHealthy(testNode);
        console.log(`   节点健康状态: ${isHealthy ? '健康' : '隔离'}`);

        // 模拟节点恢复
        console.log('   模拟节点恢复...');
        const recovered = await controller.markNodeHealthy(testNode, true); // 强制恢复
        console.log(`   恢复结果: ${recovered ? '成功' : '需要更多成功检查'}`);
      }

    } else {
      console.log('⚠️ 当前不是工作池模式，健康检查策略功能不可用');
    }

    // 清理
    await gateway.stop();

  } catch (error) {
    console.error('❌ 健康检查策略示例失败:', error.message);
  }
}

// 示例8: 隔离池恢复策略测试
async function example8_QuarantineRecovery() {
  console.log('\n🔄 示例8: 隔离池恢复策略测试');
  console.log('=====================================');

  try {
    const { WorkerPoolController } = require('../src/gateway/core/WorkerPoolController');
    const { LoggerAdapter } = require('../src/gateway/adapters/LoggerAdapter');

    // 创建测试配置
    const testConfig = {
      SINGBOX_QUARANTINE_RECOVERY_THRESHOLD: 2,
      SINGBOX_QUARANTINE_PERMANENT_RECOVERY_THRESHOLD: 3,
      SINGBOX_QUARANTINE_ENABLE_PERMANENT_RECOVERY: true
    };

    const logger = new LoggerAdapter('RECOVERY-TEST');
    const controller = new WorkerPoolController(testConfig, logger);

    // 模拟节点
    controller.allNodes = new Set(['test-node-1', 'test-node-2']);
    controller.healthyNodeTags = new Set(['test-node-1', 'test-node-2']);

    console.log('✅ 测试控制器初始化成功');

    // 测试临时隔离恢复
    console.log('\n🧪 测试临时隔离恢复:');
    controller.moveNodeToQuarantine('test-node-1', 'Network timeout');

    // 模拟健康检查成功
    let recovered = await controller.markNodeHealthy('test-node-1');
    console.log(`   第1次恢复尝试: ${recovered ? '成功' : '需要更多成功'}`);

    recovered = await controller.markNodeHealthy('test-node-1');
    console.log(`   第2次恢复尝试: ${recovered ? '成功' : '需要更多成功'}`);

    // 测试永久隔离恢复
    console.log('\n🧪 测试永久隔离恢复:');
    controller.moveNodeToQuarantine('test-node-2', 'HTTP 403 quota_exceeded');

    for (let i = 1; i <= 3; i++) {
      recovered = await controller.markNodeHealthy('test-node-2');
      console.log(`   第${i}次恢复尝试: ${recovered ? '成功' : '需要更多成功'}`);
    }

    // 显示最终状态
    const finalStats = controller.getQuarantineStats();
    console.log('\n📊 最终隔离池状态:');
    console.log(`   总隔离节点: ${finalStats.total}`);

  } catch (error) {
    console.error('❌ 隔离池恢复测试失败:', error.message);
  }
}

async function runAllExamples() {
  console.log('🚀 运行所有代理网关示例...\n');

  await example1_SmartTTSGeneration();
  await example2_NetworkManager();
  await example3_ProxyGateway();
  await example4_ModeSwitching();
  await example5_ConfigManagement();
  await example6_ErrorHandling();
  await example7_HealthCheckStrategy();
  await example8_QuarantineRecovery();

  console.log('\n🎉 所有示例运行完成!');
}

// 如果直接运行此文件，执行所有示例
if (require.main === module) {
  runAllExamples().catch(console.error);
}

module.exports = {
  example1_SmartTTSGeneration,
  example2_NetworkManager,
  example3_ProxyGateway,
  example4_ModeSwitching,
  example5_ConfigManagement,
  example6_ErrorHandling,
  example7_HealthCheckStrategy,
  example8_QuarantineRecovery,
  runAllExamples
};
