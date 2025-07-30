const IORedis = require('ioredis');

class RedisClient {
  constructor() {
    this.client = new IORedis(process.env.REDIS_URL, {
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    this.client.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    this.client.on('connect', () => {
      console.log('Redis connected');
    });

    this.client.on('ready', () => {
      console.log('Redis ready');
    });
  }

  // 通用Redis操作方法
  async get(key) {
    return await this.client.get(key);
  }

  async set(key, value) {
    return await this.client.set(key, value);
  }

  async setex(key, seconds, value) {
    return await this.client.setex(key, seconds, value);
  }

  async del(key) {
    return await this.client.del(key);
  }

  // 任务状态管理
  async setTaskStatus(taskId, status) {
    const key = `tts:task:${taskId}`;
    await this.client.hset(key, 'status', status, 'updatedAt', Date.now());
    await this.client.expire(key, 24 * 60 * 60); // 24小时过期
  }

  async getTaskStatus(taskId) {
    const key = `tts:task:${taskId}`;
    return await this.client.hgetall(key);
  }

  async setTaskData(taskId, data) {
    const key = `tts:task:${taskId}`;
    const serializedData = {};
    for (const [field, value] of Object.entries(data)) {
      serializedData[field] = typeof value === 'object' ? JSON.stringify(value) : value;
    }
    await this.client.hset(key, serializedData);
    await this.client.expire(key, 24 * 60 * 60);
  }

  // 进度更新发布
  async publishProgress(taskId, progress) {
    await this.client.publish(`tts:progress:${taskId}`, JSON.stringify(progress));
  }

  // 订阅进度更新
  async subscribeProgress(taskId, callback) {
    const subscriber = this.client.duplicate();
    await subscriber.subscribe(`tts:progress:${taskId}`);
    subscriber.on('message', (channel, message) => {
      if (channel === `tts:progress:${taskId}`) {
        callback(JSON.parse(message));
      }
    });
    return subscriber;
  }

  async disconnect() {
    await this.client.disconnect();
  }
}

module.exports = new RedisClient();
