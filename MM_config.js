/**
 * MM_config.js — 会议双语纪要系统 · 配置与通用工具
 * 职责:集中配置(支持脚本属性覆盖)、执行预算、错误分类、HTTP 封装、token 估算、日志
 * 依赖:无(本文件必须无外部依赖,其余 MM_* 文件全部依赖它)
 * 被谁调用:所有 MM_* 文件
 */

// ============================================================
// 静态配置。可覆盖项见 MM_conf_(),覆盖方式为同名脚本属性(读取工具:MM_prop_ / MM_num_ / MM_enum_)
// ============================================================
const MM_CFG = {
  // ---- 端点 ----
  GLA: 'https://generativelanguage.googleapis.com/v1beta',        // Gemini 生成 API
  GLA_UPLOAD: 'https://generativelanguage.googleapis.com/upload/v1beta', // Gemini File API 上传通道
  MEET_API: 'https://meet.googleapis.com/v2',
  CAL_API: 'https://www.googleapis.com/calendar/v3',
  MODEL: 'gemini-3.6-flash',                                      // 可用脚本属性 MM_MODEL 覆盖
  // Gemini 3 系列用 thinkingLevel 控制推理深度(官方:thinking_budget 仅向后兼容,且 Gemini 3 无法完全关闭思考)。
  // MINIMAL = "matches the no-thinking setting",纪要抽取用它即可(§9)。可用脚本属性 MM_THINKING_LEVEL 覆盖。
  THINKING_LEVEL: 'MINIMAL',

  // ---- 输出规格(REQUIREMENTS §6.1)----
  OUTPUT: {
    LANG: 'both',        // 'both' | 'zh' | 'en'
    FILE_MODE: 'split',  // 'split' | 'merged'
    DELIVER: 'both',     // 'both' | 'email' | 'doc'
    AI_CALL: 'single'    // 'single' | 'dual'
  },
  MAIL_POLICY: 'organizer',   // 'organizer' | 'attendees'(§6.4,禁止全局广播)
  // 处理哪些日历会议(可用脚本属性 MM_EVENT_SCOPE 覆盖):
  //   organizer = 只处理我组织的(原 §11-Q5 定案)
  //   accepted  = 我组织的 + 我已接受邀请的(默认;他人组织的会议也能出纪要,已拒绝的不处理)
  //   all       = 所有带 Meet 链接且未拒绝的会议
  EVENT_SCOPE: 'accepted',

  // ---- Doc 落点与可见范围 ----
  // 落点:中英文版(及 merged 合并版)默认都落在所有者的私人文件夹 ZH_FOLDER,不放进会议目录
  //       (Google Meet/<会议名>/)。EN_FOLDER 留空 = 与中文版同夹;填名字则英文版单独一夹;
  //       填 'meeting' 恢复旧行为(跟随源转录 Doc 所在目录 → Google Meet → 会议纪要)。
  // 共享:默认 'owner' —— 中英文版都只有所有者可见,由所有者手动分享。
  //       设为 'domain' 时英文版对 SHARE_DOMAINS 列出的组织域「知道链接者可查看」(不可搜索,不发通知),
  //       SHARE_DOMAINS 为空或域共享被策略拦截时自动回退为「参会人可查看」。中文版任何模式下都不共享,不出现在 Jira。
  DOC_SHARE: 'owner',                           // 'owner' | 'domain' | 'attendees' | 'anyone'(不推荐);脚本属性 MM_DOC_SHARE
  SHARE_DOMAINS: [],                            // 脚本属性 MM_SHARE_DOMAINS(逗号分隔,如 'example.com,corp.example.com')
  ZH_FOLDER: '会议纪要（中文·私人）',              // 脚本属性 MM_ZH_FOLDER
  EN_FOLDER: '',                                 // 脚本属性 MM_EN_FOLDER:'' 同 ZH_FOLDER | '<文件夹名>' | 'meeting'

  // ---- 按人订阅(优先级低于项目共享、高于 DOC_SHARE;与 DOC_SHARE 叠加而非互斥)----
  // SUBSCRIBERS 里的人,只要出现在这场会的参会人列表中,就收到纪要邮件并获得英文 Doc 的查看权限。
  // 这是「同事不自建实例、由所有者代跑」时的核心开关:按人订阅,不做全员广播。
  SUBSCRIBERS: [],                              // 脚本属性 MM_SUBSCRIBERS(逗号分隔邮箱)
  MAIL_TO_ORGANIZER: false,                     // 脚本属性 MM_MAIL_TO_ORGANIZER=on:他人组织的会,邮件 to 加上组织者

  // ---- 按项目共享(优先级最高,见 MM_members.js)----
  // 会议命中某个项目(标题含该项目票号,或匹配 keywords 正则)时,英文版对「项目组成员」逐人开 reader,
  // 不看是否参会;成员来自 Jira:最近 jiraDays 天内该项目 issue 的 assignee / reporter(缓存 24h)。
  // 未命中任何项目 → 回到 SUBSCRIBERS + DOC_SHARE。默认没有任何项目规则。
  // 脚本属性覆盖:MM_PROJECT_SHARE(整段 JSON,如 {"PROJ":{"keywords":["\\bmy\\s*project\\b"],"jiraDays":120}})、
  //               MM_MEMBERS_<KEY>(固定名单,设了就不查 Jira)、MM_MEMBERS_EXTRA_<KEY> / MM_MEMBERS_EXCLUDE_<KEY>(逗号分隔,增/减)
  PROJECT_SHARE: {},
  MEMBER_DOMAINS: [],                           // 成员邮箱域白名单(留空 = 不限制);脚本属性 MM_MEMBER_DOMAINS
  MEMBERS_CACHE_HOURS: 24,

  // ---- Jira 同步(标题含票号如 PROJ-1234 时,纪要完成后自动评论到该票)----
  // 需要同时配置脚本属性 JIRA_BASE_URL(如 https://your-org.atlassian.net)与 JIRA_API_TOKEN,缺任一项即整体关闭。
  JIRA: {
    BASE_URL: '',                               // 脚本属性 JIRA_BASE_URL
    STYLE: 'links',                             // 'links' = 短卡片(标题+英文 Doc 链接+统计) | 'full' = 完整英文纪要;脚本属性 MM_JIRA_STYLE
                                                // 评论内容一律纯英文,不含任何中文
    P_USER: 'JIRA_USER',                        // 脚本属性:Atlassian 账号邮箱(缺省用脚本所有者邮箱)
    P_TOKEN: 'JIRA_API_TOKEN',                  // 脚本属性:API token(C3:只从属性读,走请求头)
    KEY_RE: /\b([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g
  },

  // ---- 调度与预算(§4.6)----
  EXEC_BUDGET_MS: 50000,      // 超过即收尾退出(硬要求单次 ≤ 60 秒)
  LOCK_WAIT_MS: 30000,        // C12
  MAX_HEAVY_PER_RUN: 2,       // 每轮昂贵步骤上限
  POLL_WINDOW_HOURS: 12,      // §4.4 轮询窗口
  BACKFILL_LOOKBACK_HOURS: 2, // §4.2 增量规划回看窗口
  PLAN_AHEAD_HOURS: 24,       // planner 前瞻窗口
  MAX_RETRY: 3,               // C14
  RESULT_TTL_DAYS: 30,        // C15 result_json 清理阈值

  // ---- 成本控制(§9)----
  MAX_MONTHLY_MINUTES: 1200,  // §11-Q4 月度熔断
  MAX_INPUT_TOKENS: 250000,   // 超过走 map-reduce(文本)/ 直接 FAILED(音频)
  CHUNK_TOKENS: 60000,        // map 阶段切块大小
  AUDIO_TOKENS_PER_SEC: 32,   // §3.3 音频 token 估算系数
  AUDIO_ASSUMED_KBPS: 32,     // 无法读取音频真实时长时,按此码率从体积反推秒数
  AUDIO_MAX_BYTES: 50 * 1024 * 1024, // C6 Apps Script URLFetch POST 上限

  // ---- Drive(§11-Q2)----
  AUDIO_FOLDER: '会议录音',
  AUDIO_DONE_SUB: '已处理',
  AUDIO_MINUTES_SUB: '纪要',
  MEET_FOLDERS: ['Google Meet', 'Meet Recordings'],
  AUDIO_MIME_PREFIXES: ['audio/'],
  AUDIO_EXT: ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'flac', 'opus', 'mp4a'],

  // ---- 脚本属性 key ----
  P_SHEET_ID: 'MM_SHEET_ID',
  P_GEMINI_KEY: 'GEMINI_API_KEY',

  // ---- 决策状态码 → 双语文案(§6.3;不让模型输出文案,省 token)----
  DECISION_LABEL: {
    0: { zh: '已对齐', en: 'Aligned' },
    1: { zh: '待讨论', en: 'To discuss' },
    2: { zh: '有分歧', en: 'Disputed' },
    3: { zh: '已搁置', en: 'Parked' }
  }
};

// ============================================================
// 脚本属性读取:属性优先,缺失回落到静态配置
// 单次执行内做快照缓存 —— MM_conf_() 会被每个任务、每个事件反复调用,
// 逐个 getProperty 走的是 Apps Script 服务调用,不缓存会白白吃掉几秒预算。
// ============================================================
let MM_PROPS_CACHE_ = null;
let MM_CONF_CACHE_ = null;

function MM_props_() {
  if (!MM_PROPS_CACHE_) MM_PROPS_CACHE_ = PropertiesService.getScriptProperties().getProperties();
  return MM_PROPS_CACHE_;
}

/** 写属性后必须调用,否则读到旧快照 */
function MM_resetCache_() { MM_PROPS_CACHE_ = null; MM_CONF_CACHE_ = null; }

/** 读字符串属性;def 为默认值 */
function MM_prop_(key, def) {
  const v = MM_props_()[key];
  return (v === undefined || v === null || v === '') ? def : v;
}

/** 读数值属性;非法值回落默认 */
function MM_num_(key, def) {
  const v = Number(MM_prop_(key, NaN));
  return isFinite(v) ? v : def;
}

/** 读 JSON 对象属性;缺失或解析失败回落默认(并告警,避免静默改变共享范围) */
function MM_json_(key, def) {
  const raw = MM_prop_(key, '');
  if (!raw) return def;
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : def;
  } catch (e) {
    MM_warn_('脚本属性 ' + key + ' 不是合法 JSON,使用默认值: ' + e.message);
    return def;
  }
}

/** 读枚举属性;不在 allowed 内回落默认 */
function MM_enum_(key, allowed, def) {
  const v = MM_prop_(key, def);
  return allowed.indexOf(v) >= 0 ? v : def;
}

/** 组装本次运行的有效配置(属性覆盖已生效;单次执行内只算一次) */
function MM_conf_() {
  if (MM_CONF_CACHE_) return MM_CONF_CACHE_;
  MM_CONF_CACHE_ = {
    model: MM_prop_('MM_MODEL', MM_CFG.MODEL),
    thinkingLevel: MM_enum_('MM_THINKING_LEVEL', ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'], MM_CFG.THINKING_LEVEL),
    lang: MM_enum_('MM_LANG', ['both', 'zh', 'en'], MM_CFG.OUTPUT.LANG),
    fileMode: MM_enum_('MM_FILE_MODE', ['split', 'merged'], MM_CFG.OUTPUT.FILE_MODE),
    deliver: MM_enum_('MM_DELIVER', ['both', 'email', 'doc'], MM_CFG.OUTPUT.DELIVER),
    aiCall: MM_enum_('MM_AI_CALL', ['single', 'dual'], MM_CFG.OUTPUT.AI_CALL),
    mailPolicy: MM_enum_('MM_MAIL_POLICY', ['organizer', 'attendees'], MM_CFG.MAIL_POLICY),
    eventScope: MM_enum_('MM_EVENT_SCOPE', ['organizer', 'accepted', 'all'], MM_CFG.EVENT_SCOPE),
    jiraStyle: MM_enum_('MM_JIRA_STYLE', ['links', 'full'], MM_CFG.JIRA.STYLE),
    docShare: MM_enum_('MM_DOC_SHARE', ['owner', 'domain', 'attendees', 'anyone'], MM_CFG.DOC_SHARE),
    shareDomains: MM_list_('MM_SHARE_DOMAINS', MM_CFG.SHARE_DOMAINS),
    zhFolder: MM_prop_('MM_ZH_FOLDER', MM_CFG.ZH_FOLDER),
    enFolder: String(MM_prop_('MM_EN_FOLDER', MM_CFG.EN_FOLDER) || '').trim(),
    subscribers: MM_list_('MM_SUBSCRIBERS', MM_CFG.SUBSCRIBERS),
    mailToOrganizer: MM_prop_('MM_MAIL_TO_ORGANIZER', MM_CFG.MAIL_TO_ORGANIZER ? 'on' : 'off') === 'on',
    projectShare: MM_json_('MM_PROJECT_SHARE', MM_CFG.PROJECT_SHARE),
    memberDomains: MM_list_('MM_MEMBER_DOMAINS', MM_CFG.MEMBER_DOMAINS),
    jiraBase: String(MM_prop_('JIRA_BASE_URL', MM_CFG.JIRA.BASE_URL) || '').trim().replace(/\/+$/, ''),
    maxHeavy: MM_num_('MM_MAX_HEAVY_PER_RUN', MM_CFG.MAX_HEAVY_PER_RUN),
    maxMonthlyMinutes: MM_num_('MM_MAX_MONTHLY_MINUTES', MM_CFG.MAX_MONTHLY_MINUTES),
    pollHours: MM_num_('MM_POLL_WINDOW_HOURS', MM_CFG.POLL_WINDOW_HOURS),
    maxRetry: MM_num_('MM_MAX_RETRY', MM_CFG.MAX_RETRY),
    audioFolder: MM_prop_('MM_AUDIO_FOLDER', MM_CFG.AUDIO_FOLDER),
    weeklyDigest: MM_prop_('MM_WEEKLY_DIGEST', 'on') !== 'off'
  };
  // Jira 同步三个条件缺一即关:开关未关、有站点地址、有 token
  MM_CONF_CACHE_.jiraSync = MM_prop_('MM_JIRA_SYNC', 'on') !== 'off'
    && !!MM_CONF_CACHE_.jiraBase && !!MM_prop_(MM_CFG.JIRA.P_TOKEN, '');
  return MM_CONF_CACHE_;
}

/** 读逗号/分号/空白分隔的列表属性 → 小写去空数组;缺失回落默认数组 */
function MM_list_(key, def) {
  const raw = MM_prop_(key, '');
  const src = raw ? String(raw) : (def || []).join(',');
  return src.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Gemini Key(C3:只从脚本属性读,走请求头,绝不入 URL) */
function MM_geminiKey_() {
  const k = MM_prop_(MM_CFG.P_GEMINI_KEY, '');
  if (!k) throw MM_fatal_('脚本属性 ' + MM_CFG.P_GEMINI_KEY + ' 未配置,请先运行 MM_setupOnce()');
  return k;
}

/** 脚本所有者邮箱(唯一的默认收件人,§6.4) */
function MM_owner_() {
  return Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
}

function MM_tz_() { return Session.getScriptTimeZone() || 'Asia/Shanghai'; }

// ============================================================
// 执行预算(C1):脚本级单例,入口函数开头调用 MM_budgetStart_()
// ============================================================
let MM_T0_ = 0;

function MM_budgetStart_() { MM_T0_ = Date.now(); MM_resetCache_(); }

/** 是否已超预算,超了就该收尾退出 */
function MM_outOfBudget_() {
  return (Date.now() - MM_T0_) > MM_CFG.EXEC_BUDGET_MS;
}

function MM_elapsedMs_() { return Date.now() - MM_T0_; }

// ============================================================
// 错误分类(C14):可重试 vs 致命
// ============================================================

/** 构造可重试错误(429/5xx/超时) */
function MM_retryable_(msg) {
  const e = new Error(msg);
  e.mmRetryable = true;
  return e;
}

/** 构造致命错误(4xx 业务错误、音频超限等),直接 FAILED */
function MM_fatal_(msg) {
  const e = new Error(msg);
  e.mmRetryable = false;
  return e;
}

/**
 * 判定异常是否可重试。
 * 显式标记优先;未标记的按消息内容猜(网络超时/DNS 抖动等一律视为可重试)。
 */
function MM_isRetryable_(err) {
  if (err && typeof err.mmRetryable === 'boolean') return err.mmRetryable;
  const m = String((err && err.message) || err || '').toLowerCase();
  return /timeout|timed out|deadline|address unavailable|dns|socket|temporarily|rate limit|429|50[0234]/.test(m);
}

/** HTTP 状态码 → 是否可重试 */
function MM_codeRetryable_(code) {
  return code === 429 || code === 408 || (code >= 500 && code <= 599);
}

/** 按 HTTP 响应抛出分类正确的异常 */
function MM_throwHttp_(tag, code, body) {
  const msg = tag + ' HTTP ' + code + ' :: ' + String(body || '').slice(0, 400);
  throw MM_codeRetryable_(code) ? MM_retryable_(msg) : MM_fatal_(msg);
}

// ============================================================
// HTTP 封装(C8:一律 muteHttpExceptions + 显式检查状态码)
// ============================================================

/**
 * 带 Google OAuth 令牌的请求(Meet / Calendar / Drive REST)。
 * 返回 {code, text, headers};不抛异常,由调用方决定降级还是抛。
 */
function MM_fetchGoogle_(url, options) {
  const opt = options || {};
  opt.muteHttpExceptions = true;
  opt.headers = opt.headers || {};
  opt.headers.Authorization = 'Bearer ' + ScriptApp.getOAuthToken();
  return MM_fetchRaw_(url, opt);
}

/** 带 Gemini Key 头的请求(C3) */
function MM_fetchGemini_(url, options) {
  const opt = options || {};
  opt.muteHttpExceptions = true;
  opt.headers = opt.headers || {};
  opt.headers['x-goog-api-key'] = MM_geminiKey_();
  return MM_fetchRaw_(url, opt);
}

/** 底层 fetch:把网络层异常统一转成可重试错误 */
function MM_fetchRaw_(url, opt) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, opt);
  } catch (e) {
    throw MM_retryable_('网络异常: ' + e.message);
  }
  const headers = {};
  const raw = resp.getAllHeaders();
  Object.keys(raw).forEach(k => { headers[k.toLowerCase()] = raw[k]; }); // 大小写不稳定,统一小写
  return {
    code: resp.getResponseCode(),
    text: () => resp.getContentText(),
    json: () => JSON.parse(resp.getContentText()),
    blob: () => resp.getBlob(),
    headers: headers
  };
}

// ============================================================
// token 估算(IMPLEMENTATION_PROMPT · 输入预处理)
// ============================================================

/** 文本 token 估算:CJK 1 字 1 token,其余 4 字符 1 token */
function MM_estimateTokens_(s) {
  const str = String(s || '');
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    // 中日韩统一表意文字 + 扩展A + 兼容表意 + CJK 标点 + 假名 + 谚文
    if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x3400 && c <= 0x4DBF) ||
        (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x3000 && c <= 0x303F)) cjk++;
  }
  const rest = str.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

/** 音频 token 估算:约 32 token/秒(§3.3) */
function MM_estimateAudioTokens_(seconds) {
  return Math.ceil(Number(seconds || 0) * MM_CFG.AUDIO_TOKENS_PER_SEC);
}

/**
 * 由文件体积反推音频秒数。
 * ⚠️ 不确定性:Drive 不返回音频时长(videoMediaMetadata 仅对视频有效),
 * 因此只能按假定码率(MM_CFG.AUDIO_ASSUMED_KBPS)估算,偏保守。
 */
function MM_estimateAudioSeconds_(bytes) {
  const kbps = MM_num_('MM_AUDIO_ASSUMED_KBPS', MM_CFG.AUDIO_ASSUMED_KBPS);
  return Math.ceil((Number(bytes || 0) * 8) / (kbps * 1000));
}

/** 动态 maxOutputTokens:短会议不浪费,长会议不截断 */
function MM_dynamicMaxOut_(inputTokens) {
  const n = Number(inputTokens || 0);
  if (n < 10000) return 8192;
  if (n < 80000) return 16384;
  return 32768;   // 2 小时会议的双语输出留足余量;超出模型上限时 API 会自行钳制
}

// ============================================================
// 杂项工具
// ============================================================

/** 转录预处理:合并同说话人连续发言 / 去时间戳 / 去填充词 / 折叠空白 */
function MM_compactTranscript_(entries) {
  const FILLER = /\b(um+|uh+|erm+|hmm+|you know|i mean|sort of|kind of|like,)\b/gi;
  const FILLER_ZH = /(就是说|然后就是|那个那个|这个这个|嗯嗯+|呃+|啊那个)/g;
  const out = [];
  let last = null;
  (entries || []).forEach(e => {
    const who = String((e && e.speaker) || '').trim();
    let txt = String((e && e.text) || '')
      .replace(/\[\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\]/g, '')   // [00:12:34] 形式时间戳
      .replace(/^\d{1,2}:\d{2}(:\d{2})?\s*/, '')             // 行首 12:34 形式
      .replace(FILLER, ' ')
      .replace(FILLER_ZH, '')
      .replace(/([,，])(\s*[,，])+/g, '$1')                    // 填充词删掉后残留的连续逗号
      .replace(/^[\s,，、.。!?！？]+/, '')                      // 以及行首孤立标点
      .replace(/\s+/g, ' ')
      .trim();
    if (!txt) return;
    if (last && last.speaker === who) {
      last.text += ' ' + txt;              // 合并同说话人连续发言,省掉重复前缀
    } else {
      last = { speaker: who, text: txt };
      out.push(last);
    }
  });
  return out.map(x => (x.speaker ? x.speaker + ': ' : '') + x.text).join('\n');
}

/** 纯文本清洗(Drive Doc 路径:无说话人结构,只做去时间戳+填充词+折叠空白) */
function MM_compactPlainText_(text) {
  return String(text || '')
    .replace(/^\s*\d{1,2}:\d{2}(:\d{2})?\s*/gm, '')
    .replace(/\b(um+|uh+|erm+|you know|i mean)\b/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function MM_fmtDate_(d, pattern) {
  return Utilities.formatDate(d instanceof Date ? d : new Date(d), MM_tz_(), pattern || 'yyyy-MM-dd');
}

function MM_iso_(d) {
  if (!d) return '';
  const dt = (d instanceof Date) ? d : new Date(d);
  return isNaN(dt.getTime()) ? '' : dt.toISOString();
}

function MM_parseDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** 从 Meet 链接提取会议码:https://meet.google.com/abc-defg-hij → abc-defg-hij */
function MM_meetCode_(hangoutLink) {
  const m = /meet\.google\.com\/([a-z0-9-]+)/i.exec(String(hangoutLink || ''));
  return m ? m[1] : '';
}

/** 文件名安全化(Drive 不允许部分字符,顺带截断避免超长标题) */
function MM_safeName_(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 日志缓冲:MM_remote.js 的远程调用把它设为数组,以便把执行期日志随响应带回;平时为 null 不产生开销
let MM_LOGBUF_ = null;
function MM_log_(msg) { console.log('[MM] ' + msg); if (MM_LOGBUF_) MM_LOGBUF_.push('I ' + msg); }
function MM_warn_(msg) { console.warn('[MM] ' + msg); if (MM_LOGBUF_) MM_LOGBUF_.push('W ' + msg); }
