const crypto = require('crypto');
const dbClient = require('../services/dbClient');
const { getTTSProxyConfig } = require('./config');

// 从worker.js迁移的核心函数
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * 【SSML增强版】智能分割文本，支持SSML指令识别
 * 这个函数会将文本分割成不超过maxLength的块，同时确保 [...] 形式的SSML指令不会被破坏。
 * 保持现有的所有智能分割和性能优化逻辑。
 * @param {string} text - 输入的文本，可能包含SSML指令
 * @returns {Promise<string[]>} - 分割后的文本块数组
 */
async function splitText(text) {
  const maxLength = 1000;  // 每个片段的最大长度，用户设置为1000

  // 【SSML功能】检测文本中是否包含SSML指令
  const hasSSMLDirectives = /\[.*?\]/.test(text);

  if (hasSSMLDirectives) {
    // 【SSML处理路径】使用SSML感知的分割逻辑
    console.log('[SSML-SPLIT] Detected SSML directives, using SSML-aware splitting');
    return await splitTextWithSSML(text, maxLength);
  } else {
    // 【传统处理路径】使用原有的智能分割逻辑，保持100%兼容性
    return await splitTextTraditional(text, maxLength);
  }
}

/**
 * 【新增】SSML感知的文本分割函数
 * 确保SSML指令（如[calmly], [whispering]）不会被分割破坏
 */
async function splitTextWithSSML(text, maxLength) {
  // 使用正则表达式将文本分割成普通文本片段和SSML指令片段的数组
  // 例如 "[calmly] Hello world. [whispering] Secret." 会被分割成:
  // ["", "[calmly]", " Hello world. ", "[whispering]", " Secret."]
  const parts = text.split(/(\[.*?\])/g).filter(Boolean); // filter(Boolean) 用于移除空字符串

  const chunks = [];
  let currentChunk = "";

  for (const part of parts) {
    // 如果当前块加上新片段会超过最大长度
    if (currentChunk.length + part.length > maxLength) {
      // 如果当前块有内容，则推入chunks数组
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }

      // 如果单个片段本身就超长，需要进一步处理
      if (part.length > maxLength) {
        // 检查是否是SSML指令
        if (/^\[.*?\]$/.test(part.trim())) {
          // 如果是SSML指令但超长，保持完整（这种情况极少见）
          console.warn('[SSML-SPLIT] Warning: SSML directive exceeds maxLength:', part.substring(0, 50) + '...');
          chunks.push(part.trim());
          currentChunk = "";
        } else {
          // 如果是普通文本超长，使用智能分割
          const subChunks = smartSplitLongText(part, maxLength);
          chunks.push(...subChunks);
          currentChunk = "";
        }
      } else {
        // 开始一个新的块
        currentChunk = part;
      }
    } else {
      // 否则，将新片段添加到当前块
      currentChunk += part;
    }
  }

  // 推入最后一个块
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // 如果没有任何内容，返回原文本作为单个块
  if (chunks.length === 0 && text.length > 0) {
    chunks.push(text);
  }

  console.log(`[SSML-SPLIT] Split text with SSML into ${chunks.length} chunks`);
  return chunks;
}

/**
 * 【保持原有】传统的智能分割函数，保持100%向后兼容
 * 这是原有的splitText函数逻辑，确保非SSML文本的处理完全不变
 */
async function splitTextTraditional(text, maxLength) {
  let sentences;
  try {
    const segmenter = new Intl.Segmenter(['en', 'zh'], { granularity: 'sentence' });
    const iterator = segmenter.segment(text);
    sentences = Array.from(iterator).map(s => s.segment);
  } catch (e) {
    // 如果 Intl.Segmenter 在极端情况下失败或环境不支持，回退到正则表达式方案
    console.error("Intl.Segmenter failed, falling back to regex:", e);
    const sentencePattern = /(?<=[。！？!?；;:：…]{1,2})\s*/;
    sentences = text.split(sentencePattern);
  }

  const chunks = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    // 如果单个句子就超过了最大长度，需要进一步分割
    if (sentence.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      // 使用智能分割替代原来的硬切分
      const subChunks = smartSplitLongSentence(sentence, maxLength);
      chunks.push(...subChunks);
    }
    // 如果当前块加上新句子会超过最大长度
    else if (currentChunk.length + sentence.length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * 【新增】智能分割超长文本的通用函数
 * 用于处理SSML和传统文本的超长片段分割
 * 保持原有的所有智能分割逻辑和性能优化
 */
function smartSplitLongText(text, maxLength) {
  const subChunks = [];
  let remainingText = text;

  while (remainingText.length > maxLength) {
    let splitPos = -1;
    const searchRange = remainingText.substring(0, maxLength);

    // 优化：使用单次遍历查找最佳分割点，按优先级从高到低
    // 1. 次要标点符号（逗号、分号、冒号等） - 使用lastIndexOf一次查找
    const punctuationChars = '，,;；:：';
    for (let i = 0; i < punctuationChars.length; i++) {
      const pos = searchRange.lastIndexOf(punctuationChars[i]);
      if (pos > splitPos) {
        splitPos = pos + 1; // 在标点后分割
      }
    }

    // 2. 如果没找到次要标点，寻找空格（主要用于英文）
    if (splitPos === -1) {
      splitPos = searchRange.lastIndexOf(' ');
    }

    // 3. 寻找连接符 - 优化：直接使用lastIndexOf
    if (splitPos === -1) {
      const connectorChars = '-–—';
      for (let i = 0; i < connectorChars.length; i++) {
        const pos = searchRange.lastIndexOf(connectorChars[i]);
        if (pos > splitPos) {
          splitPos = pos + 1;
        }
      }
    }

    // 4. 寻找换行符或制表符
    if (splitPos === -1) {
      splitPos = Math.max(
        searchRange.lastIndexOf('\n'),
        searchRange.lastIndexOf('\r'),
        searchRange.lastIndexOf('\t')
      );
    }

    // 5. 如果都找不到合适的分割点，使用硬切分，但尽量避免切断单词
    if (splitPos === -1 || splitPos < maxLength * 0.7) {
      splitPos = maxLength;

      // 优化：简化英文单词边界检测
      if (splitPos < remainingText.length) {
        const charAtSplit = remainingText[splitPos];
        const charBeforeSplit = remainingText[splitPos - 1];

        // 如果切分点在英文字母中间，向前寻找单词边界
        if (/[a-zA-Z]/.test(charAtSplit) && /[a-zA-Z]/.test(charBeforeSplit)) {
          // 优化：使用lastIndexOf查找空格而不是while循环
          const wordBoundary = remainingText.lastIndexOf(' ', splitPos);
          if (wordBoundary > maxLength * 0.8) {
            splitPos = wordBoundary;
          }
        }
      }
    }

    // 确保分割位置有效
    splitPos = Math.max(1, Math.min(splitPos, remainingText.length));

    const chunk = remainingText.substring(0, splitPos).trim();
    if (chunk) {
      subChunks.push(chunk);
    }

    remainingText = remainingText.substring(splitPos).trim();
  }

  // 添加剩余部分
  if (remainingText.trim()) {
    subChunks.push(remainingText.trim());
  }

  return subChunks;
}

/**
 * 【保持原有】智能分割超长句子函数 - 用于传统文本处理
 * 这是原有的smartSplitLongSentence函数，保持100%兼容性
 */
function smartSplitLongSentence(sentence, maxLength) {
  // 直接复用通用的智能分割函数
  return smartSplitLongText(sentence, maxLength);
}

// 获取语音ID映射
async function getVoiceIdMapping(voiceName) {
  try {
    const result = await dbClient.query(
      'SELECT voice_id FROM voice_mappings WHERE voice_name = $1',
      [voiceName]
    );

    return result.rows[0]?.voice_id || voiceName;
  } catch (error) {
    console.error('Failed to get voice mapping:', error);
    return voiceName; // 回退到原始名称
  }
}

// 生成基于日期的文件名
function generateDateBasedFilename(taskId, extension = 'mp3') {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  return `${dateStr}_${taskId}.${extension}`;
}

// 获取下个月重置时间戳
function getNextMonthResetTimestamp() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.getTime();
}

// 【新增】智能并发控制器
class SmartConcurrencyController {
  constructor() {
    this.systemInfo = this.detectSystemResources();
    this.performanceHistory = [];
    this.maxHistorySize = 10;
  }

  detectSystemResources() {
    const os = require('os');
    const cpuCores = os.cpus().length;
    const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);
    const freeMemoryGB = os.freemem() / (1024 * 1024 * 1024);

    return {
      cpuCores,
      totalMemoryGB,
      freeMemoryGB,
      memoryUsagePercent: ((totalMemoryGB - freeMemoryGB) / totalMemoryGB) * 100
    };
  }

  calculateOptimalConcurrency(taskSize, networkMode, workerPoolSize = 10) {
    const { cpuCores, memoryUsagePercent } = this.systemInfo;

    // 基础并发能力计算
    let baseConcurrency;
    if (networkMode === 'gateway') {
      // 工作池模式：更激进的并发
      baseConcurrency = Math.min(workerPoolSize, cpuCores * 3, 20);
    } else {
      // 传统模式：保守的并发
      baseConcurrency = Math.min(cpuCores * 2, 12);
    }

    // 根据系统负载调整
    let loadFactor = 1.0;
    if (memoryUsagePercent > 85) {
      loadFactor = 0.5; // 内存紧张，减少并发
    } else if (memoryUsagePercent > 70) {
      loadFactor = 0.7; // 内存较紧张，适度减少
    } else if (memoryUsagePercent < 50) {
      loadFactor = 1.2; // 内存充足，可以增加并发
    }

    // 根据任务规模调整
    const taskFactor = Math.min(taskSize / 5, 2); // 任务越大，并发越高，但有上限

    // 计算最终并发数
    const finalConcurrency = Math.floor(baseConcurrency * loadFactor * taskFactor);

    // 确保不超过任务本身的数量，且至少为1
    return Math.max(1, Math.min(finalConcurrency, taskSize));
  }

  recordPerformance(concurrency, taskSize, duration, success) {
    this.performanceHistory.push({
      concurrency,
      taskSize,
      duration,
      success,
      timestamp: Date.now(),
      efficiency: success ? taskSize / duration : 0
    });

    // 保持历史记录大小
    if (this.performanceHistory.length > this.maxHistorySize) {
      this.performanceHistory.shift();
    }
  }

  getRecommendedConcurrency(taskSize, networkMode, workerPoolSize) {
    const calculated = this.calculateOptimalConcurrency(taskSize, networkMode, workerPoolSize);

    // 如果有历史数据，可以进行优化调整
    if (this.performanceHistory.length >= 3) {
      const recentSuccessful = this.performanceHistory
        .filter(h => h.success && h.taskSize >= taskSize * 0.5)
        .slice(-5);

      if (recentSuccessful.length >= 2) {
        const avgEfficiency = recentSuccessful.reduce((sum, h) => sum + h.efficiency, 0) / recentSuccessful.length;
        const bestRun = recentSuccessful.reduce((best, current) =>
          current.efficiency > best.efficiency ? current : best
        );

        // 如果历史最佳并发数与计算值差异较大，进行调整
        if (Math.abs(bestRun.concurrency - calculated) > 2) {
          const adjusted = Math.round((bestRun.concurrency + calculated) / 2);
          console.log(`[SMART-CONCURRENCY] Adjusted based on history: ${calculated} -> ${adjusted}`);
          return Math.max(1, Math.min(adjusted, taskSize));
        }
      }
    }

    return calculated;
  }

  getStats() {
    return {
      systemInfo: this.systemInfo,
      performanceHistory: this.performanceHistory.slice(-5), // 最近5次记录
      historySize: this.performanceHistory.length
    };
  }
}

// 全局智能并发控制器实例
const smartConcurrencyController = new SmartConcurrencyController();

// 【增强版】并发音频生成函数 - 支持违规检测和快速失败，智能并发控制
async function processChunks(chunks, voiceId, modelId, stability, similarity_boost, style, speed, context = {}) {
  const pLimit = require('p-limit');
  const startTime = Date.now();

  // 【智能并发控制】动态计算最优并发数
  let optimalConcurrency;
  let networkMode = 'traditional';
  let workerPoolSize = 10;

  try {
    // 检查是否启用了工作池模式
    const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
    const config = configAdapter.getConfig();
    networkMode = config.NETWORK_MODE;
    workerPoolSize = config.SINGBOX_WORKER_POOL_SIZE || 10;

    if (config.NETWORK_MODE === 'gateway' && config.ENABLE_SINGBOX_GATEWAY) {
      // 工作池模式：使用智能并发控制
      optimalConcurrency = smartConcurrencyController.getRecommendedConcurrency(
        chunks.length, 'gateway', workerPoolSize
      );
      console.log(`[SMART-WORKER-POOL] Processing ${chunks.length} chunks with ${optimalConcurrency} intelligent concurrency`);
    } else {
      // 传统模式：使用智能并发控制
      optimalConcurrency = smartConcurrencyController.getRecommendedConcurrency(
        chunks.length, 'traditional', 4
      );
      console.log(`[SMART-TRADITIONAL] Processing ${chunks.length} chunks with ${optimalConcurrency} intelligent concurrency`);
    }
  } catch (error) {
    // 配置获取失败时使用智能默认值
    optimalConcurrency = smartConcurrencyController.getRecommendedConcurrency(
      chunks.length, 'traditional', 4
    );
    console.log(`[SMART-FALLBACK] Processing ${chunks.length} chunks with ${optimalConcurrency} intelligent fallback concurrency`);
  }

  const limiter = pLimit(optimalConcurrency);

  // 【新增】创建AbortController用于快速失败
  const abortController = new AbortController();
  let firstViolationError = null;

  // 并发处理所有chunks
  const promises = chunks.map((chunk, index) =>
    limiter(async () => {
      // 【新增】检查是否已被中止
      if (abortController.signal.aborted) {
        throw new Error(`Chunk ${index + 1} cancelled due to violation in another chunk`);
      }

      try {
        console.log(`Processing chunk ${index + 1}/${chunks.length}, length: ${chunk.length}`);

        // 调用ElevenLabs API生成音频（使用智能网络管理器）
        const audioBuffer = await generateSpeechSmart(chunk, voiceId, modelId, stability, similarity_boost, style, speed);

        return {
          index,
          success: true,
          audioData: audioBuffer,
          chunk
        };
      } catch (error) {
        // 【新增】检测违规并立即中止所有其他chunk
        if (error.isContentViolation && !firstViolationError) {
          firstViolationError = error;
          abortController.abort(); // 立即中止所有其他任务

          console.warn(`[FAST-FAIL] Violation detected in chunk ${index + 1}, aborting all chunks...`);
        }

        console.error(`Chunk ${index + 1} failed:`, error.message);
        return {
          index,
          success: false,
          error: error, // 【修复】保存完整的错误对象，而不只是消息
          isContentViolation: error.isContentViolation || false,
          chunk
        };
      }
    })
  );

  const results = await Promise.all(promises);
  const endTime = Date.now();
  const duration = endTime - startTime;

  // 【新增】优先检查是否有违规错误
  const violationResults = results.filter(r => !r.success && r.isContentViolation);
  if (violationResults.length > 0) {
    // 记录失败的性能数据
    smartConcurrencyController.recordPerformance(optimalConcurrency, chunks.length, duration, false);

    // 如果有违规错误，立即抛出第一个违规错误
    const violationError = new Error(violationResults[0].error);
    violationError.isContentViolation = true;
    violationError.isDataCenterRetryable = false;
    console.warn(`[VIOLATION-DETECTED] Content violation found in chunk processing. Terminating immediately.`);
    throw violationError;
  }

  // 检查失败的chunks（非违规错误）
  const failedResults = results.filter(r => !r.success && !r.isContentViolation);

  // 【增强】双重检查：确保没有违规错误被误分类
  const potentialViolationResults = failedResults.filter(r =>
    r.error && (r.error.isContentViolation ||
    (typeof r.error === 'object' && r.error.message &&
     r.error.message.includes('violate our Terms of Service')))
  );

  if (potentialViolationResults.length > 0) {
    console.warn(`[DOUBLE-CHECK] Found ${potentialViolationResults.length} potential violation errors that were missed. Treating as violations.`);
    // 将这些错误重新分类为违规错误
    for (const result of potentialViolationResults) {
      if (result.error && typeof result.error === 'object') {
        result.error.isContentViolation = true;
        result.isContentViolation = true;
      }
    }
    // 从失败结果中移除这些违规错误
    const nonViolationFailedResults = failedResults.filter(r => !potentialViolationResults.includes(r));

    if (nonViolationFailedResults.length === 0) {
      // 所有失败都是违规错误，不进行重试
      console.log(`[DOUBLE-CHECK] All failed chunks are violation errors. No retry needed.`);
      return results
        .sort((a, b) => a.index - b.index)
        .map(r => r.audioData);
    }

    // 更新失败结果列表
    failedResults.splice(0, failedResults.length, ...nonViolationFailedResults);
  }

  if (failedResults.length > 0) {
    console.warn(`${failedResults.length} chunks failed, attempting retry...`);

    // 【新增】创建重试阶段的AbortController
    const retryAbortController = new AbortController();
    let retryViolationError = null;

    // 重试逻辑
    for (const failedResult of failedResults) {
      // 【新增】检查是否已被中止
      if (retryAbortController.signal.aborted) {
        throw new Error(`Retry chunk ${failedResult.index + 1} cancelled due to violation in another retry`);
      }

      try {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒延迟
        const audioBuffer = await generateSpeech(
          failedResult.chunk, voiceId, modelId, stability, similarity_boost, style, speed
        );

        results[failedResult.index] = {
          ...failedResult,
          success: true,
          audioData: audioBuffer
        };
        console.log(`Retry successful for chunk ${failedResult.index + 1}`);
      } catch (retryError) {
        // 【新增】检测重试阶段的违规错误
        if (retryError.isContentViolation && !retryViolationError) {
          retryViolationError = retryError;
          retryAbortController.abort(); // 立即中止所有其他重试

          console.warn(`[RETRY-VIOLATION] Violation detected in retry chunk ${failedResult.index + 1}, aborting all retries...`);
          throw retryError; // 立即抛出违规错误
        }

        console.error(`Retry failed for chunk ${failedResult.index + 1}:`, retryError.message);
        throw new Error(`音频生成失败: ${retryError.message}`);
      }
    }
  }

  // 【新增】记录成功的性能数据
  const successfulChunks = results.filter(r => r.success).length;
  const isSuccess = successfulChunks === chunks.length;

  smartConcurrencyController.recordPerformance(optimalConcurrency, chunks.length, duration, isSuccess);

  console.log(`[PERFORMANCE] Processed ${chunks.length} chunks in ${duration}ms with ${optimalConcurrency} concurrency (${successfulChunks}/${chunks.length} successful)`);

  // 返回按顺序排列的音频数据
  return results
    .sort((a, b) => a.index - b.index)
    .map(r => r.audioData);
}

/**
 * 【新增】智能代理选择器 - 随机轮询 + 故障排除
 * 实现随机化轮询，避免重复选择故障代理，提高成功率
 */
class ProxySelector {
  constructor(proxyUrls, enableDebug = false) {
    this.originalUrls = proxyUrls || [];
    this.enableDebug = enableDebug;
    this.reset();
  }

  /**
   * 重置选择器状态
   */
  reset() {
    if (this.originalUrls.length === 0) {
      this.shuffledUrls = [];
      this.currentIndex = 0;
      this.failedUrls = new Set();
      return;
    }

    // 使用Fisher-Yates算法进行随机排序
    this.shuffledUrls = this.shuffle([...this.originalUrls]);
    this.currentIndex = 0;
    this.failedUrls = new Set();

    if (this.enableDebug) {
      console.log('[PROXY-SELECTOR] Initialized with shuffled order:', this.shuffledUrls);
    }
  }

  /**
   * Fisher-Yates 随机排序算法
   * @param {Array} array - 要排序的数组
   * @returns {Array} 随机排序后的数组
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * 获取下一个可用的代理URL
   * @returns {string|null} 下一个可用的代理URL，如果没有可用代理则返回null
   */
  getNextProxy() {
    // 跳过已失败的代理，找到下一个可用的
    while (this.currentIndex < this.shuffledUrls.length) {
      const url = this.shuffledUrls[this.currentIndex++];
      if (!this.failedUrls.has(url)) {
        if (this.enableDebug) {
          console.log(`[PROXY-SELECTOR] Selected proxy: ${url} (index: ${this.currentIndex - 1})`);
        }
        return url;
      } else {
        if (this.enableDebug) {
          console.log(`[PROXY-SELECTOR] Skipping failed proxy: ${url}`);
        }
      }
    }

    if (this.enableDebug) {
      console.log('[PROXY-SELECTOR] No more available proxies');
    }
    return null; // 所有代理都失败了或已尝试完
  }

  /**
   * 标记代理为失败状态
   * @param {string} url - 失败的代理URL
   */
  markFailed(url) {
    this.failedUrls.add(url);
    if (this.enableDebug) {
      console.log(`[PROXY-SELECTOR] Marked proxy as failed: ${url}`);
      console.log(`[PROXY-SELECTOR] Failed proxies count: ${this.failedUrls.size}/${this.originalUrls.length}`);
    }
  }

  /**
   * 获取当前状态信息
   * @returns {object} 当前选择器状态
   */
  getStatus() {
    return {
      totalProxies: this.originalUrls.length,
      failedProxies: this.failedUrls.size,
      remainingProxies: this.originalUrls.length - this.failedUrls.size,
      currentIndex: this.currentIndex,
      shuffledOrder: this.shuffledUrls,
      failedUrls: Array.from(this.failedUrls)
    };
  }

  /**
   * 检查是否还有可用的代理
   * @returns {boolean} 是否还有可用代理
   */
  hasAvailableProxy() {
    return this.originalUrls.some(url => !this.failedUrls.has(url));
  }
}

/**
 * 【保留】随机选择代理URL - 向后兼容
 * @param {string[]} proxyUrls - 代理URL列表
 * @returns {string|null} 随机选择的代理URL，如果列表为空则返回null
 */
function selectRandomProxyUrl(proxyUrls) {
  if (!proxyUrls || proxyUrls.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(Math.random() * proxyUrls.length);
  return proxyUrls[randomIndex];
}

/**
 * 【新增】智能代理调用 - 使用随机轮询 + 故障排除
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @param {object} proxyConfig - 代理配置
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function callTtsProxyWithSmartRetry(text, voiceId, modelId, stability, similarity_boost, style, speed, proxyConfig) {
  const startTime = Date.now();
  const { ttsLogger } = require('./ttsLogger');

  // 创建日志上下文
  const logContext = {
    textLength: text?.length || 0,
    voiceId,
    modelId
  };
  const contextLogger = ttsLogger.createContextLogger({ logContext });

  const proxySelector = new ProxySelector(proxyConfig.TTS_PROXY_URLS, proxyConfig.ENABLE_PROXY_DEBUG);

  if (proxySelector.originalUrls.length === 0) {
    throw new Error('No proxy URLs configured');
  }

  const maxRetries = Math.min(proxySelector.originalUrls.length, 3); // 最多重试3次或代理数量
  let lastError = null;

  contextLogger.logProxy('Starting smart proxy retry', {
    maxRetries,
    totalProxies: proxySelector.originalUrls.length,
    selectionStrategy: proxyConfig.TTS_PROXY_SELECTION_STRATEGY
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const proxyUrl = proxySelector.getNextProxy();

    if (!proxyUrl) {
      contextLogger.logProxy('No more available proxies', {
        attempt,
        maxRetries,
        availableProxies: 0
      });
      break;
    }

    try {
      contextLogger.logProxy('Attempting proxy request', {
        attempt,
        maxRetries,
        proxyUrl: proxyUrl.replace(/\/\/.*@/, '//***@'), // 隐藏认证信息
        strategy: proxyConfig.TTS_PROXY_SELECTION_STRATEGY
      });

      const requestStartTime = Date.now();
      const audioBuffer = await callSingleTtsProxy(
        text, voiceId, modelId, stability, similarity_boost, style, speed, proxyUrl, proxyConfig
      );

      const requestDuration = Date.now() - requestStartTime;
      const totalDuration = Date.now() - startTime;

      contextLogger.logProxy('Proxy request successful', {
        attempt,
        audioSize: audioBuffer.byteLength,
        requestDuration: `${requestDuration}ms`,
        totalDuration: `${totalDuration}ms`
      });

      return audioBuffer;

    } catch (error) {
      lastError = error;
      const requestDuration = Date.now() - startTime;

      // 【新增】如果检测到内容违规，立即终止所有代理尝试
      if (error.isContentViolation) {
        contextLogger.logError(error, 'proxy-smart-retry', {
          attempt,
          reason: 'content-violation',
          terminateAllAttempts: true,
          duration: `${requestDuration}ms`
        });
        throw error; // 立即抛出，不尝试其他代理
      }

      proxySelector.markFailed(proxyUrl);

      contextLogger.logProxy('Proxy attempt failed', {
        attempt,
        maxRetries,
        error: error.message,
        proxyUrl: proxyUrl.replace(/\/\/.*@/, '//***@'), // 隐藏认证信息
        duration: `${requestDuration}ms`,
        willRetry: attempt < maxRetries && proxySelector.hasAvailableProxy()
      });

      // 如果不是最后一次尝试，添加短暂延迟
      if (attempt < maxRetries && proxySelector.hasAvailableProxy()) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒延迟
      }
    }
  }

  // 所有代理都失败了
  const status = proxySelector.getStatus();
  const totalDuration = Date.now() - startTime;

  contextLogger.logError(lastError || new Error('All proxies failed'), 'proxy-smart-retry', {
    totalProxies: status.totalProxies,
    failedProxies: status.failedProxies,
    totalDuration: `${totalDuration}ms`,
    finalStatus: status
  });

  throw new Error(`All ${status.totalProxies} proxies failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

/**
 * 【新增】调用单个代理服务器
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @param {string} proxyUrl - 指定的代理URL
 * @param {object} proxyConfig - 代理配置
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function callSingleTtsProxy(text, voiceId, modelId, stability, similarity_boost, style, speed, proxyUrl, proxyConfig) {
  // 构建完整的代理请求URL
  const fullProxyUrl = `${proxyUrl}/api/v1/text-to-speech/${voiceId}`;

  // 构建请求payload
  let voice_settings = {};

  if (modelId === 'eleven_v3') {
    voice_settings = {
      stability: stability || 0.5,
      use_speaker_boost: true
    };
  } else if (modelId === 'eleven_turbo_v2' || modelId === 'eleven_turbo_v2_5') {
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      speed: speed || 1.00,
      use_speaker_boost: true
    };
  } else {
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      style: style || 0.50,
      speed: speed || 1.00,
      use_speaker_boost: true
    };
  }

  const payload = {
    text: text,
    model_id: modelId || 'eleven_turbo_v2',
    voice_settings: voice_settings
  };

  const response = await fetch(fullProxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'x-proxy-secret': proxyConfig.TTS_PROXY_SECRET
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(proxyConfig.TTS_PROXY_TIMEOUT || 45000)
  });

  if (!response.ok) {
    const errorText = await response.text();

    // 【新增】解析错误数据并检测违规
    const { isContentViolationError } = require('./helpers');
    let errorData, originalMessage;

    try {
      // 尝试解析为JSON以获取详细错误信息
      errorData = JSON.parse(errorText);
      originalMessage = errorData?.detail?.message || errorData?.message || errorText;
    } catch (e) {
      // 如果解析失败，使用原始文本
      originalMessage = errorText;
      errorData = { message: originalMessage };
    }

    // 【新增】检测违规并立即终止所有代理尝试
    if (isContentViolationError(response.status, errorData, originalMessage)) {
      const violationError = new Error(originalMessage);
      violationError.status = response.status;
      violationError.isContentViolation = true; // 【关键标志】
      violationError.isDataCenterRetryable = false;
      violationError.originalError = errorData;

      if (proxyConfig.ENABLE_PROXY_DEBUG) {
        console.warn(`[PROXY-VIOLATION] Content violation detected from proxy: ${proxyUrl}`);
      }

      throw violationError; // 立即抛出，不尝试其他代理
    }

    // 【保持原有逻辑】非违规错误的处理
    const error = new Error(`Proxy API error: ${response.status} ${originalMessage}`);
    error.status = response.status;
    error.originalError = errorData;
    throw error;
  }

  return await response.arrayBuffer();
}

/**
 * 【保留】调用代理服务器生成音频 - 向后兼容
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @param {object} proxyConfig - 代理配置
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function callTtsProxy(text, voiceId, modelId, stability, similarity_boost, style, speed, proxyConfig) {
  // 随机选择一个代理URL
  const baseProxyUrl = selectRandomProxyUrl(proxyConfig.TTS_PROXY_URLS);

  if (!baseProxyUrl) {
    throw new Error('No proxy URLs available');
  }

  // 构建完整的代理请求URL，添加正确的路径
  const proxyUrl = `${baseProxyUrl}/api/v1/text-to-speech/${voiceId}`;

  if (proxyConfig.ENABLE_PROXY_DEBUG) {
    console.log(`[PROXY] Using random proxy: ${proxyUrl}`);
  }

  // 构建代理请求的payload，使用与ElevenLabs API相同的格式
  let voice_settings = {};

  if (modelId === 'eleven_v3') {
    voice_settings = {
      stability: stability || 0.5,
      use_speaker_boost: true
    };
  } else if (modelId === 'eleven_turbo_v2' || modelId === 'eleven_turbo_v2_5') {
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      speed: speed || 1.00,
      use_speaker_boost: true
    };
  } else {
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      style: style || 0.50,
      speed: speed || 1.00,
      use_speaker_boost: true
    };
  }

  const payload = {
    text: text,
    model_id: modelId || 'eleven_turbo_v2',
    voice_settings: voice_settings
  };

  const response = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
      'x-proxy-secret': proxyConfig.TTS_PROXY_SECRET
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(proxyConfig.TTS_PROXY_TIMEOUT || 45000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Proxy API error: ${response.status} ${errorText}`);
  }

  return await response.arrayBuffer();
}

/**
 * 【新增】直连ElevenLabs API生成音频
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function callDirectElevenLabs(text, voiceId, modelId, stability, similarity_boost, style, speed) {
  const startTime = Date.now();
  const { ttsLogger } = require('./ttsLogger');

  // 创建日志上下文
  const logContext = {
    textLength: text?.length || 0,
    voiceId,
    modelId
  };
  const contextLogger = ttsLogger.createContextLogger({ logContext });

  // 【参考代码逻辑】使用 allow_unauthenticated=1 参数，无需API Key
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?allow_unauthenticated=1`;

  contextLogger.logDirect('Starting direct ElevenLabs request', {
    voiceId,
    modelId,
    textLength: text?.length || 0
  });

  // 【参考代码逻辑】根据不同模型构建相应的 voice_settings
  let voice_settings = {};

  if (modelId === 'eleven_v3') {
    // Eleven v3 模型只支持 stability 参数
    voice_settings = {
      stability: stability || 0.5,  // eleven_v3 默认使用 0.5
      use_speaker_boost: true       // 启用Speaker Boost增强音质
    };
  } else if (modelId === 'eleven_turbo_v2' || modelId === 'eleven_turbo_v2_5') {
    // Eleven Turbo v2/v2.5 模型不支持 style 参数
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      speed: speed || 1.00,
      use_speaker_boost: true       // 启用Speaker Boost增强音质
    };
  } else {
    // 其他模型支持完整参数
    voice_settings = {
      stability: stability || 0.58,
      similarity_boost: similarity_boost || 0.75,
      style: style || 0.50,
      speed: speed || 1.00,
      use_speaker_boost: true       // 启用Speaker Boost增强音质
    };
  }

  const payload = {
    text: text,
    model_id: modelId || 'eleven_turbo_v2',
    voice_settings: voice_settings
  };

  // 【参考代码逻辑】不使用 xi-api-key，添加 Accept 头部以明确音频格式
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'audio/mpeg'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    });

    const requestDuration = Date.now() - startTime;

    contextLogger.logNetwork('POST', url, response.status, requestDuration, {
      responseOk: response.ok
    });

    if (!response.ok) {
      const errorText = await response.text();

      // 【新增】解析错误数据并检测违规
      const { isContentViolationError } = require('./helpers');
      let errorData, originalMessage;

      try {
        // 尝试解析为JSON以获取详细错误信息
        errorData = JSON.parse(errorText);
        originalMessage = errorData?.detail?.message || errorData?.message || errorText;
      } catch (e) {
        // 如果解析失败，使用原始文本
        originalMessage = errorText;
        errorData = { message: originalMessage };
      }

      // 【新增】检测违规内容并设置标志
      if (isContentViolationError(response.status, errorData, originalMessage)) {
        const violationError = new Error(originalMessage);
        violationError.status = response.status;
        violationError.isContentViolation = true; // 【关键标志】
        violationError.isDataCenterRetryable = false;
        violationError.originalError = errorData;

        contextLogger.logError(violationError, 'direct-elevenlabs', {
          status: response.status,
          reason: 'content-violation',
          duration: `${requestDuration}ms`
        });

        throw violationError;
      }

      // 【保持原有逻辑】非违规错误的处理
      const error = new Error(`ElevenLabs API error: ${response.status} ${originalMessage}`);
      error.status = response.status;
      error.originalError = errorData;

      contextLogger.logError(error, 'direct-elevenlabs', {
        status: response.status,
        duration: `${requestDuration}ms`
      });

      throw error;
    }

    const audioBuffer = await response.arrayBuffer();
    const totalDuration = Date.now() - startTime;

    contextLogger.logDirect('Direct request successful', {
      audioSize: audioBuffer.byteLength,
      requestDuration: `${requestDuration}ms`,
      totalDuration: `${totalDuration}ms`
    });

    return audioBuffer;

  } catch (error) {
    // 如果是我们已经处理过的错误，直接抛出
    if (error.isContentViolation || error.status) {
      throw error;
    }

    // 处理网络错误等其他错误
    const duration = Date.now() - startTime;
    contextLogger.logError(error, 'direct-elevenlabs', {
      duration: `${duration}ms`,
      errorType: 'network-or-other'
    });

    throw error;
  }
}

// 单个音频生成函数（调用ElevenLabs API）
// 【重构】支持智能代理选择和故障转移
async function generateSpeech(text, voiceId, modelId, stability, similarity_boost, style, speed) {
  const startTime = Date.now();
  const { ttsLogger } = require('./ttsLogger');

  // 创建日志上下文
  const logContext = {
    textLength: text?.length || 0,
    voiceId,
    modelId
  };
  const contextLogger = ttsLogger.createContextLogger({ logContext });

  // 获取代理配置
  const proxyConfig = getTTSProxyConfig();

  try {
    // 根据代理模式决定调用策略
    if (proxyConfig.ENABLE_TTS_PROXY && proxyConfig.TTS_PROXY_MODE === 'proxy') {
      // 仅代理模式：使用智能代理重试机制
      contextLogger.logProxy('Using proxy-only mode', {
        proxyUrls: proxyConfig.TTS_PROXY_URLS?.split(',').length || 0,
        selectionStrategy: proxyConfig.TTS_PROXY_SELECTION_STRATEGY
      });

      const audioBuffer = await callTtsProxyWithSmartRetry(text, voiceId, modelId, stability, similarity_boost, style, speed, proxyConfig);

      // 记录成功日志
      const duration = Date.now() - startTime;
      contextLogger.logSuccess('proxy-only', {
        audioSize: audioBuffer.byteLength,
        duration: `${duration}ms`
      });

      return audioBuffer;
    }
    else if (proxyConfig.ENABLE_TTS_PROXY && proxyConfig.TTS_PROXY_MODE === 'fallback') {
      // 故障转移模式：先尝试直连，失败后切换到智能代理重试
      contextLogger.logProxy('Using fallback mode', {
        strategy: 'direct-first-then-proxy'
      });

      try {
        contextLogger.logDirect('Attempting direct connection first');
        const audioBuffer = await callDirectElevenLabs(text, voiceId, modelId, stability, similarity_boost, style, speed);

        // 记录直连成功日志
        const duration = Date.now() - startTime;
        contextLogger.logSuccess('direct-fallback', {
          audioSize: audioBuffer.byteLength,
          duration: `${duration}ms`
        });

        return audioBuffer;
      } catch (error) {
        // 【修复】检查是否为内容违规错误
        if (error.isContentViolation) {
          contextLogger.logError(error, 'direct-fallback', {
            reason: 'content-violation',
            skipProxyRetry: true
          });
          // 违规内容不应该通过代理重试，直接抛出错误
          throw error;
        }

        contextLogger.logFallback('direct', 'proxy', error.message);

        // 非违规错误：切换到智能代理重试
        const audioBuffer = await callTtsProxyWithSmartRetry(text, voiceId, modelId, stability, similarity_boost, style, speed, proxyConfig);

        // 记录代理成功日志
        const duration = Date.now() - startTime;
        contextLogger.logSuccess('proxy-fallback', {
          audioSize: audioBuffer.byteLength,
          duration: `${duration}ms`,
          originalError: error.message
        });

        return audioBuffer;
      }
    }
    else {
      // 默认直连模式（代理未启用或模式为direct）
      contextLogger.logDirect('Using direct connection mode');

      const audioBuffer = await callDirectElevenLabs(text, voiceId, modelId, stability, similarity_boost, style, speed);

      // 记录直连成功日志
      const duration = Date.now() - startTime;
      contextLogger.logSuccess('direct', {
        audioSize: audioBuffer.byteLength,
        duration: `${duration}ms`
      });

      return audioBuffer;
    }

  } catch (error) {
    // 记录整体错误日志
    const duration = Date.now() - startTime;
    contextLogger.logError(error, 'traditional', {
      duration: `${duration}ms`,
      proxyMode: proxyConfig.TTS_PROXY_MODE
    });

    throw error;
  }
}

// 音频文件存储函数
async function storeAudioFile(taskId, audioBuffer) {
  const fs = require('fs').promises;
  const path = require('path');

  const fileName = `${taskId}.mp3`;
  const filePath = path.join(process.env.AUDIO_STORAGE_PATH, fileName);

  await fs.writeFile(filePath, Buffer.from(audioBuffer));

  console.log(`Audio file stored: ${filePath}, size: ${audioBuffer.byteLength} bytes`);
  return filePath;
}

// 合并多个音频ArrayBuffer（从参考代码迁移）
function combineAudio(audioDataList) {
  if (!audioDataList || audioDataList.length === 0) {
    return new ArrayBuffer(0);
  }
  if (audioDataList.length === 1) {
    return audioDataList[0];
  }

  const totalLength = audioDataList.reduce((acc, buffer) => acc + (buffer.byteLength || 0), 0);
  const combined = new Uint8Array(totalLength);

  let offset = 0;
  for (const buffer of audioDataList) {
    if (buffer && buffer.byteLength > 0) {
      combined.set(new Uint8Array(buffer), offset);
      offset += buffer.byteLength;
    }
  }

  return combined.buffer;
}

// 【新增】语音ID缓存类
class VoiceIdCache {
  constructor() {
    this.cache = new Map();
    this.ttl = 300000; // 5分钟TTL
    this.stats = {
      hits: 0,
      misses: 0,
      errors: 0
    };
  }

  async get(voiceName) {
    const cacheKey = voiceName;
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.ttl) {
      this.stats.hits++;
      console.log(`[VOICE-CACHE] Cache hit for voice: ${voiceName}`);
      return cached.voiceId;
    }

    this.stats.misses++;
    console.log(`[VOICE-CACHE] Cache miss for voice: ${voiceName}, fetching from database...`);

    try {
      const dbClient = require('../services/dbClient');
      const result = await dbClient.query(
        'SELECT voice_id FROM voice_mappings WHERE voice_name = $1',
        [voiceName]
      );

      const voiceId = result.rows[0]?.voice_id || voiceName;

      // 缓存结果
      this.cache.set(cacheKey, {
        voiceId,
        timestamp: Date.now()
      });

      console.log(`[VOICE-CACHE] Cached voice mapping: ${voiceName} -> ${voiceId}`);
      return voiceId;
    } catch (error) {
      this.stats.errors++;
      console.error(`[VOICE-CACHE] Failed to get voice ID for ${voiceName}:`, error);
      return voiceName; // 回退到原始名称
    }
  }

  // 清理过期缓存
  cleanup() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.ttl) {
        this.cache.delete(key);
      }
    }
  }

  // 获取缓存统计
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.cache.size,
      hitRate: this.stats.hits / (this.stats.hits + this.stats.misses) || 0
    };
  }

  // 清空缓存
  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, errors: 0 };
  }
}

// 全局语音ID缓存实例
const voiceIdCache = new VoiceIdCache();

// 定期清理过期缓存（每5分钟）
setInterval(() => {
  voiceIdCache.cleanup();
}, 300000);

// 根据声音名称获取其对应的Voice ID（带缓存优化）
async function getVoiceId(voiceName) {
  return await voiceIdCache.get(voiceName);
}

/**
 * 【新增】使用统一网络管理器的音频生成函数
 * 支持sing-box代理网关和现有代理系统的无缝切换
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function generateSpeechWithGateway(text, voiceId, modelId, stability, similarity_boost, style, speed) {
  const startTime = Date.now();
  const { ttsLogger } = require('./ttsLogger');

  // 创建日志上下文
  const logContext = {
    textLength: text?.length || 0,
    voiceId,
    modelId
  };
  const contextLogger = ttsLogger.createContextLogger({ logContext });

  try {
    // 动态导入网络管理器（避免循环依赖）
    const { networkManager } = require('./networkManager');

    // 记录网关模式启动日志
    contextLogger.logGateway('Starting gateway request', {
      textLength: text?.length || 0,
      voiceId,
      modelId
    });

    // 构建ElevenLabs API请求
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?allow_unauthenticated=1`;

    // 构建voice_settings
    let voice_settings = {};
    if (modelId === 'eleven_turbo_v2_5' || modelId === 'eleven_turbo_v2') {
      voice_settings = {
        stability: stability || 0.5,
        similarity_boost: similarity_boost || 0.75,
        style: style || 0,
        use_speaker_boost: true
      };
      if (speed !== undefined) {
        voice_settings.speed = speed;
      }
    } else {
      voice_settings = {
        stability: stability || 0.5,
        similarity_boost: similarity_boost || 0.75,
        use_speaker_boost: true
      };
    }

    const payload = {
      text: text,
      model_id: modelId || 'eleven_turbo_v2',
      voice_settings: voice_settings
    };

    // 记录网络请求开始
    const requestStartTime = Date.now();
    contextLogger.logGateway('Sending request via network manager', {
      url: contextLogger.sanitizeUrl ? contextLogger.sanitizeUrl(url) : url,
      payloadSize: JSON.stringify(payload).length
    });

    // 使用统一网络管理器发起请求
    const response = await networkManager.request({
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify(payload),
      timeout: 45000
    });

    // 记录网络请求完成
    const requestDuration = Date.now() - requestStartTime;
    contextLogger.logNetwork('POST', url, response.status, requestDuration, {
      responseOk: response.ok
    });

    if (!response.ok) {
      const errorText = await response.text();

      // 复用现有的错误处理逻辑
      const { isContentViolationError } = require('./helpers');
      let errorData, originalMessage;

      try {
        errorData = JSON.parse(errorText);
        originalMessage = errorData?.detail?.message || errorData?.message || errorText;
      } catch (e) {
        originalMessage = errorText;
        errorData = { message: originalMessage };
      }

      // 检测内容违规
      if (isContentViolationError(response.status, errorData, originalMessage)) {
        const violationError = new Error(originalMessage);
        violationError.status = response.status;
        violationError.isContentViolation = true;
        violationError.isDataCenterRetryable = false;
        violationError.originalError = errorData;
        throw violationError;
      }

      // 其他错误
      const error = new Error(`Gateway API error: ${response.status} ${originalMessage}`);
      error.status = response.status;
      error.originalError = errorData;
      throw error;
    }

    // 获取音频数据
    const audioBuffer = await response.arrayBuffer();

    // 记录成功日志
    const totalDuration = Date.now() - startTime;
    contextLogger.logGateway('Request completed successfully', {
      audioSize: audioBuffer.byteLength,
      totalDuration: `${totalDuration}ms`,
      requestDuration: `${requestDuration}ms`
    });

    return audioBuffer;

  } catch (error) {
    const totalDuration = Date.now() - startTime;

    // 如果网络管理器不可用，降级到现有逻辑
    if (error.message.includes('networkManager') || error.message.includes('Cannot resolve module')) {
      contextLogger.logFallback('gateway-networkManager', 'traditional', 'Network manager not available');
      return await generateSpeech(text, voiceId, modelId, stability, similarity_boost, style, speed);
    }

    // 记录网关错误
    contextLogger.logError(error, 'gateway', {
      totalDuration: `${totalDuration}ms`
    });

    throw error;
  }
}

/**
 * 【新增】智能音频生成函数
 * 根据配置自动选择使用网关模式或现有模式
 * @param {string} text - 文本内容
 * @param {string} voiceId - 语音ID
 * @param {string} modelId - 模型ID
 * @param {number} stability - 稳定性参数
 * @param {number} similarity_boost - 相似度增强参数
 * @param {number} style - 风格参数
 * @param {number} speed - 语速参数
 * @returns {Promise<ArrayBuffer>} 音频数据
 */
async function generateSpeechSmart(text, voiceId, modelId, stability, similarity_boost, style, speed) {
  const startTime = Date.now();
  const { ttsLogger } = require('./ttsLogger');

  // 创建日志上下文
  const logContext = {
    textLength: text?.length || 0,
    voiceId,
    modelId
  };
  const contextLogger = ttsLogger.createContextLogger({ logContext });

  try {
    // 检查是否启用了网关模式
    const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
    const config = configAdapter.getConfig();

    // 路由决策日志
    if (config.NETWORK_MODE === 'gateway' && config.ENABLE_SINGBOX_GATEWAY) {
      contextLogger.logRoute('gateway', config);

      const audioBuffer = await generateSpeechWithGateway(text, voiceId, modelId, stability, similarity_boost, style, speed);

      // 记录成功日志
      const duration = Date.now() - startTime;
      contextLogger.logSuccess('gateway', {
        audioSize: audioBuffer.byteLength,
        duration: `${duration}ms`
      });

      return audioBuffer;
    } else {
      contextLogger.logRoute('traditional', config);

      const audioBuffer = await generateSpeech(text, voiceId, modelId, stability, similarity_boost, style, speed);

      // 记录成功日志
      const duration = Date.now() - startTime;
      contextLogger.logSuccess('traditional', {
        audioSize: audioBuffer.byteLength,
        duration: `${duration}ms`
      });

      return audioBuffer;
    }

  } catch (error) {
    const duration = Date.now() - startTime;

    // 如果网关模式失败，直接降级到代理模式
    if (error.message.includes('gateway') || error.message.includes('configAdapter')) {
      contextLogger.logFallback('gateway', 'proxy-direct', error.message);

      try {
        // 直接调用代理重试机制，跳过直连
        const proxyConfig = getTTSProxyConfig();
        const audioBuffer = await callTtsProxyWithSmartRetry(
          text, voiceId, modelId, stability, similarity_boost, style, speed, proxyConfig
        );

        // 记录代理降级成功日志
        const finalDuration = Date.now() - startTime;
        contextLogger.logSuccess('proxy-fallback', {
          audioSize: audioBuffer.byteLength,
          duration: `${finalDuration}ms`,
          originalError: error.message
        });

        return audioBuffer;

      } catch (proxyError) {
        // 检查是否启用直连兜底机制
        const { configAdapter } = require('../gateway/adapters/ConfigAdapter');
        const gatewayConfig = configAdapter.getConfig();

        if (gatewayConfig.GATEWAY_FALLBACK_ENABLE_DIRECT_BACKUP) {
          // 代理失败，最后尝试直连作为兜底
          contextLogger.logFallback('proxy', 'direct-last-resort', proxyError.message);

          try {
            const audioBuffer = await callDirectElevenLabs(text, voiceId, modelId, stability, similarity_boost, style, speed);

            // 记录直连兜底成功日志
            const finalDuration = Date.now() - startTime;
            contextLogger.logSuccess('direct-last-resort', {
              audioSize: audioBuffer.byteLength,
              duration: `${finalDuration}ms`,
              gatewayError: error.message,
              proxyError: proxyError.message
            });

            return audioBuffer;

          } catch (directError) {
            // 所有方法都失败
            contextLogger.logError(directError, 'all-methods-failed', {
              duration: `${Date.now() - startTime}ms`,
              gatewayError: error.message,
              proxyError: proxyError.message,
              directError: directError.message
            });

            throw directError;
          }
        } else {
          // 直连兜底被禁用，直接抛出代理错误
          contextLogger.logFallback('proxy-failed', 'task-failed', 'Direct backup disabled by configuration');
          contextLogger.logError(proxyError, 'proxy-fallback-final', {
            duration: `${Date.now() - startTime}ms`,
            gatewayError: error.message,
            proxyError: proxyError.message,
            directBackupEnabled: false
          });

          throw proxyError;
        }
      }
    }

    // 记录错误日志
    contextLogger.logError(error, 'smart', { duration: `${duration}ms` });
    throw error;
  }
}

module.exports = {
  generateUUID,
  splitText,
  splitTextWithSSML,
  splitTextTraditional,
  smartSplitLongText,
  smartSplitLongSentence,
  getVoiceIdMapping,
  generateDateBasedFilename,
  getNextMonthResetTimestamp,
  processChunks,
  generateSpeech,
  storeAudioFile,
  combineAudio,
  getVoiceId,
  // 【新增】多代理相关函数
  selectRandomProxyUrl,
  callTtsProxy,
  callDirectElevenLabs,
  // 【新增】智能代理相关函数
  ProxySelector,
  callTtsProxyWithSmartRetry,
  callSingleTtsProxy,
  // 【新增】网关集成函数
  generateSpeechWithGateway,
  generateSpeechSmart
};
