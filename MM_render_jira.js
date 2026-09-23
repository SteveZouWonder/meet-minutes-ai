/**
 * MM_render_jira.js — 纪要同步到 Jira
 * 职责:从会议标题提取票号(PROJ-1234 形式),把英文纪要卡片(标题 / 英文 Doc 链接 / 统计)
 *      以 ADF 评论写到对应 issue。评论纯英文;中文 Doc 是私人文件,不进评论。
 * 依赖:MM_config.js、MM_source_drivedoc.js(MM_resolveShortcut_)
 * 被谁调用:MM_main.js 的 SYNC_JIRA 状态
 *
 * 前提:脚本属性 JIRA_BASE_URL(必需,如 https://your-org.atlassian.net)、JIRA_API_TOKEN(必需)、
 *      JIRA_USER(可选,缺省用脚本所有者邮箱)。缺 URL 或 token 时 MM_conf_().jiraSync 为 false,整步静默跳过。
 * 幂等:任务表 jira_sync 列记录 "KEY:commentId",已写过的票不再重复评论。
 */

/** 标题里的票号(去重、保序) */
function MM_jiraKeys_(title) {
  const out = [];
  const re = new RegExp(MM_CFG.JIRA.KEY_RE.source, 'g');
  let m;
  while ((m = re.exec(String(title || ''))) !== null) {
    if (out.indexOf(m[1]) < 0) out.push(m[1]);
  }
  return out;
}

/**
 * 把纪要评论到标题中出现的每张票。
 * @param {boolean} [update] true = 已有评论则原地更新(PUT),用于重同步;默认已有则跳过(幂等)
 * @return {string} 同步记录,如 "PROJ-1234:123456;PROJ-1240:123457"
 */
function MM_jiraSyncMinutes_(task, data, urls, update) {
  const keys = MM_jiraKeys_(task.title);
  if (!keys.length) { MM_log_('标题无票号,跳过 Jira 同步'); return ''; }

  const done = MM_jiraParseSync_(task.jira_sync);
  const body = MM_jiraAdf_(task, data, urls);
  const results = [];

  keys.forEach(key => {
    if (done[key] && !update) { results.push(key + ':' + done[key]); return; }     // 幂等
    if (done[key]) {
      MM_jiraUpdateComment_(key, done[key], body);
      results.push(key + ':' + done[key]);
      MM_log_('Jira 评论已更新 ' + key + ' (comment ' + done[key] + ')');
      return;
    }
    const id = MM_jiraPostComment_(key, body);
    results.push(key + ':' + id);
    MM_log_('Jira 评论已写入 ' + key + ' (comment ' + id + ')');
  });
  return results.join(';');
}

/** PUT /rest/api/3/issue/{key}/comment/{id} */
function MM_jiraUpdateComment_(key, commentId, adfBody) {
  const r = MM_jiraFetch_('/rest/api/3/issue/' + encodeURIComponent(key) + '/comment/' + encodeURIComponent(commentId), 'put', { body: adfBody });
  if (r.code !== 200) MM_throwHttp_('Jira update comment ' + key + '/' + commentId, r.code, r.text());
}

/** Jira REST 请求(Basic 认证;C3:token 只从脚本属性读) */
function MM_jiraFetch_(path, method, json) {
  const cfg = MM_conf_();
  const user = MM_prop_(MM_CFG.JIRA.P_USER, MM_owner_());
  const token = MM_prop_(MM_CFG.JIRA.P_TOKEN, '');
  if (!token) throw MM_fatal_('脚本属性 ' + MM_CFG.JIRA.P_TOKEN + ' 未配置');
  if (!cfg.jiraBase) throw MM_fatal_('脚本属性 JIRA_BASE_URL 未配置(如 https://your-org.atlassian.net)');
  return MM_fetchRaw_(cfg.jiraBase + path, {
    method: method,
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(user + ':' + token), Accept: 'application/json' },
    payload: JSON.stringify(json)
  });
}

function MM_jiraParseSync_(s) {
  const map = {};
  String(s || '').split(';').forEach(p => {
    const i = p.indexOf(':');
    if (i > 0) map[p.slice(0, i)] = p.slice(i + 1);
  });
  return map;
}

/** POST /rest/api/3/issue/{key}/comment,返回 comment id */
function MM_jiraPostComment_(key, adfBody) {
  const r = MM_jiraFetch_('/rest/api/3/issue/' + encodeURIComponent(key) + '/comment', 'post', { body: adfBody });
  if (r.code !== 201) MM_throwHttp_('Jira comment ' + key, r.code, r.text());
  return String(r.json().id || '');
}

// ============================================================
// ADF 构建 —— 一律纯英文,不含任何中文字符(2026-09-04 定案)
//   links(默认):3 行短卡片 —— 标题/日期、英文 Doc + 源文档链接、统计
//   full:完整英文纪要(摘要 / 决策 / 行动项 / 链接)
// 中文 Doc 为私人文件,不放进评论。
// ============================================================

function MM_jiraAdf_(task, data, urls) {
  const body = MM_conf_().jiraStyle === 'full' ? MM_jiraAdfFull_(task, data, urls) : MM_jiraAdfLinks_(task, data, urls);
  // 硬约束自检:评论不得含中文。标题优先取模型生成的英文标题,这里只做最后一道告警
  if (/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(JSON.stringify(body))) {
    MM_warn_('Jira 评论中检测到 CJK 字符,请检查会议标题 / 模型英文输出');
  }
  return body;
}

/**
 * 可公开的链接:默认只有英文 Doc(或合并版)一个;中文 Doc 永不出现。
 * 源文档(Meet 转录 / Gemini 笔记)归会议组织者所有、仅参会人可见,非参会读者点开会撞权限墙,
 * 因此默认不放,需要溯源时用脚本属性 MM_JIRA_SOURCE_LINK=on 开启。
 */
function MM_jiraLinks_(task, urls) {
  const links = [];
  if (urls && urls.en) links.push([urls.zh === urls.en ? 'Bilingual Minutes (Google Doc)' : 'Meeting Minutes (Google Doc)', urls.en]);
  if (MM_prop_('MM_JIRA_SOURCE_LINK', 'off') === 'on') {
    const srcUrl = MM_jiraSourceUrl_(task);
    if (srcUrl) links.push(['Source: ' + MM_srcLabelEn_(task.src_kind), srcUrl]);
  }
  return links;
}

function MM_jiraHeadline_(task, data) {
  const dateStr = MM_fmtDate_(MM_parseDate_(task.meeting_date) || new Date(), 'yyyy-MM-dd');
  const title = String((data && data.t && data.t.en) || task.title || 'Meeting');
  return 'Meeting minutes — ' + dateStr + ' · ' + title;
}

function MM_jiraStats_(data) {
  const n = (arr) => (arr || []).length;
  const pl = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  return 'Auto-generated · ' + pl(n(data.d), 'decision') + ' · ' + pl(n(data.a), 'action item');
}

function MM_jiraAdfLinks_(task, data, urls) {
  const T = MM_adfText_, P = MM_adfPara_;
  const content = [P(T(MM_jiraHeadline_(task, data), ['strong']))];

  const links = MM_jiraLinks_(task, urls);
  if (links.length) {
    const nodes = [];
    links.forEach((l, i) => { if (i) nodes.push(T('  |  ')); nodes.push(MM_adfLink_(l[0], l[1])); });
    content.push(P.apply(null, nodes));
  }
  content.push(P(T(MM_jiraStats_(data), ['em'])));
  return { type: 'doc', version: 1, content: content };
}

function MM_jiraAdfFull_(task, data, urls) {
  const T = MM_adfText_, P = MM_adfPara_;
  const content = [];
  content.push(MM_adfHeading_(3, MM_jiraHeadline_(task, data)));
  content.push(P(T(MM_srcLabelEn_(task.src_kind) + '  ·  auto-generated by MM')));

  if (data.s && data.s.en) content.push(P(T('Summary: ', ['strong']), T(data.s.en)));

  if (data.d && data.d.length) {
    content.push(MM_adfHeading_(4, 'Decisions'));
    content.push(MM_adfBullets_(data.d.map(x => {
      const tag = (MM_CFG.DECISION_LABEL[x.k] || MM_CFG.DECISION_LABEL[1]);
      return [T('[' + tag.en + '] ', ['strong']), T(x.en || '')];
    })));
  }

  if (data.a && data.a.length) {
    content.push(MM_adfHeading_(4, 'Action Items'));
    content.push(MM_adfBullets_(data.a.map(x => {
      const meta = [x.o ? 'Owner: ' + x.o : '', x.u ? 'Due: ' + x.u : ''].filter(Boolean).join(', ');
      return [T(x.en || ''), T(meta ? '  (' + meta + ')' : '', ['em'])].filter(n => n.text);
    })));
  }

  const links = MM_jiraLinks_(task, urls);
  if (links.length) {
    content.push(MM_adfHeading_(4, 'Links'));
    content.push(MM_adfBullets_(links.map(l => [MM_adfLink_(l[0], l[1])])));
  }
  content.push(P(T('Content is AI-extracted and may contain omissions; refer to the source for authoritative details.', ['em'])));
  return { type: 'doc', version: 1, content: content };
}

/** 数据源英文标签(评论不得出现中文,不能复用 MM_srcLabel_) */
function MM_srcLabelEn_(kind) {
  return { MEET_API: 'Meet transcript', DRIVE_DOC: 'Meet notes / transcript (Google Doc)', AUDIO: 'Audio recording' }[String(kind)] || 'Meeting';
}

/** 源文档链接:DRIVE_DOC 解析快捷方式后给 Docs 链接;其余为空 */
function MM_jiraSourceUrl_(task) {
  if (String(task.src_kind) !== 'DRIVE_DOC' || !task.src_ref) return '';
  try {
    return MM_resolveShortcut_(DriveApp.getFileById(String(task.src_ref))).getUrl();
  } catch (e) {
    MM_warn_('源文档链接获取失败: ' + e.message);
    return '';
  }
}

// ---- ADF 节点工厂 ----
function MM_adfText_(text, marks) {
  const n = { type: 'text', text: String(text == null ? '' : text) };
  if (marks && marks.length) n.marks = marks.map(m => ({ type: m }));
  return n;
}
function MM_adfLink_(text, href) {
  return { type: 'text', text: String(text), marks: [{ type: 'link', attrs: { href: String(href) } }] };
}
function MM_adfPara_() {
  const nodes = Array.prototype.slice.call(arguments).filter(n => n && n.text !== '');
  return { type: 'paragraph', content: nodes.length ? nodes : [MM_adfText_(' ')] };
}
function MM_adfHeading_(level, text) {
  return { type: 'heading', attrs: { level: level }, content: [MM_adfText_(text)] };
}
/** items: Array<Array<inlineNode>> */
function MM_adfBullets_(items) {
  return {
    type: 'bulletList',
    content: items.map(nodes => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: nodes.length ? nodes : [MM_adfText_(' ')] }]
    }))
  };
}
