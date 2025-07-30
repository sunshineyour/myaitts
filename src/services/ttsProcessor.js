const redisClient = require('./redisClient');
const { splitText, processChunks, storeAudioFile, combineAudio, getVoiceId } = require('../utils/ttsUtils');
const { checkVip, updateUserUsage } = require('./authService');
const { generateDateBasedFilename } = require('../utils/helpers');
const { createSafeWebSocketError } = require('../utils/websocketErrorSecurity');
const path = require('path');
const fs = require('fs').promises;

class TtsProcessor {
  // 根据任务类型分发处理逻辑
  async start(taskId, taskData, username, token = null) {
    try {
      // 根据taskType分发到不同的处理方法
      if (taskData.taskType === 'dialogue') {
        return await this.startDialogue(taskId, taskData, username, token);
      } else {
        return await this.startSingle(taskId, taskData, username, token);
      }
    } catch (error) {
      console.error(`TTS processing failed for task ${taskId}:`, error);

      // 【新增】优先检查是否为内容违规错误
      if (error.isContentViolation) {
        console.warn(`[VIOLATION-DETECTED] Content violation in task ${taskId}:`, error.message);

        const violationStatus = {
          status: 'content_violation_failed',
          error: error.message,
          errorType: 'content_violation',
          isRetryable: false,
          username: username,
          failedAt: Date.now()
        };

        await redisClient.setTaskData(taskId, violationStatus);

        // 内容违规错误保留原始消息（用户需要知道具体违规原因）
        await this.publishProgress(taskId, {
          type: 'error',
          message: error.message, // 直接使用原始的违规消息
          errorType: 'content_violation',
          isRetryable: false
        });

        throw error; // 直接抛出，不执行其他重试逻辑
      }

      // 【增强】非违规错误的安全处理
      const safeError = createSafeWebSocketError(error, {
        preserveContentViolation: false,
        isDevelopment: process.env.NODE_ENV === 'development'
      });

      const errorStatus = {
        status: 'failed',
        error: safeError.message, // 使用安全的错误消息
        errorType: safeError.errorType,
        username: username,
        failedAt: Date.now()
      };

      await redisClient.setTaskData(taskId, errorStatus);
      await this.publishProgress(taskId, safeError);

      // 创建安全的错误对象抛出
      const safeErrorToThrow = new Error(safeError.message);
      safeErrorToThrow.name = error.name;
      safeErrorToThrow.code = safeError.errorType;
      throw safeErrorToThrow;
    }
  }

  // 普通TTS处理逻辑
  async startSingle(taskId, taskData, username, token = null) {
    // 用户进度：开始处理
    await this.publishProgress(taskId, '正在处理...', { userMessage: '正在处理...', percentage: 10 });

    // 内部进度：任务初始化
    await this.publishProgress(taskId, '任务初始化...', { internal: true });

    // 检查VIP权限和配额 - 普通TTS需要STANDARD权限
    const charCount = taskData.input.length;
    await checkVip(username, 'STANDARD', charCount);

    // 获取语音ID
    const voiceId = await getVoiceId(taskData.voice);

    // 内部进度：文本分割
    await this.publishProgress(taskId, '文本分割中...', { internal: true });
    const chunks = await splitText(taskData.input);
    await this.publishProgress(taskId, `文本已分割为 ${chunks.length} 个片段`, { internal: true });

    // 用户进度：开始生成音频
    await this.publishProgress(taskId, '生成中...', { userMessage: '生成中...', percentage: 50 });

    // 内部进度：音频生成详情
    await this.publishProgress(taskId, `正在生成 ${chunks.length} 个音频片段...`, { internal: true });
    const audioDataList = await processChunks(
      chunks,
      voiceId,
      taskData.model || 'eleven_turbo_v2',
      taskData.stability,
      taskData.similarity_boost,
      taskData.style,
      taskData.speed,
      { taskId, username }
    );

    // 用户进度：即将完成
    await this.publishProgress(taskId, '即将完成...', { userMessage: '即将完成...', percentage: 90 });

    // 内部进度：音频合并
    await this.publishProgress(taskId, '正在合并音频...', { internal: true });
    const combinedAudioData = combineAudio(audioDataList);

    // 内部进度：存储文件
    await this.publishProgress(taskId, '正在保存音频文件...', { internal: true });
    const filePath = await this.storeAudioFile(taskId, combinedAudioData);

    // 更新用户使用量
    await updateUserUsage(username, charCount);

    // 任务完成 - 生成安全的播放和下载URL（不包含token）
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

    // 调试日志：检查token是否正确传递
    console.log(`[TTS-PROCESSOR] Generating secure URLs for taskId: ${taskId}`);
    console.log(`[TTS-PROCESSOR] Token received: ${token ? 'YES' : 'NO'}`);
    console.log(`[TTS-PROCESSOR] Token length: ${token ? token.length : 0}`);

    // 生成不包含token的安全URL
    const streamUrl = `${baseUrl}/api/tts/stream/${taskId}`;
    const downloadUrl = `${baseUrl}/api/tts/download/${taskId}`;

    console.log(`[TTS-PROCESSOR] Generated secure streamUrl: ${streamUrl}`);
    console.log(`[TTS-PROCESSOR] Generated secure downloadUrl: ${downloadUrl}`);
    console.log(`[TTS-PROCESSOR] Token will be passed via Authorization header for security`);

    const finalStatus = {
      status: 'complete',
      streamUrl: streamUrl,      // 安全的播放URL
      downloadUrl: downloadUrl,  // 安全的下载URL
      audioSize: combinedAudioData.byteLength,
      username: username,
      completedAt: Date.now(),
      taskId: taskId,
      requiresAuth: true         // 新增：标识需要认证
    };

    await redisClient.setTaskData(taskId, finalStatus);

    // 用户进度：任务完成
    await this.publishProgress(taskId, {
      type: 'complete',
      message: '完成',
      percentage: 100,
      ...finalStatus
    });

    return finalStatus;
  }

  // 对话式TTS处理逻辑（声音分组并发优化版本）
  async startDialogue(taskId, taskData, username, token = null) {
    // 用户进度：开始处理
    await this.publishProgress(taskId, '正在处理...', { userMessage: '正在处理...', percentage: 10 });

    // 内部进度：初始化多人对话任务
    await this.publishProgress(taskId, '初始化多人对话任务...', { internal: true });

    const { dialogue, model, stability, similarity_boost, style, speed } = taskData;

    if (!Array.isArray(dialogue) || dialogue.length === 0) {
      throw new Error('请求中的 "dialogue" 必须是一个非空数组。');
    }

    // 计算总字符数
    const charCount = dialogue.reduce((sum, speaker) => sum + (speaker.text ? speaker.text.length : 0), 0);

    // 检查VIP权限和配额 - 对话式TTS需要PRO权限
    await checkVip(username, 'PRO', charCount);

    // 🚀 新优化：完全并发处理（方案一）
    await this.publishProgress(taskId, '分析对话结构并启动完全并发处理...', { internal: true });

    // 检测系统资源和计算最优并发数
    const os = require('os');
    const cpuCores = os.cpus().length;
    const totalSentences = dialogue.length;

    // 计算合理的并发上限
    const maxConcurrency = Math.min(
      totalSentences,           // 不超过句子总数
      cpuCores * 4,            // 基于CPU核心数
      20                       // 硬编码上限，防止资源耗尽
    );

    await this.publishProgress(taskId, `检测到 ${totalSentences} 个句子，将使用最多 ${maxConcurrency} 个并发处理`, { internal: true });

    // 用户进度：开始生成对话音频
    await this.publishProgress(taskId, '生成对话音频...', { userMessage: '生成对话音频...', percentage: 30 });

    // 【新方案】完全并发处理：所有句子同时处理（带兜底机制）
    let allResults;

    try {
      // 尝试完全并发处理
      await this.publishProgress(taskId, '启动完全并发处理模式...', { internal: true });

      const pLimit = require('p-limit');
      const limiter = pLimit(maxConcurrency);

      const allSpeakerPromises = dialogue.map((speaker, index) =>
        limiter(async () => {
          await this.publishProgress(taskId, `处理句子 ${index + 1}: ${speaker.voice} - "${speaker.text.substring(0, 20)}..."`, { internal: true });

          try {
            // 获取语音ID（带缓存优化）
            const voiceId = await getVoiceId(speaker.voice);

            // 文本分割
            const chunks = await splitText(speaker.text);

            // 并发处理文本块
            const speakerAudioList = await processChunks(
              chunks,
              voiceId,
              model || 'eleven_turbo_v2',
              stability,
              similarity_boost,
              style,
              speed,
              { taskId, username }
            );

            if (speakerAudioList.length === 0) {
              throw new Error(`未能为位置 ${index} 的说话者 (${speaker.voice}) 生成任何音频。`);
            }

            // 合并该说话者的音频
            const combinedAudio = combineAudio(speakerAudioList);

            await this.publishProgress(taskId, `句子 ${index + 1} (${speaker.voice}) 处理完成`, { internal: true });

            return {
              originalIndex: index,
              voice: speaker.voice,
              audio: combinedAudio
            };
          } catch (error) {
            console.error(`句子 ${index + 1} (${speaker.voice}) 处理失败:`, error);
            throw new Error(`句子 ${index + 1} 处理失败: ${error.message}`);
          }
        })
      );

      // 等待所有句子完成
      await this.publishProgress(taskId, '等待所有句子完成...', { internal: true });
      allResults = await Promise.all(allSpeakerPromises);

      await this.publishProgress(taskId, '完全并发处理成功完成', { internal: true });

    } catch (concurrentError) {
      // 【兜底机制】如果并发处理失败，降级到原有的声音分组串行模式
      console.warn(`[FALLBACK] 完全并发处理失败，降级到声音分组串行模式:`, concurrentError.message);
      await this.publishProgress(taskId, '并发处理遇到问题，切换到兜底模式...', { internal: true });

      allResults = await this.fallbackToGroupedProcessing(dialogue, model, stability, similarity_boost, style, speed, taskId, username);
    }

    // 用户进度：音频生成完成
    await this.publishProgress(taskId, '音频生成完成，正在检查...', { userMessage: '音频生成完成，正在检查...', percentage: 80 });

    // 【新逻辑】按原始顺序重新组装（完全并发结果）
    await this.publishProgress(taskId, '按原始顺序重新组装音频...', { internal: true });
    const finalAudioArray = new Array(dialogue.length);

    // 将所有结果按原始索引排序
    allResults.forEach(result => {
      finalAudioArray[result.originalIndex] = result.audio;
    });

    // 验证音频完整性
    for (let i = 0; i < finalAudioArray.length; i++) {
      if (!finalAudioArray[i]) {
        throw new Error(`位置 ${i} 的音频丢失，请重试。`);
      }
    }

    await this.publishProgress(taskId, `音频重组完成，共 ${finalAudioArray.length} 个音频片段`, { internal: true });

    // 用户进度：即将完成
    await this.publishProgress(taskId, '即将完成...', { userMessage: '即将完成...', percentage: 90 });

    // 内部进度：合并所有说话者的音频
    await this.publishProgress(taskId, '正在合并所有对话音频...', { internal: true });
    const finalAudio = combineAudio(finalAudioArray);

    // 内部进度：存储音频文件
    await this.publishProgress(taskId, '正在保存音频文件...', { internal: true });
    const filePath = await this.storeAudioFile(taskId, finalAudio);

    // 更新用户使用量
    await updateUserUsage(username, charCount);

    // 任务完成 - 生成安全的播放和下载URL（对话模式，不包含token）
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:3001';

    // 调试日志：检查token是否正确传递（对话模式）
    console.log(`[TTS-PROCESSOR-DIALOGUE] Generating secure URLs for taskId: ${taskId}`);
    console.log(`[TTS-PROCESSOR-DIALOGUE] Token received: ${token ? 'YES' : 'NO'}`);
    console.log(`[TTS-PROCESSOR-DIALOGUE] Token length: ${token ? token.length : 0}`);

    // 生成不包含token的安全URL
    const streamUrl = `${baseUrl}/api/tts/stream/${taskId}`;
    const downloadUrl = `${baseUrl}/api/tts/download/${taskId}`;

    console.log(`[TTS-PROCESSOR-DIALOGUE] Generated secure streamUrl: ${streamUrl}`);
    console.log(`[TTS-PROCESSOR-DIALOGUE] Generated secure downloadUrl: ${downloadUrl}`);
    console.log(`[TTS-PROCESSOR-DIALOGUE] Token will be passed via Authorization header for security`);

    const finalStatus = {
      status: 'complete',
      streamUrl: streamUrl,      // 安全的播放URL
      downloadUrl: downloadUrl,  // 安全的下载URL
      audioSize: finalAudio.byteLength,
      username: username,
      completedAt: Date.now(),
      taskId: taskId,
      requiresAuth: true         // 新增：标识需要认证
    };

    await redisClient.setTaskData(taskId, finalStatus);

    // 用户进度：任务完成
    await this.publishProgress(taskId, {
      type: 'complete',
      message: '完成',
      percentage: 100,
      ...finalStatus
    });

    return finalStatus;
  }

  // 【新增】兜底处理方法：声音分组串行模式（原有逻辑）
  async fallbackToGroupedProcessing(dialogue, model, stability, similarity_boost, style, speed, taskId, username) {
    await this.publishProgress(taskId, '使用兜底模式：声音分组串行处理...', { internal: true });

    // 按声音分组，保持原始位置信息
    const voiceGroups = new Map();
    dialogue.forEach((speaker, index) => {
      if (!voiceGroups.has(speaker.voice)) {
        voiceGroups.set(speaker.voice, []);
      }
      voiceGroups.get(speaker.voice).push({
        ...speaker,
        originalIndex: index
      });
    });

    const uniqueVoices = Array.from(voiceGroups.keys());
    await this.publishProgress(taskId, `兜底模式：检测到 ${uniqueVoices.length} 种不同声音，开始分组串行处理...`, { internal: true });

    // 不同声音并发处理（原有逻辑）
    const voiceProcessingPromises = Array.from(voiceGroups.entries()).map(
      async ([voice, speakers]) => {
        await this.publishProgress(taskId, `兜底模式：开始处理 ${voice} 声音组 (${speakers.length} 句话)...`, { internal: true });

        // 获取语音ID（每个声音只查询一次）
        const voiceId = await getVoiceId(voice);

        const audioResults = [];

        // 同一声音内部仍按顺序处理（保持对话逻辑）
        for (const speaker of speakers) {
          await this.publishProgress(taskId, `兜底模式：处理 ${voice}[${speaker.originalIndex}]: "${speaker.text.substring(0, 20)}..."`, { internal: true });

          const chunks = await splitText(speaker.text);
          const speakerAudioList = await processChunks(
            chunks,
            voiceId,
            model || 'eleven_turbo_v2',
            stability,
            similarity_boost,
            style,
            speed,
            { taskId, username }
          );

          if (speakerAudioList.length === 0) {
            throw new Error(`未能为位置 ${speaker.originalIndex} 的说话者 (${voice}) 生成任何音频。`);
          }

          const combinedAudio = combineAudio(speakerAudioList);
          audioResults.push({
            originalIndex: speaker.originalIndex,
            audio: combinedAudio
          });
        }

        await this.publishProgress(taskId, `兜底模式：${voice} 声音组处理完成`, { internal: true });
        return audioResults;
      }
    );

    // 等待所有声音组完成
    await this.publishProgress(taskId, '兜底模式：等待所有声音组完成...', { internal: true });
    const allVoiceResults = await Promise.all(voiceProcessingPromises);

    // 展平结果
    return allVoiceResults.flat();
  }

  async publishProgress(taskId, progress, options = {}) {
    const {
      internal = false,     // 是否为内部进度（不推送给用户）
      userMessage = null,   // 用户友好的进度消息
      percentage = null     // 进度百分比
    } = options;

    // 标准化进度数据格式
    if (typeof progress === 'string') {
      progress = { message: progress };
    }

    // 内部进度：只记录到控制台日志，不推送到WebSocket
    if (internal) {
      console.log(`[INTERNAL-PROGRESS] ${taskId}: ${progress.message || JSON.stringify(progress)}`);
      return;
    }

    // 用户进度：构建用户友好的进度数据
    const userProgress = {
      ...progress,
      ...(userMessage && { message: userMessage }),
      ...(percentage !== null && { percentage })
    };

    // 推送到WebSocket
    await redisClient.publishProgress(taskId, userProgress);
  }

  async storeAudioFile(taskId, audioBuffer) {
    const fileName = `${taskId}.mp3`;
    const filePath = path.join(process.env.AUDIO_STORAGE_PATH, fileName);

    await fs.writeFile(filePath, Buffer.from(audioBuffer));

    console.log(`Audio file stored: ${filePath}, size: ${audioBuffer.byteLength} bytes`);
    return filePath;
  }
}

module.exports = new TtsProcessor();
