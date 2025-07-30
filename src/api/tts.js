const express = require('express');
const router = express.Router();
const { verifyToken } = require('../services/authService');
const redisClient = require('../services/redisClient');
const { validateTTSParams, validateDialogueTTSParams } = require('../utils/validators');
const path = require('path');
const fs = require('fs');

// 获取任务状态
router.get('/status/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    await verifyToken(token); // 验证token

    const taskData = await redisClient.getTaskStatus(taskId);

    if (!taskData || Object.keys(taskData).length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json({
      taskId,
      status: taskData.status,
      progress: taskData.progress || '',
      downloadUrl: taskData.downloadUrl || null,
      error: taskData.error || null,
      createdAt: taskData.createdAt ? parseInt(taskData.createdAt) : null,
      completedAt: taskData.completedAt ? parseInt(taskData.completedAt) : null
    });
  } catch (error) {
    console.error('Get status error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// 音频流媒体播放端点 - 专用于浏览器内播放
router.get('/stream/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    // 优先使用Authorization header，提高安全性
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

    console.log(`[STREAM] Request for taskId: ${taskId}, token source: ${req.headers.authorization ? 'header' : 'query'}`);

    if (!token) {
      console.log(`[STREAM] Missing token for taskId: ${taskId}`);
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token); // 验证token并获取用户名
    console.log(`[STREAM] Token verified for user: ${username}, taskId: ${taskId}`);

    const filePath = path.join(process.env.AUDIO_STORAGE_PATH, `${taskId}.mp3`);
    console.log(`[STREAM] Checking file path: ${filePath}`);

    if (!fs.existsSync(filePath)) {
      console.log(`[STREAM] File not found: ${filePath}`);
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const stat = fs.statSync(filePath);
    console.log(`[STREAM] File found, size: ${stat.size} bytes`);

    // 设置CORS头，允许跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    // 播放专用响应头
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'inline; filename="audio.mp3"');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // 1小时缓存
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // 支持Range请求（断点续传）- 播放优化
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = (end - start) + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunksize);

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }

  } catch (error) {
    console.error('Stream error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// 音频文件下载端点 - 专用于文件下载
router.get('/download/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    // 优先使用Authorization header，提高安全性
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;

    console.log(`[DOWNLOAD] Request for taskId: ${taskId}, token source: ${req.headers.authorization ? 'header' : 'query'}`);

    if (!token) {
      console.log(`[DOWNLOAD] Missing token for taskId: ${taskId}`);
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token); // 验证token并获取用户名
    console.log(`[DOWNLOAD] Token verified for user: ${username}, taskId: ${taskId}`);

    const filePath = path.join(process.env.AUDIO_STORAGE_PATH, `${taskId}.mp3`);
    console.log(`[DOWNLOAD] Checking file path: ${filePath}`);

    if (!fs.existsSync(filePath)) {
      console.log(`[DOWNLOAD] File not found: ${filePath}`);
      return res.status(404).json({ error: 'Audio file not found' });
    }

    const stat = fs.statSync(filePath);
    console.log(`[DOWNLOAD] File found, size: ${stat.size} bytes`);

    // 生成带时间戳的文件名
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const fileName = `tts_${year}${month}${day}_${hours}${minutes}${seconds}.mp3`;

    // 设置CORS头，允许跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    // 下载专用响应头
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Length', stat.size);

    // 完整文件传输（下载不需要Range支持）
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// 处理OPTIONS预检请求
router.options('/stream/:taskId', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.status(200).end();
});

router.options('/download/:taskId', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.status(200).end();
});

// 获取语音列表（从数据库获取）
router.get('/voices', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    await verifyToken(token); // 验证token

    const dbClient = require('../services/dbClient');
    const result = await dbClient.query(
      'SELECT voice_name, voice_id, model_support FROM voice_mappings WHERE is_active = true ORDER BY voice_name'
    );

    const voices = result.rows.map(row => ({
      name: row.voice_name,
      id: row.voice_id,
      models: row.model_support || []
    }));

    res.json({
      voices: voices,
      total: voices.length
    });
  } catch (error) {
    console.error('Get voices error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// 验证TTS参数（用于前端预检查）
router.post('/validate', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    await verifyToken(token); // 验证token

    const { taskType, ...params } = req.body;

    let validation;
    if (taskType === 'dialogue') {
      validation = validateDialogueTTSParams(params);
    } else {
      validation = validateTTSParams(params);
    }

    if (!validation.isValid) {
      return res.status(400).json({
        valid: false,
        errors: validation.errors
      });
    }

    // 计算预估字符数
    let estimatedChars = 0;
    if (taskType === 'dialogue' && params.dialogue) {
      estimatedChars = params.dialogue.reduce((total, item) => total + (item.text?.length || 0), 0);
    } else if (params.input) {
      estimatedChars = params.input.length;
    }

    res.json({
      valid: true,
      estimatedChars: estimatedChars,
      message: 'Parameters are valid'
    });
  } catch (error) {
    console.error('Validate TTS params error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// 获取用户的TTS历史记录
router.get('/history', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const username = await verifyToken(token);

    const { limit = 20, offset = 0 } = req.query;
    const limitNum = Math.min(parseInt(limit), 100); // 最大100条
    const offsetNum = Math.max(parseInt(offset), 0);

    const dbClient = require('../services/dbClient');
    const result = await dbClient.query(
      'SELECT task_id, status, task_data, result_data, created_at, completed_at FROM task_status WHERE username = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [username, limitNum, offsetNum]
    );

    const history = result.rows.map(row => ({
      taskId: row.task_id,
      status: row.status,
      taskData: row.task_data || {},
      resultData: row.result_data || {},
      createdAt: row.created_at,
      completedAt: row.completed_at
    }));

    // 获取总数
    const countResult = await dbClient.query(
      'SELECT COUNT(*) FROM task_status WHERE username = $1',
      [username]
    );
    const total = parseInt(countResult.rows[0].count);

    res.json({
      history: history,
      pagination: {
        total: total,
        limit: limitNum,
        offset: offsetNum,
        hasMore: offsetNum + limitNum < total
      }
    });
  } catch (error) {
    console.error('Get TTS history error:', error);
    if (error.message.includes('Token') || error.message.includes('Invalid')) {
      res.status(401).json({ error: 'Authentication failed' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

module.exports = router;
