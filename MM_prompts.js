/**
 * MM_prompts.js — 会议双语纪要系统 · 提示词与 responseSchema
 * 职责:集中存放 6 套系统指令 + 4 套结构化输出 schema(不得散落到业务代码)
 * 依赖:无
 * 被谁调用:MM_ai.js
 *
 * 设计约束(IMPLEMENTATION_PROMPT · RUNTIME PROMPT SPEC):
 *  - 系统指令一律英文(同义比中文省 30~40% token)
 *  - 短键名 schema 省输出 token
 *  - 提示词内禁止贴 JSON 示例,格式完全由 responseSchema 约束
 *  - 决策状态只输出枚举码 k,文案映射在渲染层(MM_CFG.DECISION_LABEL)
 */

const MM_STR = { type: 'STRING' };

// ---- 键名释义:所有变体共用同一段说明,避免重复叙述 ----
const MM_KEYDOC = [
  'Output keys: t=title, s=summary, d=decisions, a=action items, p=topic details, g=glossary.',
  'In d[], k is the decision status enum: 0=aligned, 1=needs further discussion, 2=disagreement remains, 3=parked/deferred.',
  'In a[], o=owner and u=due date. Set o to the person the transcript attributes the task to; if nobody is named, use an empty string. Never guess an owner.',
  'Set u to an ISO 8601 date (YYYY-MM-DD) only when the transcript states one; otherwise use an empty string. Resolve relative dates ("next Friday") against the meeting date given in the user message.',
  'g[] maps recurring domain terms: e=English term, z=Chinese term. At most 10 entries, only for terms that actually matter. Omit the key entirely if there are none.'
].join('\n');

const MM_RULES = [
  'Rules:',
  '- Extract only what was actually said. Never invent facts, owners, dates, numbers or decisions.',
  '- Drop greetings, small talk, filler and off-topic chatter.',
  '- One sentence per list item. Be specific: prefer "cut p99 latency to 200ms" over "improve performance".',
  '- Keep every summary field under 120 words per language.',
  '- If the meeting produced no decisions or no action items, return an empty array for that key rather than padding it.',
  '- Preserve product names, metrics, code identifiers and proper nouns verbatim in both languages.'
].join('\n');

const MM_ZH_RULE = 'Chinese text must read as natural Simplified Chinese written by a native speaker: idiomatic, not a literal word-by-word rendering of the English. Both languages must carry identical information.';

// ============================================================
// 系统指令 · 6 套变体
// ============================================================
const MM_PROMPTS = {

  /** 主路径:一次调用出双语(§6.1 AI_CALL='single') */
  SYS_BILINGUAL: [
    'You are a bilingual (Chinese/English) meeting-minutes analyst. The transcript may mix Mandarin and English within the same sentence; treat it as one language stream.',
    'Produce structured minutes where every text field carries both a Chinese (zh) and an English (en) version of the same content.',
    MM_KEYDOC,
    MM_ZH_RULE,
    MM_RULES
  ].join('\n\n'),

  /** dual 降级 · 阶段1:只出英文,文本字段统一为 v */
  SYS_MONO_EN: [
    'You are a meeting-minutes analyst. The transcript may mix Mandarin and English; treat it as one language stream.',
    'Produce structured minutes in English only. Every text field uses the single key v.',
    MM_KEYDOC.replace('e=English term, z=Chinese term', 'e=English term, z=its Chinese equivalent'),
    MM_RULES
  ].join('\n\n'),

  /** dual 降级 · 阶段2:输入是阶段1的英文 JSON(不是原始转录),输出同构中文 JSON */
  SYS_TRANSLATE_ZH: [
    'You are a technical translator. The user message contains meeting minutes as JSON.',
    'Translate every v field into Simplified Chinese and return the same JSON structure with the same keys.',
    'Critical: preserve array order and array length exactly. The Nth element of every output array must correspond to the Nth element of the input array. Do not merge, split, reorder, add or drop any element.',
    'Do not translate or alter the o, u and k values — copy them through unchanged. Owner names stay in their original form.',
    MM_ZH_RULE,
    'Keep product names, metrics, code identifiers and proper nouns in their original English form inside the Chinese text.'
  ].join('\n\n'),

  /** 音频路径:模型内部转写后直接出双语 */
  SYS_AUDIO: [
    'You are a bilingual (Chinese/English) meeting-minutes analyst working directly from a meeting audio recording.',
    'The speakers frequently code-switch between Mandarin and English inside the same sentence. Transcribe internally in whatever language was spoken, then produce the minutes.',
    'Speaker names are usually unknown. Distinguish speakers by voice and label them S1, S2, S3 ... Use those labels as the owner value in a[] when a task is assigned to a specific voice. If a speaker states their own name, use that name instead.',
    'Ignore inaudible segments rather than guessing at their content.',
    MM_KEYDOC,
    MM_ZH_RULE,
    MM_RULES
  ].join('\n\n'),

  /** map 阶段:超长转录分段压缩成英文要点 */
  SYS_CHUNK: [
    'You are compressing one contiguous chunk of a long meeting transcript. This is a partial view: earlier and later chunks exist and you cannot see them.',
    'Return three English string arrays: p = key points (at most 12), d = decisions stated verbatim-in-substance, a = action items including any owner and due date mentioned inline.',
    'Do not write a summary, a conclusion, or any meta commentary about the chunk. Do not speculate about what happened outside this chunk.',
    'Keep speaker attribution inline when a point matters for ownership, e.g. "Zhang San will own the billing refactor, due 2026-09-15".',
    'Return empty arrays for keys with nothing to report.'
  ].join('\n\n'),

  /** reduce 阶段:合并有序分段要点出双语(只送要点,禁止再送原始转录) */
  SYS_REDUCE: [
    'You are assembling final bilingual (Chinese/English) meeting minutes from ordered per-chunk notes of a single long meeting. The chunks are in chronological order.',
    'Merge duplicates across chunks, resolve items that were raised in one chunk and settled in a later one (the later state wins), and drop points that were superseded.',
    'Produce structured minutes where every text field carries both a Chinese (zh) and an English (en) version.',
    MM_KEYDOC,
    MM_ZH_RULE,
    MM_RULES
  ].join('\n\n')
};

// ============================================================
// responseSchema · 4 套
// 说明:Gemini 结构化输出使用 OpenAPI 子集,类型名大写。
//      propertyOrdering 稳定输出顺序,降低截断时的解析损失。
// ============================================================

/** 双语(主 schema) */
const MM_SCHEMA_BILINGUAL = {
  type: 'OBJECT',
  properties: {
    t: { type: 'OBJECT', properties: { zh: MM_STR, en: MM_STR }, required: ['zh', 'en'], propertyOrdering: ['zh', 'en'] },
    s: { type: 'OBJECT', properties: { zh: MM_STR, en: MM_STR }, required: ['zh', 'en'], propertyOrdering: ['zh', 'en'] },
    d: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { zh: MM_STR, en: MM_STR, k: { type: 'INTEGER' } },
        required: ['zh', 'en', 'k'], propertyOrdering: ['zh', 'en', 'k']
      }
    },
    a: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { zh: MM_STR, en: MM_STR, o: MM_STR, u: MM_STR },
        required: ['zh', 'en', 'o', 'u'], propertyOrdering: ['zh', 'en', 'o', 'u']
      }
    },
    p: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { zh: MM_STR, en: MM_STR },
        required: ['zh', 'en'], propertyOrdering: ['zh', 'en']
      }
    },
    g: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { e: MM_STR, z: MM_STR },
        required: ['e', 'z'], propertyOrdering: ['e', 'z']
      }
    }
  },
  required: ['t', 's', 'd', 'a', 'p'],
  propertyOrdering: ['t', 's', 'd', 'a', 'p', 'g']
};

/** 单语(dual 降级两个阶段共用):文本字段统一为 v */
const MM_SCHEMA_MONO = {
  type: 'OBJECT',
  properties: {
    t: { type: 'OBJECT', properties: { v: MM_STR }, required: ['v'] },
    s: { type: 'OBJECT', properties: { v: MM_STR }, required: ['v'] },
    d: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { v: MM_STR, k: { type: 'INTEGER' } }, required: ['v', 'k'], propertyOrdering: ['v', 'k'] }
    },
    a: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { v: MM_STR, o: MM_STR, u: MM_STR }, required: ['v', 'o', 'u'], propertyOrdering: ['v', 'o', 'u'] }
    },
    p: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { v: MM_STR }, required: ['v'] }
    },
    g: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { e: MM_STR, z: MM_STR }, required: ['e', 'z'], propertyOrdering: ['e', 'z'] }
    }
  },
  required: ['t', 's', 'd', 'a', 'p'],
  propertyOrdering: ['t', 's', 'd', 'a', 'p', 'g']
};

/** 分段(map 阶段):三个英文字符串数组 */
const MM_SCHEMA_CHUNK = {
  type: 'OBJECT',
  properties: {
    p: { type: 'ARRAY', items: MM_STR },
    d: { type: 'ARRAY', items: MM_STR },
    a: { type: 'ARRAY', items: MM_STR }
  },
  required: ['p', 'd', 'a'],
  propertyOrdering: ['p', 'd', 'a']
};

/** reduce 阶段复用双语 schema */
const MM_SCHEMA_REDUCE = MM_SCHEMA_BILINGUAL;

// ============================================================
// 用户消息组装(元信息 + 正文;元信息用于解析相对日期)
// ============================================================

/** 会议元信息前缀:让模型能把「下周五」解析成绝对日期 */
function MM_metaHeader_(meta) {
  const m = meta || {};
  const lines = ['MEETING TITLE: ' + (m.title || 'Untitled')];
  if (m.date) lines.push('MEETING DATE: ' + m.date);
  if (m.attendees && m.attendees.length) lines.push('KNOWN PARTICIPANTS: ' + m.attendees.join(', '));
  return lines.join('\n');
}

/** 转录正文的用户消息 */
function MM_userTranscript_(meta, transcript) {
  return MM_metaHeader_(meta) + '\n\nTRANSCRIPT:\n' + transcript;
}

/** 音频路径的用户消息(音频本体作为独立 part 传入) */
function MM_userAudio_(meta) {
  return MM_metaHeader_(meta) + '\n\nThe meeting audio is attached. Produce the minutes.';
}

/** map 阶段的用户消息 */
function MM_userChunk_(meta, idx, total, chunk) {
  return MM_metaHeader_(meta) + '\n\nCHUNK ' + idx + ' OF ' + total + ':\n' + chunk;
}

/** reduce 阶段的用户消息(只送分段要点,禁止再送原始转录) */
function MM_userReduce_(meta, notes) {
  const body = notes.map((n, i) => {
    const seg = ['--- CHUNK ' + (i + 1) + ' ---'];
    if (n.p && n.p.length) seg.push('POINTS:\n' + n.p.map(x => '- ' + x).join('\n'));
    if (n.d && n.d.length) seg.push('DECISIONS:\n' + n.d.map(x => '- ' + x).join('\n'));
    if (n.a && n.a.length) seg.push('ACTIONS:\n' + n.a.map(x => '- ' + x).join('\n'));
    return seg.join('\n');
  }).join('\n\n');
  return MM_metaHeader_(meta) + '\n\nCHUNK NOTES (chronological):\n' + body;
}

/** dual 阶段2 的用户消息:输入是阶段1的英文 JSON */
function MM_userTranslate_(enJson) {
  return 'Translate this minutes JSON into Simplified Chinese, preserving structure and array lengths:\n' + JSON.stringify(enJson);
}
