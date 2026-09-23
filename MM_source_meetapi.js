/**
 * MM_source_meetapi.js — 数据源 1(SRC_MEET_API):Meet REST API 转录
 * 职责:按会议码定位 conferenceRecord → 找到已结束的 transcript → 拉全部 entries → 压缩成文本
 * 依赖:MM_config.js
 * 被谁调用:MM_main.js 的 NEW / TEXT_READY 状态处理
 *
 * ⚠️ 外部 API 不确定性(未经真机验证,以 MM_probe() 结果为准):
 *  1. conferenceRecords.list 的 filter 语法。文档示例为 space.meeting_code="abcdefghij"(无连字符),
 *     本文件先试无连字符,失败再试带连字符,再失败退到「按时间窗列举 + 逐个比对 space」。
 *  2. transcriptEntries 的说话人字段为 participant 资源名,需二次请求换 displayName;
 *     若该端点 403,则退化为 P1/P2 匿名标签(不阻断主流程)。
 *  3. 组织若禁用转录(V2 失败),这里恒定返回 null,由上层自然降级到 Drive Doc / 音频。
 */

/**
 * 探测转录是否就绪(廉价步骤,NEW 状态调用)。
 * @return {?{transcriptName:string, recordName:string, docId:string}} 未就绪返回 null
 */
function MM_meetProbe_(task) {
  const code = String(task.meet_code || '');
  if (!code) return null;

  const rec = MM_meetFindRecord_(code, task);
  if (!rec) return null;

  const list = MM_fetchGoogle_(MM_CFG.MEET_API + '/' + rec.name + '/transcripts?pageSize=10');
  if (list.code === 403 || list.code === 404) {
    MM_warn_('transcripts 列表 HTTP ' + list.code + ',降级到 Drive Doc');
    return null;                                   // §7:Meet API 403/404 → 降级
  }
  if (list.code !== 200) {
    if (MM_codeRetryable_(list.code)) throw MM_retryable_('transcripts HTTP ' + list.code);
    return null;
  }

  const ts = (list.json().transcripts || []).filter(t => String(t.state) === 'ENDED');
  if (!ts.length) return null;                     // 会议开了但没开转录,或转录仍在生成

  const t = ts[ts.length - 1];                     // 同一场会可能多段,取最后一段作为主转录
  return {
    transcriptName: t.name,
    recordName: rec.name,
    docId: (t.docsDestination && t.docsDestination.document) || ''
  };
}

/**
 * 定位与本任务时间窗匹配的 conferenceRecord。
 * 周期性会议共用同一会议码,必须按时间筛选,否则会取到上一期的转录。
 */
function MM_meetFindRecord_(code, task) {
  const bare = code.replace(/-/g, '');
  const end = MM_parseDate_(task.event_end) || new Date();
  const lo = new Date(end.getTime() - 8 * 3600000);   // 会议开始不会早于结束前 8 小时
  const hi = new Date(end.getTime() + 2 * 3600000);   // 允许会议超时 2 小时

  const candidates = MM_meetListRecords_(bare, code, lo, hi);
  if (!candidates.length) return null;

  // 取开始时间落在窗口内、且最接近事件结束时间的一条
  let best = null, bestDelta = Infinity;
  candidates.forEach(r => {
    const st = MM_parseDate_(r.startTime);
    if (!st || st < lo || st > hi) return;
    const d = Math.abs(st.getTime() - end.getTime());
    if (d < bestDelta) { bestDelta = d; best = r; }
  });
  return best;
}

/** 三级尝试拿 conferenceRecords 列表 */
function MM_meetListRecords_(bare, dashed, lo, hi) {
  const base = MM_CFG.MEET_API + '/conferenceRecords?pageSize=25';

  // 尝试 1/2:按会议码过滤(无连字符 → 带连字符)
  const filters = ['space.meeting_code="' + bare + '"', 'space.meeting_code="' + dashed + '"'];
  for (let i = 0; i < filters.length; i++) {
    const r = MM_fetchGoogle_(base + '&filter=' + encodeURIComponent(filters[i]));
    if (r.code === 200) {
      const arr = r.json().conferenceRecords || [];
      if (arr.length) return arr;
    } else if (r.code === 403 || r.code === 404) {
      return [];                                    // 无权限,直接降级,别再试
    } else if (MM_codeRetryable_(r.code)) {
      throw MM_retryable_('conferenceRecords HTTP ' + r.code);
    }
    // 400(filter 语法不被接受)→ 试下一种写法
  }

  // 尝试 3:按时间窗列举,再逐个查 space 比对会议码
  const tf = 'start_time>="' + lo.toISOString() + '" AND start_time<="' + hi.toISOString() + '"';
  const r = MM_fetchGoogle_(base + '&filter=' + encodeURIComponent(tf));
  if (r.code !== 200) return [];
  const recs = r.json().conferenceRecords || [];
  return recs.filter(rec => MM_meetSpaceCode_(rec.space) === bare);
}

/** space 资源名 → 会议码(带缓存,避免重复请求) */
const MM_SPACE_CACHE_ = {};
function MM_meetSpaceCode_(spaceName) {
  if (!spaceName) return '';
  if (MM_SPACE_CACHE_[spaceName] !== undefined) return MM_SPACE_CACHE_[spaceName];
  const r = MM_fetchGoogle_(MM_CFG.MEET_API + '/' + spaceName);
  const code = (r.code === 200 ? String(r.json().meetingCode || '') : '').replace(/-/g, '');
  MM_SPACE_CACHE_[spaceName] = code;
  return code;
}

/**
 * 拉取全部转录条目并压缩(TEXT_READY 状态调用)。
 * @return {string} 压缩后的「说话人: 内容」多行文本
 */
function MM_meetFetchTranscript_(transcriptName) {
  const entries = [];
  let pageToken = '';
  let guard = 0;
  do {
    const url = MM_CFG.MEET_API + '/' + transcriptName + '/entries?pageSize=1000' +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const r = MM_fetchGoogle_(url);
    if (r.code !== 200) MM_throwHttp_('transcriptEntries', r.code, r.text());
    const j = r.json();
    (j.transcriptEntries || []).forEach(e => {
      entries.push({ participant: e.participant, text: e.text || '' });
    });
    pageToken = j.nextPageToken || '';
    guard++;
    // 2 小时会议约 1~2 页;设 20 页硬上限防翻页死循环,同时受执行预算约束
  } while (pageToken && guard < 20 && !MM_outOfBudget_());

  if (!entries.length) throw MM_fatal_('转录存在但条目为空: ' + transcriptName);

  // 说话人解析:同一场会参会人有限,做一次缓存即可
  const nameCache = {};
  entries.forEach(e => {
    e.speaker = MM_meetSpeaker_(e.participant, nameCache);
    delete e.participant;
  });

  return MM_compactTranscript_(entries);
}

/** participant 资源名 → 显示名;失败退化为 P1/P2 稳定标签 */
function MM_meetSpeaker_(participantName, cache) {
  if (!participantName) return '';
  if (cache[participantName]) return cache[participantName];

  let name = '';
  try {
    const r = MM_fetchGoogle_(MM_CFG.MEET_API + '/' + participantName);
    if (r.code === 200) {
      const p = r.json();
      name = (p.signedinUser && p.signedinUser.displayName) ||
             (p.anonymousUser && p.anonymousUser.displayName) ||
             (p.phoneUser && p.phoneUser.displayName) || '';
    }
  } catch (e) {
    MM_warn_('participant 解析失败,退化为匿名标签: ' + e.message);
  }
  if (!name) name = 'P' + (Object.keys(cache).length + 1);
  cache[participantName] = name;
  return name;
}
