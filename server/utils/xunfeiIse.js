/**
 * 科大讯飞语音评测（流式版）WebSocket 客户端
 * 文档: https://www.xfyun.cn/doc/Ise/IseAPI.html
 */
const crypto = require('crypto');
const WebSocket = require('ws');

const HOST = 'ise-api.xfyun.cn';
const PATH = '/v2/open-ise';

/**
 * 生成鉴权 WebSocket URL
 */
function generateAuthUrl({ apiKey, apiSecret }) {
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64');

  const authorizationOrigin = [
    `api_key="${apiKey}"`,
    'algorithm="hmac-sha256"',
    'headers="host date request-line"',
    `signature="${signature}"`,
  ].join(', ');

  const authorization = Buffer.from(authorizationOrigin).toString('base64');
  const query = new URLSearchParams({ authorization, date, host: HOST });
  return `wss://${HOST}${PATH}?${query}`;
}

/**
 * 去掉 WAV 头，返回裸 PCM；若本身不是 WAV 则原样返回
 */
function extractPcm(audioBuffer) {
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  if (buf.length < 44) return buf;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (chunkId === 'data') {
      return buf.subarray(dataStart, dataStart + chunkSize);
    }
    offset = dataStart + chunkSize;
  }
  // 找不到 data 块时，退回跳过常见 44 字节头
  return buf.subarray(44);
}

/**
 * 按题型包装评测文本（英文试题格式）
 */
function wrapEvalText(text, category = 'read_sentence') {
  const raw = String(text || '').trim();
  // 已带 BOM / 节点标记则不重复包装
  if (raw.startsWith('\uFEFF') || raw.startsWith('[word]') || raw.startsWith('[content]')) {
    return raw.startsWith('\uFEFF') ? raw : `\uFEFF${raw}`;
  }

  if (category === 'read_word') {
    return `\uFEFF[word]\n${raw}`;
  }
  // 句子 / 篇章
  return `\uFEFF[content]\n${raw}`;
}

/**
 * 执行一次口语评测
 * @param {Object} credentials - { appId, apiKey, apiSecret }
 * @param {Object} options
 * @param {string} options.text - 待评测文本
 * @param {Buffer|string} options.audio - 音频 Buffer / base64
 * @param {string} [options.category='read_sentence'] - read_word|read_sentence|read_chapter
 * @param {string} [options.ent='en_vip'] - cn_vip|en_vip
 * @param {number} [options.frameSize=1280] - 每帧 PCM 字节数（约 40ms）
 * @param {number} [options.intervalMs=20] - 帧间隔（离线文件可调小加速）
 * @param {number} [options.timeoutMs=120000]
 * @param {Function} [options.onLog]
 * @returns {Promise<{ xml: string, raw: object }>}
 */
function evaluate(credentials, options) {
  const {
    text,
    audio,
    category = 'read_sentence',
    ent = 'en_vip',
    frameSize = 1280,
    intervalMs = 20,
    timeoutMs = 120000,
    onLog = () => {},
  } = options;

  const { appId, apiKey, apiSecret } = credentials;
  if (!appId || !apiKey || !apiSecret) {
    return Promise.reject(new Error('缺少讯飞凭证: appId / apiKey / apiSecret'));
  }
  if (!text) {
    return Promise.reject(new Error('缺少待评测文本 text'));
  }

  let audioBuf = Buffer.isBuffer(audio)
    ? audio
    : Buffer.from(audio || '', typeof audio === 'string' && !Buffer.isBuffer(audio) ? 'base64' : undefined);

  if (!audioBuf || audioBuf.length === 0) {
    return Promise.reject(new Error('音频数据为空'));
  }

  audioBuf = extractPcm(audioBuf);
  if (audioBuf.length % 2 !== 0) {
    audioBuf = audioBuf.subarray(0, audioBuf.length - 1);
  }

  const evalText = wrapEvalText(text, category);
  const authUrl = generateAuthUrl({ apiKey, apiSecret });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(authUrl);
    let settled = false;
    let timer;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (_) {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(result);
    };

    timer = setTimeout(() => finish(new Error(`评测超时（${timeoutMs}ms）`)), timeoutMs);

    ws.on('open', () => {
      onLog(`WebSocket 已连接，PCM 长度=${audioBuf.length} bytes`);

      // 1) 参数帧 cmd=ssb, status=0
      const ssbFrame = {
        common: { app_id: appId },
        business: {
          sub: 'ise',
          ent,
          category,
          cmd: 'ssb',
          auf: 'audio/L16;rate=16000',
          aue: 'raw',
          text: evalText,
          tte: 'utf-8',
          ttp_skip: true,
          rst: 'entirety',
          ise_unite: '1',
          extra_ability: 'multi_dimension',
        },
        data: { status: 0 },
      };
      onLog(`发送参数帧 category=${category}, ent=${ent}`);
      ws.send(JSON.stringify(ssbFrame));

      // 2) 音频帧 cmd=auw, aus=1/2/4
      let offset = 0;
      let frameIndex = 0;

      const sendNext = () => {
        if (settled || ws.readyState !== WebSocket.OPEN) return;

        const remaining = audioBuf.length - offset;
        let chunkSize = Math.min(frameSize, remaining);
        if (chunkSize % 2 !== 0) chunkSize -= 1;

        // 无剩余数据：补一帧空结束
        const isLast = remaining <= 0 || offset + chunkSize >= audioBuf.length;
        const isFirst = frameIndex === 0;

        let aus;
        let status;
        if (isFirst && isLast) {
          aus = 4;
          status = 2;
        } else if (isFirst) {
          aus = 1;
          status = 1;
        } else if (isLast) {
          aus = 4;
          status = 2;
        } else {
          aus = 2;
          status = 1;
        }

        const chunk = remaining > 0 ? audioBuf.subarray(offset, offset + Math.max(chunkSize, 0)) : Buffer.alloc(0);
        offset += chunk.length;

        const auwFrame = {
          business: { cmd: 'auw', aus },
          data: {
            status,
            data: chunk.toString('base64'),
          },
        };

        if (frameIndex === 0 || isLast || frameIndex % 50 === 0) {
          onLog(`发送音频帧 #${frameIndex} aus=${aus} status=${status} size=${chunk.length}`);
        }
        ws.send(JSON.stringify(auwFrame));
        frameIndex += 1;

        if (!isLast) {
          setTimeout(sendNext, intervalMs);
        } else {
          onLog(`音频发送完毕，共 ${frameIndex} 帧，等待评测结果...`);
        }
      };

      setTimeout(sendNext, 50);
    });

    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.code !== 0) {
          finish(
            new Error(
              `讯飞返回错误: code=${response.code}, message=${response.message || ''}, sid=${response.sid || ''}`
            )
          );
          return;
        }

        // status=2 表示最终结果；data.data 为 base64(xml)
        if (response.data && Number(response.data.status) === 2) {
          const xmlBase64 = response.data.data || '';
          const xml = Buffer.from(xmlBase64, 'base64').toString('utf8');
          onLog('收到最终评测结果');
          finish(null, { xml, raw: response });
        } else if (response.data) {
          onLog(`中间回包 status=${response.data.status}`);
        }
      } catch (e) {
        finish(e);
      }
    });

    ws.on('error', (err) => {
      finish(new Error(`WebSocket 错误: ${err.message}`));
    });

    ws.on('close', (code, reason) => {
      if (!settled) {
        finish(new Error(`连接关闭且未拿到结果: code=${code}, reason=${reason || ''}`));
      }
    });
  });
}

/**
 * 从评测 XML 中提取常用分数字段
 */
function parseScores(xml) {
  const pick = (name) => {
    const m = String(xml || '').match(new RegExp(`${name}="([0-9.]+)"`));
    return m ? parseFloat(m[1]) : null;
  };

  return {
    total_score: pick('total_score'),
    accuracy_score: pick('accuracy_score'),
    fluency_score: pick('fluency_score'),
    integrity_score: pick('integrity_score'),
    phone_score: pick('phone_score'),
    standard_score: pick('standard_score'),
  };
}

module.exports = {
  generateAuthUrl,
  extractPcm,
  wrapEvalText,
  evaluate,
  parseScores,
};
