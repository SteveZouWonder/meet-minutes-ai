/**
 * MM_ai.js — Gemini 调用层
 * 职责:结构化生成调用、single→dual 降级与合并(纯函数)、超长文本 map-reduce、音频路径、动态 maxOutputTokens
 * 依赖:MM_config.js、MM_prompts.js
 * 被谁调用:MM_main.js 的 SUMMARIZING 状态处理
 */

// 文本 token → 会议分钟数的换算(2 小时会议约 3.5 万 token,§3.4),仅用于月度熔断计数
const MM_TEXT_TOKENS_PER_MIN = 292;

// ============================================================
// 底层调用
// ============================================================

/**
 * 调用 Gemini 结构化生成。
 * @param {string} sys        系统指令
 * @param {Array}  parts      用户消息 parts(文本 / fileData)
 * @param {Object} schema     responseSchema
 * @param {number} maxOut     maxOutputTokens
 * @return {Object} 解析后的 JSON
 * @throws 可重试错误(429/5xx)/ 致命错误(4xx)/ 截断错误(mmTruncated=true)
 */
function MM_geminiCall_(sys, parts, schema, maxOut) {
  const cfg = MM_conf_();
  const payload = MM_geminiPayload_(sys, parts, schema, maxOut, cfg.thinkingLevel);

  const r = MM_fetchGemini_(MM_CFG.GLA + '/models/' + cfg.model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload)
  });
  if (r.code !== 200) MM_throwHttp_('Gemini generateContent', r.code, r.text());

  const body = r.json();
  const cand = (body.candidates || [])[0];
  if (!cand) {
    const fb = body.promptFeedback ? JSON.stringify(body.promptFeedback) : '(无 promptFeedback)';
    throw MM_fatal_('Gemini 未返回候选,可能被安全策略拦截: ' + fb);
  }

  const finish = String(cand.finishReason || '');
  const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');

  if (finish === 'MAX_TOKENS') {
    const e = new Error('Gemini 输出被 maxOutputTokens 截断');
    e.mmTruncated = true;
    e.mmRetryable = false;
    throw e;
  }
  if (!text) throw MM_fatal_('Gemini 返回空文本,finishReason=' + finish);

  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('Gemini 输出非合法 JSON(finishReason=' + finish + '): ' + text.slice(0, 200));
    err.mmTruncated = true;      // 视同截断,触发 dual 降级
    err.mmRetryable = false;
    throw err;
  }
}

/**
 * 组装 generateContent 请求体。字段依据 Gemini API 参考(ai.google.dev/api/generate-content)与 Gemini 3 开发者指南:
 *  - responseJsonSchema:标准 JSON Schema;responseSchema 已标记 deprecated。需同时给 responseMimeType。
 *  - thinkingConfig.thinkingLevel:Gemini 3 推荐方式;thinking_budget 为 legacy,且不得与 thinkingLevel 同时出现(400)。
 *  - 不设 temperature:Gemini 3 官方强烈建议保持默认 1.0,低于 1.0 可能导致循环/退化。
 */
function MM_geminiPayload_(sys, parts, schema, maxOut, thinkingLevel) {
  return {
    systemInstruction: { parts: [{ text: sys }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: MM_toJsonSchema_(schema),
      maxOutputTokens: maxOut,
      thinkingConfig: { thinkingLevel: thinkingLevel || 'MINIMAL' }
    }
  };
}

/**
 * MM_prompts.js 的 schema 用的是旧 OpenAPI 子集写法(大写 type、propertyOrdering)。
 * 转成标准 JSON Schema:type 小写、去掉非标准的 propertyOrdering(输出顺序按 properties 定义顺序即可)。
 */
function MM_toJsonSchema_(node) {
  if (Array.isArray(node)) return node.map(MM_toJsonSchema_);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  Object.keys(node).forEach(k => {
    if (k === 'propertyOrdering') return;
    const v = node[k];
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'properties') {
      out.properties = {};
      Object.keys(v).forEach(p => { out.properties[p] = MM_toJsonSchema_(v[p]); });
    } else if (k === 'items') out.items = MM_toJsonSchema_(v);
    else out[k] = v;
  });
  return out;
}

// ============================================================
// 主入口:文本路径
// ============================================================

/**
 * 由转录文本产出双语纪要。
 * @param {Object} meta {title, date, attendees}
 * @param {string} transcript 已压缩的转录文本
 * @return {{data:Object, minutes:number, calls:number, warn:string}}
 */
function MM_summarizeText_(meta, transcript) {
  const tokens = MM_estimateTokens_(transcript);
  const minutes = Math.max(1, Math.round(tokens / MM_TEXT_TOKENS_PER_MIN));
  MM_log_('转录约 ' + tokens + ' token / 折算 ' + minutes + ' 分钟');

  // 分级调用策略:超长走 map-reduce,否则 single(失败降 dual)
  if (tokens >= MM_CFG.MAX_INPUT_TOKENS) {
    const mr = MM_mapReduce_(meta, transcript, tokens);
    return { data: mr.data, minutes: minutes, calls: mr.calls, warn: mr.warn };
  }

  const cfg = MM_conf_();
  if (cfg.aiCall === 'single') {
    try {
      const data = MM_geminiCall_(
        MM_PROMPTS.SYS_BILINGUAL,
        [{ text: MM_userTranscript_(meta, transcript) }],
        MM_SCHEMA_BILINGUAL,
        MM_dynamicMaxOut_(tokens)
      );
      return { data: MM_normalize_(data), minutes: minutes, calls: 1, warn: '' };
    } catch (e) {
      if (!e.mmTruncated) throw e;                 // 429/5xx 等交给上层重试,不在这里降级
      MM_warn_('single 双语输出失败(' + e.message.slice(0, 120) + '),降级 dual');
    }
  }

  const d = MM_dualText_(meta, transcript, tokens);
  return { data: d.data, minutes: minutes, calls: d.calls, warn: d.warn };
}

/** dual 降级:阶段1 出英文 → 阶段2 翻中文 → zip 合并(§7) */
function MM_dualText_(meta, transcript, tokens) {
  const en = MM_geminiCall_(
    MM_PROMPTS.SYS_MONO_EN,
    [{ text: MM_userTranscript_(meta, transcript) }],
    MM_SCHEMA_MONO,
    MM_dynamicMaxOut_(tokens)
  );
  return MM_dualTranslateAndMerge_(en, 2);
}

/** dual 阶段2 + 合并;阶段2 输入是纪要 JSON,token 消耗极低 */
function MM_dualTranslateAndMerge_(en, callsSoFar) {
  let zh = null;
  try {
    zh = MM_geminiCall_(
      MM_PROMPTS.SYS_TRANSLATE_ZH,
      [{ text: MM_userTranslate_(en) }],
      MM_SCHEMA_MONO,
      MM_dynamicMaxOut_(MM_estimateTokens_(JSON.stringify(en)) * 2)
    );
  } catch (e) {
    MM_warn_('dual 阶段2 中文翻译失败: ' + e.message.slice(0, 160));
  }

  if (!zh) {
    return { data: MM_monoToEnOnly_(en), calls: callsSoFar, warn: '中文生成失败(翻译调用未成功),本次只输出英文版' };
  }
  const merged = MM_mergeDual_(en, zh);
  return {
    data: merged.data,
    calls: callsSoFar,
    warn: merged.ok ? '' : '中文生成失败(译文与原文结构不一致:' + merged.reason + '),本次只输出英文版'
  };
}

/**
 * dual 合并 · 纯函数(可脱离 Apps Script 单独验证)。
 * 按结构逐字段 zip {zh: 中.v, en: 英.v};数组按下标对齐。
 * 任一数组长度不一致 → ok=false,回退英文单语。
 * @return {{ok:boolean, data:Object, reason:string}}
 */
function MM_mergeDual_(en, zh) {
  const bad = MM_dualLengthMismatch_(en, zh);
  if (bad) return { ok: false, data: MM_monoToEnOnly_(en), reason: bad };

  const pair = (e, z) => ({ zh: String((z && z.v) || ''), en: String((e && e.v) || '') });
  const out = {
    t: pair(en.t, zh.t),
    s: pair(en.s, zh.s),
    d: (en.d || []).map((e, i) => {
      const p = pair(e, (zh.d || [])[i]);
      p.k = MM_kInt_(e.k);
      return p;
    }),
    a: (en.a || []).map((e, i) => {
      const p = pair(e, (zh.a || [])[i]);
      p.o = String(e.o || '');       // o/u 以英文版为准(阶段2 要求原样透传)
      p.u = String(e.u || '');
      return p;
    }),
    p: (en.p || []).map((e, i) => pair(e, (zh.p || [])[i])),
    g: (en.g || []).map(e => ({ e: String(e.e || ''), z: String(e.z || '') }))
  };
  return { ok: true, data: MM_normalize_(out), reason: '' };
}

/** 长度校验;返回不一致说明,全部一致返回空串 */
function MM_dualLengthMismatch_(en, zh) {
  if (!en || !zh || !en.t || !en.s || !zh.t || !zh.s) return '缺少 t/s 字段';
  const keys = ['d', 'a', 'p'];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const le = (en[k] || []).length, lz = (zh[k] || []).length;
    if (le !== lz) return k + ' 长度 ' + le + ' vs ' + lz;
  }
  return '';
}

/** 单语英文 JSON → 双语结构(zh 留空,_enOnly 标记只输出英文) */
function MM_monoToEnOnly_(en) {
  const one = x => ({ zh: '', en: String((x && x.v) || '') });
  const out = {
    t: one(en && en.t),
    s: one(en && en.s),
    d: ((en && en.d) || []).map(e => { const o = one(e); o.k = MM_kInt_(e.k); return o; }),
    a: ((en && en.a) || []).map(e => { const o = one(e); o.o = String(e.o || ''); o.u = String(e.u || ''); return o; }),
    p: ((en && en.p) || []).map(one),
    g: ((en && en.g) || []).map(e => ({ e: String(e.e || ''), z: String(e.z || '') }))
  };
  out._enOnly = true;
  return MM_normalize_(out);
}

// ============================================================
// map-reduce(仅文本;音频不分段,§3.3)
// ============================================================

function MM_mapReduce_(meta, transcript, tokens) {
  const chunks = MM_chunkByLines_(transcript, MM_CFG.CHUNK_TOKENS);
  MM_log_('超长转录 ' + tokens + ' token,切成 ' + chunks.length + ' 段做 map-reduce');
  if (chunks.length > 12) {
    throw MM_fatal_('转录切出 ' + chunks.length + ' 段,超出单次执行能力。请手动拆分会议后重试');
  }

  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    notes.push(MM_geminiCall_(
      MM_PROMPTS.SYS_CHUNK,
      [{ text: MM_userChunk_(meta, i + 1, chunks.length, chunks[i]) }],
      MM_SCHEMA_CHUNK,
      4096
    ));
  }

  // reduce 只送要点,禁止再送原始转录
  const reduceInput = MM_userReduce_(meta, notes);
  try {
    const data = MM_geminiCall_(
      MM_PROMPTS.SYS_REDUCE,
      [{ text: reduceInput }],
      MM_SCHEMA_REDUCE,
      MM_dynamicMaxOut_(MM_estimateTokens_(reduceInput))
    );
    return { data: MM_normalize_(data), calls: chunks.length + 1, warn: '' };
  } catch (e) {
    if (!e.mmTruncated) throw e;
    MM_warn_('reduce 双语输出失败,降级 dual');
    const en = MM_geminiCall_(
      MM_PROMPTS.SYS_MONO_EN,
      [{ text: reduceInput }],
      MM_SCHEMA_MONO,
      MM_dynamicMaxOut_(MM_estimateTokens_(reduceInput))
    );
    const d = MM_dualTranslateAndMerge_(en, chunks.length + 3);
    return { data: d.data, calls: d.calls, warn: d.warn };
  }
}

/** 按行切块,不破坏说话人边界;单行超限时单独成块(不再硬切) */
function MM_chunkByLines_(text, maxTokens) {
  const lines = String(text || '').split('\n');
  const chunks = [];
  let buf = [], bufTok = 0;
  lines.forEach(line => {
    const t = MM_estimateTokens_(line) + 1;
    if (bufTok + t > maxTokens && buf.length) {
      chunks.push(buf.join('\n'));
      buf = []; bufTok = 0;
    }
    buf.push(line);
    bufTok += t;
  });
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

// ============================================================
// 音频路径
// ============================================================

/**
 * 由 Gemini File API 上的音频直接产出双语纪要(不分段)。
 * @return {{data:Object, minutes:number, calls:number, warn:string}}
 */
function MM_summarizeAudio_(meta, fileUri, mime, seconds) {
  const tokens = MM_estimateAudioTokens_(seconds);
  const parts = [
    { fileData: { mimeType: mime || 'audio/mp4', fileUri: fileUri } },
    { text: MM_userAudio_(meta) }
  ];
  try {
    const data = MM_geminiCall_(MM_PROMPTS.SYS_AUDIO, parts, MM_SCHEMA_BILINGUAL, MM_dynamicMaxOut_(tokens));
    return { data: MM_normalize_(data), minutes: Math.max(1, Math.round(seconds / 60)), calls: 1, warn: '' };
  } catch (e) {
    if (!e.mmTruncated) throw e;
    MM_warn_('音频 single 双语输出失败,降级 dual(需重新读取音频,成本翻倍)');
    const en = MM_geminiCall_(MM_PROMPTS.SYS_MONO_EN, parts, MM_SCHEMA_MONO, MM_dynamicMaxOut_(tokens));
    const d = MM_dualTranslateAndMerge_(en, 3);
    return { data: d.data, minutes: Math.max(1, Math.round(seconds / 60)), calls: d.calls, warn: d.warn };
  }
}

// ============================================================
// 结果规范化(渲染层只面对干净结构)
// ============================================================

function MM_kInt_(k) {
  const n = parseInt(k, 10);
  return (n >= 0 && n <= 3) ? n : 1;      // 越界一律当「待讨论」,不猜
}

function MM_normalize_(o) {
  const src = o || {};
  const str = v => String(v == null ? '' : v).trim();
  const bi = v => ({ zh: str(v && v.zh), en: str(v && v.en) });
  const out = {
    t: bi(src.t),
    s: bi(src.s),
    d: (src.d || []).map(x => ({ zh: str(x.zh), en: str(x.en), k: MM_kInt_(x.k) })).filter(x => x.zh || x.en),
    a: (src.a || []).map(x => ({ zh: str(x.zh), en: str(x.en), o: str(x.o), u: MM_dueDate_(x.u) })).filter(x => x.zh || x.en),
    p: (src.p || []).map(x => ({ zh: str(x.zh), en: str(x.en) })).filter(x => x.zh || x.en),
    g: (src.g || []).map(x => ({ e: str(x.e), z: str(x.z) })).filter(x => x.e && x.z).slice(0, 10)
  };
  if (src._enOnly) out._enOnly = true;
  return out;
}

/** 截止日期规范化:只接受 YYYY-MM-DD,其余一律清空(宁缺毋滥) */
function MM_dueDate_(u) {
  const s = String(u == null ? '' : u).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = MM_parseDate_(s);
  return d ? MM_fmtDate_(d, 'yyyy-MM-dd') : '';
}
