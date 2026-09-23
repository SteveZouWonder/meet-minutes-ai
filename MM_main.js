/**
 * MM_main.js — 触发器入口与状态机调度
 * 职责:MM_plannerDaily / MM_workerEvery15Min、LockService 并发控制、日历规划与核对、状态机推进、重试与告警
 * 依赖:MM_config.js、MM_store.js、MM_source_*.js、MM_ai.js、MM_render_*.js
 * 被谁调用:两个常驻触发器(由 MM_setupOnce() 安装),以及人工手动运行
 */

// 昂贵步骤(Gemini 调用 / Doc 生成 / 音频上传),每轮受 MAX_HEAVY_PER_RUN 配额限制(§4.6)
const MM_HEAVY_STATES = ['AUDIO_PENDING', 'SUMMARIZING', 'RENDER_DOC'];

// ============================================================
// 触发器入口 1:每日全量规划
// ============================================================
function MM_plannerDaily() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(MM_CFG.LOCK_WAIT_MS)) { MM_log_('planner 未拿到锁,静默退出'); return; }   // C12
  MM_budgetStart_();
  try {
    const now = new Date();
    const to = new Date(now.getTime() + MM_CFG.PLAN_AHEAD_HOURS * 3600000);
    const events = MM_calList_(now, to, false);
    const tasks = MM_tasksLoad_();

    let created = 0;
    events.forEach(ev => {
      if (!MM_eventEligible_(ev)) return;
      if (MM_taskByDedup_(tasks, ev.id)) return;
      const t = MM_taskAppend_(MM_taskFromEvent_(ev));
      tasks.push(t);
      created++;
    });
    MM_log_('planner: 扫描 ' + events.length + ' 个事件,新建 ' + created + ' 个任务');

    MM_purgeResults_();                                    // C15

    // §6.5 / Q3:每周一发未完成行动项汇总(planner 每日仅跑一次,天然不会重复发)
    if (now.getDay() === 1 && MM_conf_().weeklyDigest) {
      try { MM_weeklyDigest_(); } catch (e) { MM_warn_('周报发送失败: ' + e.message); }
    }
  } catch (e) {
    console.error('MM_plannerDaily 失败: ' + (e && e.stack || e));
    MM_alert_('planner 执行失败', String(e && e.stack || e));
    throw e;                                               // rethrow 让触发器失败通知生效
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 触发器入口 2:每 15 分钟推进
// ============================================================
function MM_workerEvery15Min() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(MM_CFG.LOCK_WAIT_MS)) { MM_log_('worker 未拿到锁,静默退出'); return; }   // C12
  MM_budgetStart_();
  try {
    const tasks = MM_tasksLoad_();

    // §4 规定的四步顺序,一步都不能换位。
    // ①② 依赖 Calendar,单独兜住:日历短暂不可用不应该拖死已经在跑的任务。
    try {
      const events = MM_workerCalendar_();    // 一次列举,供 ①② 共用
      MM_backfillPlan_(tasks, events);        // ① 增量规划(补临时会议)
      MM_reconcileCalendar_(tasks, events);   // ② 日历核对(取消 / 改期)
    } catch (e) {
      MM_warn_('日历规划/核对本轮失败,不影响已有任务推进: ' + e.message);
    }
    MM_scanAudio_(tasks);                     // ③ 音频文件夹扫描
    MM_advanceTasks_(tasks);                  // ④ 推进任务

    MM_log_('worker 完成,耗时 ' + MM_elapsedMs_() + ' ms');
  } catch (e) {
    console.error('MM_workerEvery15Min 失败: ' + (e && e.stack || e));
    MM_alert_('worker 执行失败', String(e && e.stack || e));
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 日历
// ============================================================

/** worker 的统一列举窗口:过去 2 小时(补漏)~ 未来 26 小时(核对改期) */
function MM_workerCalendar_() {
  const now = new Date();
  const from = new Date(now.getTime() - MM_CFG.BACKFILL_LOOKBACK_HOURS * 3600000);
  const to = new Date(now.getTime() + (MM_CFG.PLAN_AHEAD_HOURS + 2) * 3600000);
  return MM_calList_(from, to, true);
}

/**
 * 列举日历事件(单实例展开,周期性会议每个 instance 独立)。
 * @param {boolean} showDeleted 需要识别「已取消」时传 true
 */
function MM_calList_(timeMin, timeMax, showDeleted) {
  const url = MM_CFG.CAL_API + '/calendars/primary/events'
    + '?singleEvents=true&orderBy=startTime&maxResults=250'
    + '&showDeleted=' + (showDeleted ? 'true' : 'false')
    + '&timeMin=' + encodeURIComponent(timeMin.toISOString())
    + '&timeMax=' + encodeURIComponent(timeMax.toISOString())
    + '&fields=' + encodeURIComponent('items(id,status,summary,hangoutLink,conferenceData/entryPoints,organizer,attendees(email,responseStatus,self),start,end)');
  const r = MM_fetchGoogle_(url);
  if (r.code !== 200) MM_throwHttp_('Calendar list', r.code, r.text());
  return r.json().items || [];
}

/** 单事件查询;404 返回 null(用于确认是否真被删除) */
function MM_calGet_(eventId) {
  const r = MM_fetchGoogle_(MM_CFG.CAL_API + '/calendars/primary/events/' + encodeURIComponent(eventId));
  if (r.code === 404 || r.code === 410) return null;
  if (r.code !== 200) MM_throwHttp_('Calendar get', r.code, r.text());
  return r.json();
}

/** 是否需要处理:带 Meet 链接 + 有明确起止时间 + 未取消 + 落在 MM_EVENT_SCOPE 范围内 */
function MM_eventEligible_(ev) {
  if (!ev || ev.status === 'cancelled') return false;
  if (!MM_evLink_(ev)) return false;
  if (!(ev.start && ev.start.dateTime && ev.end && ev.end.dateTime)) return false; // 全天事件不是会议
  return MM_eventInScope_(ev);
}

/**
 * 会议范围判定(见 MM_CFG.EVENT_SCOPE)。
 * 我组织的永远处理;他人组织的看我的应答状态:已拒绝一律跳过,
 * accepted 模式要求我明确接受,all 模式只要未拒绝即可(含 tentative / needsAction)。
 */
function MM_eventInScope_(ev) {
  if (ev.organizer && ev.organizer.self === true) return true;
  const scope = MM_conf_().eventScope;
  if (scope === 'organizer') return false;

  const me = (ev.attendees || []).filter(a => a && a.self === true)[0];
  const rs = me ? String(me.responseStatus || '') : '';
  if (rs === 'declined') return false;
  if (scope === 'all') return true;
  return rs === 'accepted';
}

/** Meet 链接:优先 hangoutLink,回退 conferenceData 的 video 入口 */
function MM_evLink_(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  for (let i = 0; i < eps.length; i++) {
    if (eps[i].entryPointType === 'video' && /meet\.google\.com/.test(String(eps[i].uri || ''))) return eps[i].uri;
  }
  return '';
}

/** 日历事件 → 任务行 */
function MM_taskFromEvent_(ev) {
  const end = new Date(ev.end.dateTime);
  const emails = ((ev.attendees || []).map(a => a.email).filter(Boolean));
  return {
    source: 'MEET',
    dedup_key: ev.id,                                    // §4.3:去重键是 instance id,不是系列 id
    status: 'SCHEDULED',
    title: String(ev.summary || '未命名会议'),
    meeting_date: MM_iso_(new Date(ev.start.dateTime)),
    event_id: ev.id,
    event_end: MM_iso_(end),
    poll_deadline: MM_iso_(new Date(end.getTime() + MM_conf_().pollHours * 3600000)),
    attendees: JSON.stringify(emails),
    organizer: String((ev.organizer && ev.organizer.email) || '').toLowerCase(),
    meet_code: MM_meetCode_(MM_evLink_(ev)),
    src_kind: '',
    src_ref: ''
  };
}

// ---------- ① 增量规划:补录当天临时创建的会议(§4.2) ----------
function MM_backfillPlan_(tasks, events) {
  const now = Date.now();
  const lo = now - MM_CFG.BACKFILL_LOOKBACK_HOURS * 3600000;
  let n = 0;
  events.forEach(ev => {
    if (!MM_eventEligible_(ev)) return;
    const end = new Date(ev.end.dateTime).getTime();
    if (end < lo || end > now) return;                   // 只补「刚结束」的,未来的交给 planner
    if (MM_taskByDedup_(tasks, ev.id)) return;
    tasks.push(MM_taskAppend_(MM_taskFromEvent_(ev)));
    n++;
  });
  if (n) MM_log_('增量规划补建 ' + n + ' 个任务');
}

// ---------- ② 日历核对:取消 / 改期(§4.3) ----------
function MM_reconcileCalendar_(tasks, events) {
  const map = {};
  events.forEach(ev => { map[ev.id] = ev; });

  tasks.forEach(t => {
    if (t.status !== 'SCHEDULED' || !t.event_id) return;
    const ev = map[t.event_id];

    if (!ev) {
      // 不在窗口内不代表被删(可能被改到很远的日期),单独确认一次再下结论
      const one = MM_calGet_(t.event_id);
      if (!one || one.status === 'cancelled') {
        t.status = 'CANCELLED';                          // 终态,不告警
        MM_taskSave_(t);
        MM_log_('事件已取消 → CANCELLED: ' + t.title);
      } else if (one.end && one.end.dateTime) {
        MM_applyReschedule_(t, one);
      }
      return;
    }

    if (ev.status === 'cancelled') {
      t.status = 'CANCELLED';
      MM_taskSave_(t);
      MM_log_('事件已取消 → CANCELLED: ' + t.title);
      return;
    }
    MM_applyReschedule_(t, ev);
  });
}

/** 改期同步:更新结束时间与轮询窗口 */
function MM_applyReschedule_(t, ev) {
  if (!ev.end || !ev.end.dateTime) return;
  const newEnd = new Date(ev.end.dateTime);
  if (MM_iso_(newEnd) === String(t.event_end)) return;

  t.event_end = MM_iso_(newEnd);
  t.poll_deadline = MM_iso_(new Date(newEnd.getTime() + MM_conf_().pollHours * 3600000));
  if (ev.start && ev.start.dateTime) t.meeting_date = MM_iso_(new Date(ev.start.dateTime));
  if (ev.summary) t.title = String(ev.summary);
  MM_taskSave_(t);
  MM_log_('事件改期,已更新轮询窗口: ' + t.title);
}

// ---------- ③ 音频文件夹扫描(入口 B,§3.2) ----------
function MM_scanAudio_(tasks) {
  let files;
  try {
    files = MM_audioScan_(20);
  } catch (e) {
    MM_warn_('音频文件夹扫描失败: ' + e.message);
    return;
  }
  let n = 0;
  files.forEach(f => {
    if (MM_taskByDedup_(tasks, f.fileId)) return;        // 去重键 = Drive fileId
    const created = f.created || new Date();
    tasks.push(MM_taskAppend_({
      source: 'AUDIO',
      dedup_key: f.fileId,
      status: 'NEW',                                     // 无日历事件,直接进 NEW
      title: String(f.name).replace(/\.[^.]+$/, ''),     // 会议标题 = 文件名去扩展名
      meeting_date: MM_iso_(created),
      event_id: '',
      event_end: MM_iso_(created),
      poll_deadline: MM_iso_(new Date(Date.now() + 86400000)),
      attendees: '[]',
      meet_code: '',
      src_kind: 'AUDIO',
      src_ref: f.fileId,
      duration_sec: MM_estimateAudioSeconds_(f.bytes)
    }));
    n++;
  });
  if (n) MM_log_('音频扫描新建 ' + n + ' 个任务');
}

// ============================================================
// ④ 状态机推进
// ============================================================

function MM_advanceTasks_(tasks) {
  const cfg = MM_conf_();
  let heavyUsed = 0;
  let overLimitWarned = false;

  // 先推进靠后的状态(尽快让已经花过 Gemini 钱的任务收尾),同状态按创建时间先后
  const order = ['SEND_MAIL', 'SYNC_JIRA', 'WRITE_SHEET', 'RENDER_DOC', 'SUMMARIZING', 'TEXT_READY',
                 'AUDIO_PROCESSING', 'AUDIO_PENDING', 'NEW', 'SCHEDULED'];
  const active = tasks.filter(t => !MM_isTerminal_(t.status) && order.indexOf(String(t.status)) >= 0);
  active.sort((a, b) => {
    const d = order.indexOf(String(a.status)) - order.indexOf(String(b.status));
    return d !== 0 ? d : String(a.created_at).localeCompare(String(b.created_at));
  });

  for (let i = 0; i < active.length; i++) {
    if (MM_outOfBudget_()) { MM_log_('执行预算耗尽,剩余任务留到下一轮'); break; }   // C1

    const t = active[i];

    // 指数退避:未到重试时间的跳过
    const next = MM_parseDate_(t.next_attempt_at);
    if (next && next.getTime() > Date.now()) continue;

    const heavy = MM_HEAVY_STATES.indexOf(String(t.status)) >= 0;
    if (heavy) {
      if (heavyUsed >= cfg.maxHeavy) continue;                                     // §4.6 配额
      if (MM_usageOverLimit_()) {                                                  // §9 月度熔断
        if (!overLimitWarned) {
          overLimitWarned = true;
          // 熔断状态会持续到月底,每天最多提醒一封,否则一天要发 96 封
          MM_alertOncePerDay_('MONTHLY_CAP', '月度用量熔断',
            '当月累计处理时长已达上限 ' + cfg.maxMonthlyMinutes + ' 分钟,' +
            '已暂停所有 Gemini / Doc 生成,任务原地等待,下月 1 日自动恢复。\n' +
            '如需立即放宽,调整脚本属性 MM_MAX_MONTHLY_MINUTES。');
        }
        continue;
      }
    }

    try {
      const moved = MM_step_(t);
      if (moved) {
        t.retry_count = 0;
        t.next_attempt_at = '';
        t.last_error = '';
        MM_taskSave_(t);                       // C7:动作成功之后才落盘
      }
      if (heavy) heavyUsed++;
    } catch (e) {
      if (heavy) heavyUsed++;                  // 失败也算消耗,避免一轮内反复撞同一个昂贵错误
      MM_onTaskError_(t, e);
    }
  }
}

/**
 * 单步推进(每次触发每个任务只走一步,§5)。
 * @return {boolean} 是否发生了状态变化(false 表示原地等待,不需要落盘)
 */
function MM_step_(t) {
  switch (String(t.status)) {
    case 'SCHEDULED':        return MM_stepScheduled_(t);
    case 'NEW':              return MM_stepNew_(t);
    case 'AUDIO_PENDING':    return MM_stepAudioPending_(t);
    case 'AUDIO_PROCESSING': return MM_stepAudioProcessing_(t);
    case 'TEXT_READY':       return MM_stepTextReady_(t);
    case 'SUMMARIZING':      return MM_stepSummarizing_(t);
    case 'RENDER_DOC':       return MM_stepRenderDoc_(t);
    case 'WRITE_SHEET':      return MM_stepWriteSheet_(t);
    case 'SYNC_JIRA':        return MM_stepSyncJira_(t);
    case 'SEND_MAIL':        return MM_stepSendMail_(t);
    default:
      throw MM_fatal_('未知状态: ' + t.status);
  }
}

/** SCHEDULED:等到事件结束才进入 NEW(取消/改期已在核对步骤处理) */
function MM_stepScheduled_(t) {
  const end = MM_parseDate_(t.event_end);
  if (!end) throw MM_fatal_('任务缺少 event_end');
  if (end.getTime() > Date.now()) return false;
  t.status = 'NEW';
  return true;
}

/** NEW:判定数据源。优先级 Meet API → Drive Doc → 超窗 EXPIRED(§3.1) */
function MM_stepNew_(t) {
  if (String(t.source) === 'AUDIO') {
    t.src_kind = 'AUDIO';
    t.status = 'AUDIO_PENDING';
    return true;
  }

  // 1) Meet REST 转录
  let probe = null;
  try {
    probe = MM_meetProbe_(t);
  } catch (e) {
    if (!MM_isRetryable_(e)) MM_warn_('Meet API 探测失败,降级 Drive: ' + e.message);
    else throw e;
  }
  if (probe) {
    t.src_kind = 'MEET_API';
    t.src_ref = probe.transcriptName;
    t.status = 'TEXT_READY';
    MM_log_('命中 Meet 转录: ' + t.title);
    return true;
  }

  // 2) Drive Doc 兜底
  let doc = null;
  try {
    doc = MM_driveDocProbe_(t);
  } catch (e) {
    MM_warn_('Drive Doc 探测失败: ' + e.message);
  }
  if (doc) {
    t.src_kind = 'DRIVE_DOC';
    t.src_ref = doc.fileId;
    t.status = 'TEXT_READY';
    MM_log_('命中 Drive 转录文档: ' + doc.fileName);
    return true;
  }

  // 3) 超窗判定(§4.4)
  const dl = MM_parseDate_(t.poll_deadline);
  if (dl && dl.getTime() < Date.now()) {
    t.status = 'EXPIRED';
    MM_finalize_(t);
    MM_alertExpired_(t);
    return true;
  }
  return false;                        // 窗口内继续等,不落盘
}

/** AUDIO_PENDING(昂贵):上传音频到 Gemini File API */
function MM_stepAudioPending_(t) {
  const up = MM_geminiUpload_(String(t.src_ref));
  t.gemini_file = up.name;
  t.status = 'AUDIO_PROCESSING';
  return true;
}

/** AUDIO_PROCESSING:轮询到 ACTIVE 视同文本就绪 */
function MM_stepAudioProcessing_(t) {
  const st = MM_geminiFileState_(String(t.gemini_file));
  if (st.state !== 'ACTIVE') {
    MM_log_('音频仍在处理 state=' + st.state + ',下一轮再看');
    return false;
  }
  t.status = 'TEXT_READY';
  return true;
}

/** TEXT_READY:拉取并压缩转录(音频路径无需此步) */
function MM_stepTextReady_(t) {
  if (String(t.src_kind) === 'AUDIO') {
    t.status = 'SUMMARIZING';
    return true;
  }

  let text;
  if (String(t.src_kind) === 'MEET_API') {
    text = MM_meetFetchTranscript_(String(t.src_ref));
  } else if (String(t.src_kind) === 'DRIVE_DOC') {
    text = MM_driveDocText_(String(t.src_ref));
  } else {
    throw MM_fatal_('TEXT_READY 但 src_kind 非法: ' + t.src_kind);
  }
  if (!text || text.length < 100) throw MM_fatal_('压缩后转录过短(' + (text || '').length + ' 字符)');

  t.transcript_ref = MM_putBlob_(t.task_id + '-transcript.txt', text);
  t.status = 'SUMMARIZING';
  return true;
}

/** SUMMARIZING(昂贵):调 Gemini 出双语 JSON,成功后落 result_json(C7) */
function MM_stepSummarizing_(t) {
  if (MM_getResult_(t)) { t.status = 'RENDER_DOC'; return true; }   // 已有结果,不重复调用

  const meta = {
    title: String(t.title || ''),
    date: MM_fmtDate_(MM_parseDate_(t.meeting_date) || new Date(), 'yyyy-MM-dd'),
    attendees: MM_attendeeNames_(t)
  };

  let res;
  if (String(t.src_kind) === 'AUDIO') {
    const st = MM_geminiFileState_(String(t.gemini_file));
    if (st.state !== 'ACTIVE') throw MM_retryable_('音频文件状态回退为 ' + st.state);
    res = MM_summarizeAudio_(meta, st.uri, st.mime, Number(t.duration_sec || 0));
  } else {
    const text = MM_getBlob_(t.transcript_ref);
    if (!text) throw MM_fatal_('transcript_ref 内容丢失');
    res = MM_summarizeText_(meta, text);
  }

  if (res.warn) res.data._warn = res.warn;      // 降级说明随结果落盘,邮件里原样展示
  MM_putResult_(t, res.data);
  MM_usageAdd_(res.minutes, res.calls);
  t.status = 'RENDER_DOC';
  return true;
}

/** RENDER_DOC(昂贵):生成 Doc,按标题查重保证幂等(C13) */
function MM_stepRenderDoc_(t) {
  if (MM_conf_().deliver === 'email') { t.status = 'WRITE_SHEET'; return true; }

  const data = MM_getResult_(t);
  if (!data) throw MM_fatal_('RENDER_DOC 缺少 result_json');

  const urls = MM_renderDocs_(t, data);
  t.doc_url_zh = urls.zh || '';
  t.doc_url_en = urls.en || '';
  t.status = 'WRITE_SHEET';
  return true;
}

/** WRITE_SHEET:行动项按 action_id upsert(C13) */
function MM_stepWriteSheet_(t) {
  const data = MM_getResult_(t);
  if (!data) throw MM_fatal_('WRITE_SHEET 缺少 result_json');

  const docUrl = t.doc_url_zh || t.doc_url_en || '';
  const rows = (data.a || []).map((x, i) => ({
    action_id: t.task_id + '#' + (i + 1),
    meeting_id: t.task_id,
    meeting_title: String(t.title || ''),
    meeting_date: MM_fmtDate_(MM_parseDate_(t.meeting_date) || new Date(), 'yyyy-MM-dd'),
    task_zh: x.zh || '',
    task_en: x.en || '',
    owner: x.o || '',
    due: x.u || '',
    doc_url: docUrl
  }));
  MM_actionsUpsert_(rows);
  t.status = 'SYNC_JIRA';
  return true;
}

/**
 * SYNC_JIRA:标题含票号且已配置 JIRA_API_TOKEN 时,把纪要评论到对应 issue(C13:按 jira_sync 幂等)。
 * Jira 只是附带渠道,不能拖死主流程:可重试错误最多让出 maxRetry-1 次退避机会,
 * 之后(以及所有致命错误)记录到 jira_sync 后照常进入 SEND_MAIL。
 */
function MM_stepSyncJira_(t) {
  MM_shareTopUp_(t);                      // 项目组名单大时 RENDER_DOC 可能因预算只共享了一部分,这里补齐(幂等)
  if (!MM_conf_().jiraSync) { t.status = 'SEND_MAIL'; return true; }

  const data = MM_getResult_(t);
  if (!data) throw MM_fatal_('SYNC_JIRA 缺少 result_json');

  try {
    const rec = MM_jiraSyncMinutes_(t, data, { zh: t.doc_url_zh, en: t.doc_url_en });
    if (rec) t.jira_sync = rec;
  } catch (e) {
    const budgetLeft = Number(t.retry_count || 0) < MM_conf_().maxRetry - 1;
    if (MM_isRetryable_(e) && budgetLeft) throw e;
    const msg = String((e && e.message) || e).slice(0, 300);
    MM_warn_('Jira 同步放弃,不阻断邮件: ' + msg);
    t.jira_sync = 'ERR ' + MM_fmtDate_(new Date(), 'MM-dd HH:mm') + ' ' + msg;
  }
  t.status = 'SEND_MAIL';
  return true;
}

/** doc_share 形如 "project:PROJ:12/47 (jira)" 且未共享完 → 再跑一次 MM_shareDoc_(已有权限不重复创建) */
function MM_shareTopUp_(t) {
  const m = /^project:([A-Z0-9]+):(\d+)\/(\d+)/.exec(String(t.doc_share || ''));
  if (!m || Number(m[2]) >= Number(m[3])) return;
  const enId = MM_docIdFromUrl_(t.doc_url_en);
  if (!enId) return;
  MM_log_('项目共享未完成(' + m[2] + '/' + m[3] + '),补齐中');
  t.doc_share = MM_shareDoc_(enId, t);
}

/** SEND_MAIL:仅在未发送标记时发送(C13),发完进 DONE 并做终态清理 */
function MM_stepSendMail_(t) {
  if (String(t.mail_sent) !== 'Y') {
    const data = MM_getResult_(t);
    if (!data) throw MM_fatal_('SEND_MAIL 缺少 result_json');
    MM_sendMinutes_(t, data, { zh: t.doc_url_zh, en: t.doc_url_en }, data._warn || '');
    t.mail_sent = 'Y';
    MM_taskSave_(t);                    // 先把「已发」落盘,避免后续异常导致重发
  }
  t.status = 'DONE';
  MM_finalize_(t);
  return true;
}

/** 终态清理:删除 Gemini 上的音频(C15)+ 成功时归档 Drive 音频 */
function MM_finalize_(t) {
  if (t.gemini_file) {
    MM_geminiFileDelete_(String(t.gemini_file));
    t.gemini_file = '';
  }
  if (t.status === 'DONE' && String(t.source) === 'AUDIO' && t.src_ref) {
    MM_audioArchive_(String(t.src_ref));
  }
}

// ============================================================
// 重试与错误落盘(C14)
// ============================================================

function MM_onTaskError_(t, e) {
  const msg = String((e && e.message) || e);
  const retryable = MM_isRetryable_(e);
  t.last_error = MM_fmtDate_(new Date(), 'MM-dd HH:mm') + ' ' + msg.slice(0, 900);

  if (retryable && Number(t.retry_count || 0) < MM_conf_().maxRetry) {
    t.retry_count = Number(t.retry_count || 0) + 1;
    const waitRuns = Math.pow(2, t.retry_count - 1);       // 下 1 / 2 / 4 轮后重试
    t.next_attempt_at = MM_iso_(new Date(Date.now() + waitRuns * 15 * 60000));
    MM_warn_('可重试错误(第 ' + t.retry_count + ' 次): ' + msg.slice(0, 200));
  } else {
    t.status = 'FAILED';
    try { MM_finalize_(t); } catch (ignored) {}
    MM_warn_('任务失败 ' + t.task_id + ': ' + msg.slice(0, 300));
    MM_alert_('任务失败:' + t.title, [
      '任务:' + t.task_id,
      '状态:' + t.status,
      '来源:' + (t.src_kind || t.source),
      '重试次数:' + t.retry_count,
      '',
      msg
    ].join('\n'));
  }
  MM_taskSave_(t);
}

// ============================================================
// 杂项
// ============================================================

/** 参会人邮箱 → 名字部分,喂给模型帮助 owner 归属(不外发,仅进提示词) */
function MM_attendeeNames_(t) {
  let list = [];
  try { list = JSON.parse(t.attendees || '[]'); } catch (e) { list = []; }
  return (list || []).map(a => String(a).split('@')[0]).filter(Boolean).slice(0, 20);
}
