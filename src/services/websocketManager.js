const { v4: uuidv4 } = require('uuid');
const redisClient = require('./redisClient');
const ttsProcessor = require('./ttsProcessor');
const { verifyToken } = require('./authService');
const { createSafeWebSocketError, createSafeAuthFailure } = require('../utils/websocketErrorSecurity');

class WebSocketManager {
  constructor() {
    this.connections = new Map(); // taskId -> { ws: WebSocket, subscriber: RedisSubscriber, createdAt: timestamp }

    // 【新增】启动定期清理任务
    this.startCleanupTimer();
  }

  // 【新增】启动定期清理定时器
  startCleanupTimer() {
    // 每5分钟清理一次超时连接
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleConnections().catch(error => {
        console.error('[WEBSOCKET-MANAGER] Error during cleanup:', error);
      });
    }, 5 * 60 * 1000); // 5分钟

    console.log('[WEBSOCKET-MANAGER] Cleanup timer started');
  }

  // 【新增】停止清理定时器
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      console.log('[WEBSOCKET-MANAGER] Cleanup timer stopped');
    }
  }

  async handleConnection(ws, req) {
    const taskId = uuidv4();

    try {
      // 初始化任务状态
      await redisClient.setTaskData(taskId, {
        status: 'initialized',
        taskId,
        createdAt: Date.now()
      });

      // 订阅进度更新
      const subscriber = await redisClient.subscribeProgress(taskId, (progress) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: 'progress',
            ...progress
          }));

          // 【新增】检查任务完成或失败，主动关闭连接
          if (progress.type === 'complete' || progress.type === 'error') {
            console.log(`[WEBSOCKET-MANAGER] Task ${taskId} finished with type: ${progress.type}, scheduling connection close`);
            // 延迟关闭，确保消息已发送
            setTimeout(() => {
              this.closeConnection(taskId, 1000, `Task finished: ${progress.type}`);
            }, 100);
          }
        }
      });

      // 存储连接和相关信息
      this.connections.set(taskId, {
        ws: ws,
        subscriber: subscriber,
        createdAt: Date.now()
      });

      // 发送初始化消息
      ws.send(JSON.stringify({
        type: 'initialized',
        message: 'Connection successful. Task is ready to be started.',
        taskId
      }));

      // 处理消息
      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          await this.handleMessage(taskId, data, ws);
        } catch (error) {
          console.error('WebSocket message error:', error);

          // 使用安全错误处理
          const safeError = createSafeWebSocketError({
            name: 'ValidationError',
            message: 'Invalid message format',
            errorType: 'invalid_format'
          });

          ws.send(JSON.stringify(safeError));
        }
      });

      // 处理连接关闭
      ws.on('close', async () => {
        await this.cleanupConnection(taskId);
        console.log(`WebSocket closed for task ${taskId}`);
      });

      ws.on('error', (error) => {
        console.error(`WebSocket error for task ${taskId}:`, error);
        // 错误时也要清理连接
        this.cleanupConnection(taskId);
      });

    } catch (error) {
      console.error('WebSocket connection error:', error);
      ws.close(1011, 'Failed to initialize connection');
    }
  }

  async handleMessage(taskId, data, ws) {
    if (data.action === 'start') {
      // 验证token
      try {
        const username = await verifyToken(data.token);

        // 记录任务类型信息
        const taskType = data.taskType || 'single';
        console.log(`Starting ${taskType} TTS task ${taskId} for user ${username}`);

        // 更新任务状态，包含任务类型信息
        await redisClient.setTaskData(taskId, {
          ...data,
          status: 'processing',
          taskId,
          username,
          taskType,
          startedAt: Date.now()
        });

        // 调试日志：检查token传递
        console.log(`[WEBSOCKET-MANAGER] Starting TTS processing for taskId: ${taskId}`);
        console.log(`[WEBSOCKET-MANAGER] Token available: ${data.token ? 'YES' : 'NO'}`);
        console.log(`[WEBSOCKET-MANAGER] Token length: ${data.token ? data.token.length : 0}`);
        console.log(`[WEBSOCKET-MANAGER] Username: ${username}`);

        // 启动TTS处理 - 处理器内部会根据taskType分发，传递token用于生成带认证的downloadUrl
        // 注意：错误处理已在 ttsProcessor.start() 内部完成，包括详细的错误推送
        // 这里只需要记录日志，不需要重复推送错误消息到前端
        ttsProcessor.start(taskId, data, username, data.token).catch(async (error) => {
          console.error(`${taskType} TTS processing failed for task ${taskId}:`, error);

          // 只更新任务状态到Redis，不重复推送错误消息
          // 错误消息已经在 ttsProcessor 中通过 publishProgress 推送给前端
          await redisClient.setTaskData(taskId, {
            status: 'failed',
            error: error.message,
            taskType,
            failedAt: Date.now()
          });

          // 移除重复的错误推送 - 错误信息已在业务逻辑层推送
          // 前端会通过 Redis pub/sub 机制接收到完整的错误信息（包含 errorType 等）

          // 【新增】任务失败后延迟关闭连接
          setTimeout(() => {
            this.closeConnection(taskId, 1011, 'Task processing failed');
          }, 1000);
        });

      } catch (authError) {
        console.error(`Authentication failed for task ${taskId}:`, authError);

        // 使用安全的认证失败响应
        const safeAuthError = createSafeAuthFailure(authError);
        ws.send(JSON.stringify(safeAuthError));

        // 【新增】认证失败后关闭连接
        setTimeout(() => {
          this.closeConnection(taskId, 1008, 'Authentication failed');
        }, 100);
      }
    }
  }

  // 广播消息到特定任务
  async broadcast(taskId, message) {
    const connection = this.connections.get(taskId);
    if (connection && connection.ws && connection.ws.readyState === connection.ws.OPEN) {
      connection.ws.send(JSON.stringify(message));
    }
  }

  // 【新增】主动关闭WebSocket连接
  async closeConnection(taskId, code = 1000, reason = 'Normal closure') {
    const connection = this.connections.get(taskId);
    if (connection && connection.ws) {
      try {
        if (connection.ws.readyState === connection.ws.OPEN) {
          console.log(`[WEBSOCKET-MANAGER] Closing connection for task ${taskId}, code: ${code}, reason: ${reason}`);
          connection.ws.close(code, reason);
        }
      } catch (error) {
        console.error(`[WEBSOCKET-MANAGER] Error closing connection for task ${taskId}:`, error);
      }
    }
  }

  // 【新增】清理连接资源
  async cleanupConnection(taskId) {
    const connection = this.connections.get(taskId);
    if (connection) {
      try {
        // 断开Redis订阅
        if (connection.subscriber) {
          await connection.subscriber.disconnect();
        }
      } catch (error) {
        console.error(`[WEBSOCKET-MANAGER] Error disconnecting subscriber for task ${taskId}:`, error);
      }

      // 从连接映射中移除
      this.connections.delete(taskId);
      console.log(`[WEBSOCKET-MANAGER] Cleaned up connection for task ${taskId}`);
    }
  }

  // 【新增】清理超时连接
  async cleanupStaleConnections(maxAgeMs = 30 * 60 * 1000) { // 默认30分钟
    const now = Date.now();
    const staleConnections = [];

    for (const [taskId, connection] of this.connections.entries()) {
      if (now - connection.createdAt > maxAgeMs) {
        staleConnections.push(taskId);
      }
    }

    for (const taskId of staleConnections) {
      console.log(`[WEBSOCKET-MANAGER] Cleaning up stale connection for task ${taskId}`);
      await this.closeConnection(taskId, 1001, 'Connection timeout');
    }

    if (staleConnections.length > 0) {
      console.log(`[WEBSOCKET-MANAGER] Cleaned up ${staleConnections.length} stale connections`);
    }
  }

  // 【新增】获取连接统计信息
  getConnectionStats() {
    const totalConnections = this.connections.size;
    const now = Date.now();
    let activeConnections = 0;

    for (const [taskId, connection] of this.connections.entries()) {
      if (connection.ws && connection.ws.readyState === connection.ws.OPEN) {
        activeConnections++;
      }
    }

    return {
      total: totalConnections,
      active: activeConnections,
      inactive: totalConnections - activeConnections
    };
  }

  // 【新增】关闭所有连接（用于应用关闭时）
  async closeAllConnections(code = 1001, reason = 'Server shutdown') {
    const connectionIds = Array.from(this.connections.keys());
    console.log(`[WEBSOCKET-MANAGER] Closing ${connectionIds.length} connections due to: ${reason}`);

    const closePromises = connectionIds.map(taskId =>
      this.closeConnection(taskId, code, reason)
    );

    await Promise.allSettled(closePromises);
    console.log(`[WEBSOCKET-MANAGER] All connections closed`);
  }
}

module.exports = new WebSocketManager();
