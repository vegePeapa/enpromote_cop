const xunfeiConfig = require('../config/xunfei.js');
const { logger } = require('../utils/logger');
const { evaluate: xunfeiEvaluate } = require('../utils/xunfeiIse');

/**
 * 将业务侧 category 映射为讯飞题型
 */
function mapCategory(category) {
  switch (category) {
    case 'word':
    case 'read_word':
      return 'read_word';
    case 'paragraph':
    case 'chapter':
    case 'read_chapter':
      return 'read_chapter';
    case 'free':
    case 'topic':
      return 'topic';
    case 'sentence':
    case 'read_sentence':
    default:
      return 'read_sentence';
  }
}

/**
 * 科大讯飞口语评测服务（流式版 open-ise）
 */
class XunfeiIseService {
  /**
   * 执行口语评测
   * @param {Object} options - 评测参数
   * @param {Buffer} audioData - 音频数据（pcm / wav）
   * @returns {Promise<Object>} 评测结果
   */
  async evaluate(options, audioData) {
    const {
      text,
      category = 'sentence',
      ent = 'en_vip',
    } = options;

    if (!text) {
      throw new Error('待评测文本不能为空');
    }
    if (!audioData || audioData.length === 0) {
      throw new Error('音频数据为空');
    }

    const businessCategory = mapCategory(category);
    const credentials = {
      appId: xunfeiConfig.appId,
      apiKey: xunfeiConfig.apiKey,
      apiSecret: xunfeiConfig.apiSecret,
    };

    const mask = (value) => {
      if (!value) return '';
      if (value.length <= 8) return `${value.slice(0, 2)}****${value.slice(-2)}`;
      return `${value.slice(0, 4)}****${value.slice(-4)}`;
    };

    logger.info('开始科大讯飞口语评测', {
      category: businessCategory,
      ent,
      textLength: String(text).length,
      audioBytes: audioData.length,
      xunfeiAppId: credentials.appId,
      xunfeiApiKey: mask(credentials.apiKey),
      xunfeiApiSecret: mask(credentials.apiSecret),
    });

    try {
      const { xml, raw } = await xunfeiEvaluate(credentials, {
        text,
        audio: audioData,
        category: businessCategory,
        ent,
        intervalMs: 20,
        timeoutMs: 120000,
        onLog: (msg) => logger.debug(`[xunfei-ise] ${msg}`),
      });

      const result = this.parseResult(xml);
      logger.info('科大讯飞口语评测完成', {
        sid: raw?.sid,
        overallScore: result.overallScore,
      });
      return result;
    } catch (error) {
      logger.error('科大讯飞口语评测失败:', error.message || error);
      throw error;
    }
  }

  /**
   * 解析评测结果
   * @param {string} xml - 原始结果 XML 字符串
   * @returns {Object} 解析后的结果
   */
  parseResult(xml) {
    try {
      const safeXml = typeof xml === 'string' ? xml : '';

      const pick = (name) => {
        const m = safeXml.match(new RegExp(`${name}="([0-9.]+)"`));
        return m ? parseFloat(m[1]) : 0;
      };

      const overallScore = pick('total_score');
      const accuracy = pick('accuracy_score');
      const fluency = pick('fluency_score');
      const integrity = pick('integrity_score');
      const pronunciation = pick('phone_score') || pick('standard_score');
      const details = this.parseDetails(safeXml);

      return {
        overallScore: overallScore || 0,
        dimensions: {
          accuracy: accuracy || 0,
          fluency: fluency || 0,
          integrity: integrity || 0,
          pronunciation: pronunciation || 0,
          speed: 0,
          intonation: 0,
        },
        details,
        raw: safeXml,
      };
    } catch (error) {
      logger.error('解析评测结果失败:', error);
      return {
        overallScore: 0,
        dimensions: {
          accuracy: 0,
          fluency: 0,
          integrity: 0,
          pronunciation: 0,
          speed: 0,
          intonation: 0,
        },
        details: {
          words: [],
          phonemes: [],
        },
        raw: null,
      };
    }
  }

  parseDetails(xml) {
    const details = {
      words: [],
      phonemes: [],
    };

    const wordRegex = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
    let wordMatch;

    while ((wordMatch = wordRegex.exec(xml)) !== null) {
      const attrText = wordMatch[1] || '';
      const body = wordMatch[2] || '';
      const wordText = this.decodeXml(this.getAttr(attrText, 'content'));
      if (!wordText || wordText.toLowerCase() === 'sil') {
        continue;
      }

      const wordScore = parseFloat(this.getAttr(attrText, 'total_score')) || 0;
      const begPos = parseInt(this.getAttr(attrText, 'beg_pos'), 10);
      const endPos = parseInt(this.getAttr(attrText, 'end_pos'), 10);
      const timeLen = Number.isNaN(begPos) || Number.isNaN(endPos) ? 0 : Math.max(0, endPos - begPos);
      const phonemes = [];

      const syllRegex = /<syll\b([^>]*)>([\s\S]*?)<\/syll>/gi;
      let syllMatch;
      while ((syllMatch = syllRegex.exec(body)) !== null) {
        const syllAttr = syllMatch[1] || '';
        const syllBody = syllMatch[2] || '';
        const syllScore = parseFloat(this.getAttr(syllAttr, 'syll_score')) || 0;

        const phoneRegex = /<phone\b([^>]*)\/?>(?:<\/phone>)?/gi;
        let phoneMatch;
        while ((phoneMatch = phoneRegex.exec(syllBody)) !== null) {
          const phoneAttr = phoneMatch[1] || '';
          const phoneText = this.decodeXml(this.getAttr(phoneAttr, 'content'));
          if (!phoneText) continue;
          const phoneScore = syllScore || wordScore || 0;
          const phoneme = {
            text: phoneText,
            score: Math.round(phoneScore),
          };
          phonemes.push(phoneme);
          details.phonemes.push(phoneme);
        }
      }

      details.words.push({
        text: wordText,
        score: Math.round(wordScore),
        timeLen,
        phonemes,
      });
    }

    return details;
  }

  getAttr(attrText, name) {
    const match = attrText.match(new RegExp(`${name}="([^"]*)"`));
    return match ? match[1] : '';
  }

  decodeXml(text) {
    return String(text || '')
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  /**
   * 生成评测建议
   * @param {Object} result - 评测结果
   * @returns {Object} 评测建议
   */
  generateAdvice(result) {
    const { overallScore, dimensions } = result;
    const advice = {
      overall: '',
      accuracy: '',
      fluency: '',
      integrity: '',
      pronunciation: '',
      speed: '',
      intonation: '',
    };

    if (overallScore >= 90) {
      advice.overall = '发音非常标准，继续保持！';
    } else if (overallScore >= 80) {
      advice.overall = '发音良好，还有提升空间';
    } else if (overallScore >= 60) {
      advice.overall = '发音基本正确，需要加强练习';
    } else {
      advice.overall = '发音需要改进，请多听多练';
    }

    if (dimensions.accuracy >= 80) {
      advice.accuracy = '发音准确度很好';
    } else if (dimensions.accuracy >= 60) {
      advice.accuracy = '注意一些单词的发音细节';
    } else {
      advice.accuracy = '需要加强单词发音的准确性';
    }

    if (dimensions.fluency >= 80) {
      advice.fluency = '流利度很好，语速适中';
    } else if (dimensions.fluency >= 60) {
      advice.fluency = '注意语速和停顿';
    } else {
      advice.fluency = '需要提高流利度，多练习';
    }

    if (dimensions.integrity >= 80) {
      advice.integrity = '朗读完整，没有遗漏';
    } else if (dimensions.integrity >= 60) {
      advice.integrity = '注意不要遗漏单词';
    } else {
      advice.integrity = '需要提高朗读的完整性';
    }

    if (dimensions.pronunciation >= 80) {
      advice.pronunciation = '发音标准，语音语调自然';
    } else if (dimensions.pronunciation >= 60) {
      advice.pronunciation = '注意语音语调的准确性';
    } else {
      advice.pronunciation = '需要加强发音练习';
    }

    if (dimensions.speed >= 80) {
      advice.speed = '语速适中，表达流畅';
    } else if (dimensions.speed >= 60) {
      advice.speed = '语速基本合适，可以适当调整';
    } else {
      advice.speed = '语速需要调整，建议多练习';
    }

    if (dimensions.intonation >= 80) {
      advice.intonation = '语调自然，抑扬顿挫';
    } else if (dimensions.intonation >= 60) {
      advice.intonation = '语调基本自然，可以更加生动';
    } else {
      advice.intonation = '需要加强语调练习';
    }

    return advice;
  }
}

module.exports = new XunfeiIseService();
