/**
 * MM_setup.js — 会议双语纪要系统 · 初始化与权限探针
 * 职责:MM_probe() 权限探针 / MM_setupOnce() 建表建目录装触发器 / MM_status() 状态看板 / 维护工具
 * 依赖:MM_config.js、MM_store.js、MM_source_audio.js、MM_render_mail.js
 * 被谁调用:人工在编辑器手动运行
 */

const MM_PROBE = {
  GEMINI_MODEL: 'gemini-3.6-flash',                              // 与 MM_CFG.MODEL 一致,若 404 会在报告中列出可用模型
  MEET_API: 'https://meet.googleapis.com/v2',
  GLA: 'https://generativelanguage.googleapis.com/v1beta',
  CAL_API: 'https://www.googleapis.com/calendar/v3',
  AUDIO_FOLDER: '会议录音',                                       // §11-Q2 定案
  MEET_FOLDERS: ['Google Meet', 'Meet Recordings']               // Meet 产物的两代文件夹名
};

/** 入口:运行一次,输出 V1~V4 验证报告 */
function MM_probe() {
  const R = [];                                                   // 报告行
  const add = (id, ok, msg) => R.push((ok === true ? '✅' : ok === false ? '❌' : '⚠️') + ' [' + id + '] ' + msg);
  const owner = Session.getEffectiveUser().getEmail();
  const token = ScriptApp.getOAuthToken();

  add('ENV', true, '账号: ' + owner + ' | 时区: ' + Session.getScriptTimeZone());

  // ---------- 0. 实际授权的 scopes(tokeninfo)----------
  try {
    const ti = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
    if (ti.getResponseCode() === 200) {
      const scopes = (JSON.parse(ti.getContentText()).scope || '').split(' ').map(s => s.replace('https://www.googleapis.com/auth/', ''));
      add('SCOPES', true, '已授权: ' + scopes.join(', '));
    } else {
      add('SCOPES', null, 'tokeninfo HTTP ' + ti.getResponseCode() + '(不影响后续检查)');
    }
  } catch (e) { add('SCOPES', null, 'tokeninfo 异常: ' + e.message); }

  // ---------- V1. Meet REST API ----------
  let firstRecordName = null;
  try {
    const r = UrlFetchApp.fetch(MM_PROBE.MEET_API + '/conferenceRecords?pageSize=5', {
      headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
    });
    const code = r.getResponseCode();
    if (code === 200) {
      const recs = JSON.parse(r.getContentText()).conferenceRecords || [];
      add('V1', true, 'Meet REST API 可用,历史会议记录 ' + recs.length + ' 条' + (recs.length === 0 ? '(账号从未开过带记录的会议,属正常)' : ''));
      if (recs.length > 0) firstRecordName = recs[0].name;
    } else {
      const body = r.getContentText().slice(0, 300);
      // 403 细分:scope 不足 / 管理员禁用 API / Workspace 版本不含
      add('V1', false, 'Meet REST API HTTP ' + code + ' :: ' + body);
    }
  } catch (e) { add('V1', false, 'Meet REST API 异常: ' + e.message); }

  // V1b. 若有历史会议,尝试取转录列表(验证 transcripts 端点权限)
  if (firstRecordName) {
    try {
      const r = UrlFetchApp.fetch(MM_PROBE.MEET_API + '/' + firstRecordName + '/transcripts', {
        headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
      });
      const code = r.getResponseCode();
      if (code === 200) {
        const ts = JSON.parse(r.getContentText()).transcripts || [];
        add('V1b', true, '最近一场会议的转录数: ' + ts.length + (ts.length === 0 ? '(该会议未开转录)' : ''));
      } else {
        add('V1b', false, 'transcripts 端点 HTTP ' + code);
      }
    } catch (e) { add('V1b', false, 'transcripts 异常: ' + e.message); }
  }

  // ---------- V2. Drive 中的 Meet 产物文件夹 ----------
  try {
    const found = [];
    MM_PROBE.MEET_FOLDERS.forEach(name => {
      const it = DriveApp.getFoldersByName(name);
      while (it.hasNext()) {
        const f = it.next();
        let n = 0; const files = f.getFiles();
        while (files.hasNext() && n < 50) { files.next(); n++; }
        found.push(name + '(文件数≥' + n + ')');
      }
    });
    if (found.length) {
      add('V2', true, 'Meet 产物文件夹存在: ' + found.join('; '));
    } else {
      add('V2', null, 'Drive 中无 Meet 产物文件夹。原因可能是:从未录制/转录过(可救),或管理员禁用了录制与转录(致命)。请按邮件末尾的【人工验证步骤】开一场测试会议确认');
    }
  } catch (e) { add('V2', false, 'Drive 检查异常: ' + e.message); }

  // ---------- 音频文件夹(入口 B)----------
  try {
    const it = DriveApp.getFoldersByName(MM_PROBE.AUDIO_FOLDER);
    add('AUDIO', true, it.hasNext() ? '音频文件夹「' + MM_PROBE.AUDIO_FOLDER + '」已存在' : '音频文件夹「' + MM_PROBE.AUDIO_FOLDER + '」不存在,MM_setupOnce() 时会自动创建');
  } catch (e) { add('AUDIO', false, '音频文件夹检查异常: ' + e.message); }

  // ---------- 日历:今日事件 + hangoutLink 检测(planner 依赖此字段)----------
  try {
    const now = new Date();
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const t1 = new Date(now); t1.setHours(23, 59, 59, 0);
    const url = MM_PROBE.CAL_API + '/calendars/primary/events?singleEvents=true'
      + '&timeMin=' + encodeURIComponent(t0.toISOString()) + '&timeMax=' + encodeURIComponent(t1.toISOString())
      + '&fields=' + encodeURIComponent('items(id,summary,hangoutLink,organizer)');
    const r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (r.getResponseCode() === 200) {
      const items = JSON.parse(r.getContentText()).items || [];
      const meet = items.filter(e => e.hangoutLink);
      const mine = meet.filter(e => e.organizer && (e.organizer.self === true || e.organizer.email === owner));
      add('CAL', true, '今日事件 ' + items.length + ' 个,含 Meet 链接 ' + meet.length + ' 个,其中我是组织者 ' + mine.length + ' 个(逐条合格判定见 MM_calDump)');
    } else {
      add('CAL', false, 'Calendar API HTTP ' + r.getResponseCode() + ' :: ' + r.getContentText().slice(0, 200));
    }
  } catch (e) { add('CAL', false, 'Calendar 异常: ' + e.message); }

  // ---------- V4. Gemini:Key / 模型 / 生成 / File API ----------
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    add('V4', false, '脚本属性缺少 GEMINI_API_KEY');
  } else {
    // V4a. 模型元数据(免费,不耗生成配额)
    try {
      const r = UrlFetchApp.fetch(MM_PROBE.GLA + '/models/' + MM_PROBE.GEMINI_MODEL, {
        headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
      });
      if (r.getResponseCode() === 200) {
        const m = JSON.parse(r.getContentText());
        add('V4a', true, '模型 ' + MM_PROBE.GEMINI_MODEL + ' 可用 | 输入上限 ' + m.inputTokenLimit + ' | 输出上限 ' + m.outputTokenLimit);
      } else if (r.getResponseCode() === 404) {
        // 模型名失效 → 列出当前可用的 flash 系模型供替换
        const lr = UrlFetchApp.fetch(MM_PROBE.GLA + '/models?pageSize=50', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
        const names = lr.getResponseCode() === 200
          ? (JSON.parse(lr.getContentText()).models || []).map(x => x.name.replace('models/', '')).filter(n => n.includes('flash')).join(', ')
          : '(列表获取失败)';
        add('V4a', false, '模型 ' + MM_PROBE.GEMINI_MODEL + ' 不存在。可用 flash 模型: ' + names);
      } else {
        add('V4a', false, '模型查询 HTTP ' + r.getResponseCode() + ' :: ' + r.getContentText().slice(0, 200));
      }
    } catch (e) { add('V4a', false, '模型查询异常: ' + e.message); }

    // V4b. 最小生成调用(验证生成配额与 Key 权限)
    try {
      const r = UrlFetchApp.fetch(MM_PROBE.GLA + '/models/' + MM_PROBE.GEMINI_MODEL + ':generateContent', {
        method: 'post', contentType: 'application/json',
        headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with OK only' }] }], generationConfig: { maxOutputTokens: 5 } })
      });
      add('V4b', r.getResponseCode() === 200, 'generateContent HTTP ' + r.getResponseCode() + (r.getResponseCode() !== 200 ? ' :: ' + r.getContentText().slice(0, 200) : ''));
    } catch (e) { add('V4b', false, 'generateContent 异常: ' + e.message); }

    // V4c. File API 可达性(音频路径依赖)
    try {
      const r = UrlFetchApp.fetch(MM_PROBE.GLA + '/files', { headers: { 'x-goog-api-key': key }, muteHttpExceptions: true });
      add('V4c', r.getResponseCode() === 200, 'File API(音频上传通道)HTTP ' + r.getResponseCode());
    } catch (e) { add('V4c', false, 'File API 异常: ' + e.message); }
  }

  // ---------- 汇总输出 ----------
  const report = R.join('\n');
  console.log('\n========== MM_probe 报告 ==========\n' + report + '\n===================================');

  const manual = [
    '',
    '========== 人工验证步骤(V2/V3,机器无法代验)==========',
    '1. 在 Google 日历创建一个 10 分钟后开始的测试会议(带 Meet),你自己加入。',
    '2. 会中点右下角「会议工具」,确认是否存在「转录 (Transcripts)」开关:',
    '   · 存在且可开启 → V2 通过,入口 A 成立',
    '   · 不存在或提示管理员禁用 → V2 失败,系统将以音频入口为主(需求文档要调整)',
    '3. 开启转录后,请照读下面这段中英混说测试话术(验证 V3 转录质量):',
    '',
    '   「大家好,今天我们 review 一下 Q3 的 roadmap。首先,APM 的 latency 指标',
    '   已经降到 200 毫秒以下,performance 达标了。第二,关于 billing system 的',
    '   refactor,张三 owns 这个 task,deadline 是 9 月 15 号。最后一个 decision:',
    '   我们 agree 把 mobile app 的发布推迟到 Q4,这个已经 aligned。」',
    '',
    '4. 结束会议,等 10~30 分钟,转录 Doc 会出现在 Drive 的 Google Meet 文件夹。',
    '5. 打开转录 Doc,检查:说话人是否标注、中英文是否都被正确识别、',
    '   「张三」「9月15号」这类关键信息是否完整。截图或粘贴给我评估。',
    '6. 重新运行 MM_probe(),V1b/V2 应变为 ✅。'
  ].join('\n');

  try {
    MailApp.sendEmail(owner, '[MM_probe] 会议纪要系统权限探针报告', report + '\n' + manual);
    console.log('报告已邮件发送至 ' + owner);
  } catch (e) {
    console.warn('报告邮件发送失败(不影响结论): ' + e.message);
  }
  console.log(manual);
  return report;
}

// ============================================================
// 一次性初始化:建表 → 建目录 → 装触发器
// 幂等:可重复运行,不会重复建表或重复装触发器
// ============================================================
function MM_setupOnce() {
  MM_budgetStart_();
  const owner = MM_owner_();
  const out = [];
  const say = m => { out.push(m); console.log(m); };

  say('账号: ' + owner + ' | 时区: ' + MM_tz_());

  // ---- 1. 后台表格 ----
  const props = PropertiesService.getScriptProperties();
  const es = MM_ensureSheet_();
  say((es.created ? '已创建后台表格: ' : '复用已有后台表格: ') + es.ss.getUrl());
  say('工作表就绪: ' + [MM_SHEET.TASKS, MM_SHEET.ACTIONS, MM_SHEET.USAGE].join(' / '));

  // ---- 2. Drive 目录 ----
  const root = MM_audioRoot_();
  MM_audioSub_(MM_CFG.AUDIO_DONE_SUB);
  MM_audioSub_(MM_CFG.AUDIO_MINUTES_SUB);
  say('音频目录就绪: ' + root.getName() + '/ (含 ' + MM_CFG.AUDIO_DONE_SUB + '/ 与 ' + MM_CFG.AUDIO_MINUTES_SUB + '/)');
  say('  Drive 链接: ' + root.getUrl());

  // ---- 3. 密钥检查 ----
  if (!props.getProperty(MM_CFG.P_GEMINI_KEY)) {
    say('⚠️ 脚本属性 ' + MM_CFG.P_GEMINI_KEY + ' 未配置,AI 全链路不可用。请到「项目设置 → 脚本属性」添加');
  } else {
    say('GEMINI_API_KEY 已配置');
  }

  // ---- 4. 触发器(C2:总数恒为 2)----
  say(MM_installTriggers_());

  // ---- 5. 生效配置一览 ----
  const c = MM_conf_();
  say('生效配置: model=' + c.model + ' lang=' + c.lang + ' fileMode=' + c.fileMode +
      ' deliver=' + c.deliver + ' aiCall=' + c.aiCall + ' mailPolicy=' + c.mailPolicy +
      ' maxHeavy=' + c.maxHeavy + ' monthlyCap=' + c.maxMonthlyMinutes + 'min pollWindow=' + c.pollHours + 'h');
  say('提示: 以上任一项都可用同名脚本属性覆盖(MM_LANG / MM_MAIL_POLICY / MM_MAX_HEAVY_PER_RUN ...)');

  const report = out.join('\n');
  try { MailApp.sendEmail(owner, '[会议纪要系统] 初始化完成', report); } catch (e) { /* 邮件失败不影响初始化 */ }
  return report;
}

/**
 * 确保后台表格与三张工作表存在(幂等)。MM_setupOnce() 与 MM_adhocDriveDoc() 共用,
 * 后者不装触发器也能落任务。
 * @return {{ss: Spreadsheet, created: boolean}}
 */
function MM_ensureSheet_() {
  const props = PropertiesService.getScriptProperties();
  let sheetId = props.getProperty(MM_CFG.P_SHEET_ID);
  let ss = null;
  if (sheetId) {
    try { ss = SpreadsheetApp.openById(sheetId); } catch (e) { sheetId = null; }  // id 失效则重建
  }
  let created = false;
  if (!ss) {
    ss = SpreadsheetApp.create('会议双语纪要系统 — 后台数据表');
    props.setProperty(MM_CFG.P_SHEET_ID, ss.getId());
    MM_resetCache_();                                  // 属性刚变,清掉快照
    created = true;
  }

  // 建三张工作表并删掉默认的 Sheet1
  MM_tasksSheet_(); MM_actionsSheet_(); MM_usageSheet_();
  ['Sheet1', '工作表1'].forEach(n => {
    const sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  return { ss: ss, created: created };
}

/** 安装两个常驻触发器(先清后装,保证不重复、总数 ≤ 2) */
function MM_installTriggers_() {
  const removed = MM_removeTriggers_();
  ScriptApp.newTrigger('MM_plannerDaily').timeBased().atHour(0).nearMinute(30).everyDays(1).create();
  ScriptApp.newTrigger('MM_workerEvery15Min').timeBased().everyMinutes(15).create();
  return '触发器已安装: MM_plannerDaily(每日 00:30) + MM_workerEvery15Min(每 15 分钟)' +
         (removed ? ',清理旧触发器 ' + removed + ' 个' : '');
}

/** 卸载本系统的触发器(不动 news.js / schedule.js 的) */
function MM_removeTriggers_() {
  const mine = ['MM_plannerDaily', 'MM_workerEvery15Min'];
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (mine.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function MM_uninstall() {
  const n = MM_removeTriggers_();
  console.log('已卸载 ' + n + ' 个触发器。数据表与 Drive 目录保留,如需清理请手动删除');
  return n;
}

// ============================================================
// 状态看板 / 维护工具(人工排查用)
// ============================================================

/** 打印任务表概况与最近的失败原因 */
function MM_status() {
  MM_budgetStart_();
  const tasks = MM_tasksLoad_();
  const byStatus = {};
  tasks.forEach(t => { byStatus[t.status] = (byStatus[t.status] || 0) + 1; });

  const u = MM_usageRow_();
  const c = MM_conf_();
  const lines = [
    '任务总数: ' + tasks.length,
    '状态分布: ' + (Object.keys(byStatus).map(k => k + '=' + byStatus[k]).join('  ') || '(空)'),
    '本月用量: ' + u.minutes + ' / ' + c.maxMonthlyMinutes + ' 分钟,Gemini 调用 ' + u.calls + ' 次',
    '触发器: ' + ScriptApp.getProjectTriggers().filter(t =>
      t.getHandlerFunction().indexOf('MM_') === 0).map(t => t.getHandlerFunction()).join(', '),
    '生效配置: scope=' + c.eventScope + ' lang=' + c.lang + ' fileMode=' + c.fileMode +
      ' docShare=' + c.docShare + (c.docShare === 'domain' ? '[' + (c.shareDomains.join(',') || '空!') + ']' : '') +
      ' zhFolder=' + c.zhFolder + ' enFolder=' + (c.enFolder || '(同 zhFolder)') +
      ' jira=' + (c.jiraSync ? c.jiraStyle + '@' + c.jiraBase : 'off'),
    '收件人: mailPolicy=' + c.mailPolicy + ' toOrganizer=' + (c.mailToOrganizer ? 'on' : 'off') +
      ' subscribers=' + c.subscribers.length + (c.subscribers.length ? ' [' + c.subscribers.join(',') + ']' : ''),
    '项目共享: ' + (Object.keys(c.projectShare || {}).map(k => k + '(' + ((c.projectShare[k].keywords || []).join(' | ') || '票号') + ')').join(', ') || '(无)') +
      ' 成员域=' + (c.memberDomains.join(',') || '(不限)')
  ];

  const bad = tasks.filter(t => t.last_error).slice(-5);
  if (bad.length) {
    lines.push('', '最近的错误:');
    bad.forEach(t => lines.push('  [' + t.status + '] ' + t.title + ' :: ' + String(t.last_error).slice(0, 160)));
  }

  const report = lines.join('\n');
  console.log('\n===== 会议纪要系统状态 =====\n' + report + '\n============================');
  return report;
}

/**
 * 只读诊断:列出未来 hoursAhead 小时内的日历事件,并逐条给出 planner 的合格判定与原因。
 * 用于回答「为什么这场会没被排进任务表」。
 */
function MM_calDump(hoursAhead) {
  MM_budgetStart_();
  const h = Number(hoursAhead) > 0 ? Number(hoursAhead) : MM_CFG.PLAN_AHEAD_HOURS;
  const now = new Date();
  const events = MM_calList_(new Date(now.getTime() - 2 * 3600000), new Date(now.getTime() + h * 3600000), true);
  const tasks = MM_tasksLoad_();
  const scope = MM_conf_().eventScope;
  return events.map(ev => {
    const me = (ev.attendees || []).filter(a => a && a.self === true)[0];
    const reasons = [];
    if (ev.status === 'cancelled') reasons.push('已取消');
    if (!MM_evLink_(ev)) reasons.push('无 Meet 链接');
    if (!(ev.start && ev.start.dateTime && ev.end && ev.end.dateTime)) reasons.push('全天事件');
    if (!MM_eventInScope_(ev)) reasons.push('不在范围(scope=' + scope + ', 我的应答=' + (me ? me.responseStatus : '不在与会人列表') + ')');
    const dup = MM_taskByDedup_(tasks, ev.id);
    return {
      id: ev.id,
      title: ev.summary || '',
      start: ev.start && (ev.start.dateTime || ev.start.date),
      end: ev.end && (ev.end.dateTime || ev.end.date),
      status: ev.status,
      organizer: ev.organizer && ev.organizer.email,
      organizer_self: !!(ev.organizer && ev.organizer.self),
      my_response: me ? me.responseStatus : null,
      meet_code: MM_meetCode_(MM_evLink_(ev)),
      eligible: MM_eventEligible_(ev),
      project: MM_projectForTask_({ title: ev.summary || '' }) || '(none → ' + MM_conf_().docShare + ')',
      reasons: reasons,
      existing_task: dup ? (dup.task_id + ' [' + dup.status + ']') : null
    };
  });
}

/**
 * 诊断:某项目的共享名单(来源 fixed / jira / cache),force=true 强制重查 Jira 并刷新缓存。
 * 也可传会议标题做判定预演:MM_membersDump('PROJ-1234 Weekly Sync') → 先判项目再列名单。
 */
function MM_membersDump(keyOrTitle, force) {
  MM_budgetStart_();
  const rules = MM_conf_().projectShare || {};
  let key = String(keyOrTitle || '').trim();
  let matched = null;
  if (!rules[key]) {                       // 不是项目 key → 当标题做判定
    matched = MM_projectForTask_({ title: key });
    key = matched;
  }
  if (!key) return { project: '', note: '未命中任何项目规则,英文版将按 MM_DOC_SHARE=' + MM_conf_().docShare, rules: Object.keys(rules) };
  const m = MM_projectMembers_(key, !!force);
  return { project: key, matched_from_title: matched !== null, source: m.source, count: m.emails.length, emails: m.emails };
}

/** 只读诊断:导出任务表关键列(不含正文/大字段),用于远程排查 */
function MM_taskDump(limit) {
  MM_budgetStart_();
  const n = Number(limit) > 0 ? Number(limit) : 20;
  const keep = ['task_id', 'source', 'status', 'title', 'meeting_date', 'event_end', 'poll_deadline',
    'meet_code', 'src_kind', 'src_ref', 'retry_count', 'last_error', 'doc_url_en', 'doc_share', 'mail_sent', 'jira_sync', 'created_at', 'updated_at'];
  return MM_tasksLoad_().slice(-n).map(t => {
    const o = {};
    keep.forEach(k => { if (t[k] !== '' && t[k] !== undefined && t[k] !== null) o[k] = String(t[k]).slice(0, 200); });
    return o;
  });
}

/** 把某个 FAILED / EXPIRED 任务重置回 NEW 重跑(在编辑器里改 taskId 后运行) */
function MM_retryTask() {
  MM_budgetStart_();
  const taskId = '';                       // ← 填任务表里的 task_id
  if (!taskId) { console.log('请先在 MM_retryTask() 里填入 taskId'); return; }

  const tasks = MM_tasksLoad_();
  const t = tasks.filter(x => String(x.task_id) === taskId)[0];
  if (!t) { console.log('未找到任务 ' + taskId); return; }

  t.status = 'NEW';                        // 音频与会议任务都从 NEW 重新判定数据源
  t.retry_count = 0;
  t.next_attempt_at = '';
  t.last_error = '';
  t.mail_sent = '';
  MM_delBlob_(t.result_json);
  t.result_json = '';
  t.poll_deadline = MM_iso_(new Date(Date.now() + MM_conf_().pollHours * 3600000));
  MM_taskSave_(t);
  console.log('已重置 ' + taskId + ' → NEW,下一轮 worker 会重新处理');
}

// ============================================================
// 手工入口:把一份已有的 Drive 转录/纪要 Doc 直接送进状态机并同步跑完
// 适用场景:别人组织的会议(planner 因 Q5 不会建任务)、历史会议(超出 2 小时回看窗口)、
//          Gemini「Notes by Gemini」文档等。在编辑器里改 MM_ADHOC 后运行。
// ============================================================
const MM_ADHOC = {
  FILE_ID: '',            // 必填:Drive 文件 id(浏览器地址栏 /d/ 后面那串);快捷方式 id 亦可
  TITLE: '',              // 会议标题(用于 Doc 文件名与提示词),留空则用源文件名
  MEETING_DATE: '',       // 会议开始时间(ISO,如 '2026-09-03T20:45:00+08:00'),留空则用当前时间
  ATTENDEES: []           // 可选:参会人邮箱数组,帮助模型归属行动项负责人
};

function MM_adhocDriveDoc() {
  MM_budgetStart_();
  const a = MM_ADHOC;
  if (!a.FILE_ID) { console.log('请先在 MM_ADHOC 里填入 FILE_ID'); return; }

  MM_ensureSheet_();                                 // 未 MM_setupOnce() 也能跑,不装触发器
  MM_geminiKey_();                                   // 提前校验 Key,缺失时在建任务前就报错

  // 先验证文件可读(快捷方式在此解析,给出清晰报错而不是等到 TEXT_READY)
  const src = MM_resolveShortcut_(DriveApp.getFileById(a.FILE_ID));
  MM_log_('源文档: ' + src.getName() + ' (' + src.getMimeType() + ')');

  const tasks = MM_tasksLoad_();
  const dedup = 'adhoc:' + a.FILE_ID;
  let t = MM_taskByDedup_(tasks, dedup);
  if (t && String(t.status) === 'DONE') {
    console.log('该文档已处理完成: ' + t.task_id +
      (t.doc_url_zh ? '\n  zh: ' + t.doc_url_zh : '') + (t.doc_url_en ? '\n  en: ' + t.doc_url_en : '') +
      (t.jira_sync ? '\n  jira: ' + t.jira_sync : '') +
      '\n如需重新生成,请用 MM_retryTask() 重置。');
    return t;
  }
  if (t && MM_isTerminal_(t.status)) {
    // FAILED / EXPIRED / CANCELLED:手工入口视为「再试一次」,从读正文重新开始。
    // 已有的 result_json / doc 链接保留,后续步骤会自然复用(C13 幂等),不会重复调 Gemini。
    MM_log_('任务 ' + t.task_id + ' 处于 ' + t.status + '(' + String(t.last_error || '').slice(0, 120) + '),重置为 TEXT_READY 重跑');
    t.status = t.result_json ? 'RENDER_DOC' : 'TEXT_READY';
    t.retry_count = 0;
    t.next_attempt_at = '';
    t.last_error = '';
    MM_taskSave_(t);
  }
  if (!t) {
    const start = MM_parseDate_(a.MEETING_DATE) || new Date();
    t = MM_taskAppend_({
      source: 'MEET',
      dedup_key: dedup,
      status: 'TEXT_READY',                          // 数据源已知,跳过 SCHEDULED / NEW 的探测
      title: String(a.TITLE || src.getName()),
      meeting_date: MM_iso_(start),
      event_id: '',
      event_end: MM_iso_(start),
      poll_deadline: MM_iso_(new Date(Date.now() + 86400000)),
      attendees: JSON.stringify(a.ATTENDEES || []),
      meet_code: '',
      src_kind: 'DRIVE_DOC',
      src_ref: a.FILE_ID
    });
    MM_log_('已建任务 ' + t.task_id);
  } else {
    MM_log_('续跑未完成任务 ' + t.task_id + ' [' + t.status + ']');
  }

  return MM_runTaskNow_(t);
}

/**
 * 同步推进单个任务直到终态。手工运行有 6 分钟额度,每步前重置预算计时,
 * 使每一步都享有完整的 EXEC_BUDGET_MS。不走 worker 的 heavy 配额与月度熔断(人工触发,自行负责)。
 */
function MM_runTaskNow_(t) {
  for (let i = 0; i < 10 && !MM_isTerminal_(t.status); i++) {
    MM_budgetStart_();
    const before = t.status;
    try {
      const moved = MM_step_(t);
      if (moved) {
        t.retry_count = 0; t.next_attempt_at = ''; t.last_error = '';
        MM_taskSave_(t);
      }
      MM_log_(before + ' → ' + t.status + ' (' + MM_elapsedMs_() + ' ms)');
      if (!moved) { MM_log_('状态原地等待,停止同步推进'); break; }
    } catch (e) {
      MM_onTaskError_(t, e);
      console.error('步骤 ' + before + ' 失败: ' + (e && e.stack || e));
      break;
    }
  }
  const summary = ['任务 ' + t.task_id + ' 最终状态: ' + t.status,
    t.doc_url_zh ? '中文纪要: ' + t.doc_url_zh : '',
    t.doc_url_en ? 'English Minutes: ' + t.doc_url_en : '',
    t.last_error ? '错误: ' + t.last_error : ''].filter(Boolean).join('\n');
  console.log(summary);
  return t;
}

/**
 * 重同步已完成任务的「对外产物」:按当前策略重新整理 Doc 位置与共享、原地重写 Jira 评论。
 * 用途:共享策略 / 评论样式变更后,对历史任务补做;不重新调 Gemini,不重发邮件。
 * @param {string} [taskId] 缺省取最近一个 DONE 任务
 */
function MM_resyncTask(taskId) {
  MM_budgetStart_();
  const tasks = MM_tasksLoad_();
  let t = taskId
    ? tasks.filter(x => String(x.task_id) === String(taskId))[0]
    : tasks.filter(x => String(x.status) === 'DONE').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!t) throw MM_fatal_('未找到任务 ' + (taskId || '(最近 DONE)'));
  const data = MM_getResult_(t);
  if (!data) throw MM_fatal_('任务 ' + t.task_id + ' 无 result_json,无法重同步');
  MM_log_('重同步 ' + t.task_id + ' [' + t.status + '] ' + t.title);

  // 1) 中文 Doc → 私人文件夹(若尚未在那里)
  const zhId = MM_docIdFromUrl_(t.doc_url_zh);
  if (zhId && t.doc_url_zh !== t.doc_url_en) {
    const f = DriveApp.getFileById(zhId);
    const target = MM_zhFolder_();
    const parents = f.getParents();
    const already = parents.hasNext() && parents.next().getId() === target.getId();
    if (!already) { f.moveTo(target); MM_log_('中文 Doc 已移入私人文件夹: ' + target.getName()); }
  }

  // 2) 英文 Doc 共享
  const enId = MM_docIdFromUrl_(t.doc_url_en);
  if (enId) { t.doc_share = MM_shareDoc_(enId, t); MM_log_('英文 Doc 共享: ' + t.doc_share); }

  // 3) Jira 评论原地更新(有则 PUT,无则 POST)
  if (MM_conf_().jiraSync) {
    t.jira_sync = MM_jiraSyncMinutes_(t, data, { zh: t.doc_url_zh, en: t.doc_url_en }, true) || t.jira_sync;
  }
  MM_taskSave_(t);
  return { task_id: t.task_id, doc_share: t.doc_share, jira_sync: t.jira_sync, doc_url_en: t.doc_url_en, doc_url_zh: t.doc_url_zh };
}

/**
 * 授权诊断:打印当前令牌实际持有的 scope,并与 manifest 要求逐项比对。
 * 出现 "You do not have permission to call XxxApp" 时先运行这个。
 */
function MM_authCheck() {
  const need = {
    'documents': 'DocumentApp(生成纪要 Doc)',
    'drive': 'DriveApp(读转录 / 移动文件)',
    'spreadsheets': 'SpreadsheetApp(后台表)',
    'calendar.readonly': 'Calendar REST(规划会议;持有完整 calendar 亦可)',
    'script.external_request': 'UrlFetchApp(Gemini / Meet / Jira)',
    'script.send_mail': 'MailApp(纪要邮件)',
    'script.scriptapp': 'ScriptApp(触发器)'
  };
  const token = ScriptApp.getOAuthToken();
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { console.log('tokeninfo HTTP ' + r.getResponseCode() + ': ' + r.getContentText()); return; }
  const have = (JSON.parse(r.getContentText()).scope || '').split(' ').map(s => s.replace('https://www.googleapis.com/auth/', ''));
  const lines = ['账号: ' + Session.getEffectiveUser().getEmail(), '令牌持有 scope: ' + have.join(', '), ''];
  let missing = 0;
  Object.keys(need).forEach(k => {
    const ok = have.indexOf(k) >= 0 || (k === 'calendar.readonly' && have.indexOf('calendar') >= 0);
    if (!ok) missing++;
    lines.push((ok ? '✅ ' : '❌ ') + k + '  —  ' + need[k]);
  });
  lines.push('', missing
    ? '缺 ' + missing + ' 项。修复:https://myaccount.google.com/connections → 找到本脚本项目 → 删除访问权限 → 回编辑器重新运行任意函数并接受全部权限。'
    : '授权完整。');
  console.log(lines.join('\n'));
}

/**
 * Gemini 请求体诊断:用同一段极短文本,逐个字段变体打 generateContent,打印 HTTP 码与错误信息。
 * 用于把「400 invalid argument」定位到具体字段,而不是靠猜。每个变体消耗极少 token。
 */
function MM_geminiDiag() {
  MM_budgetStart_();
  const model = MM_conf_().model;
  const sys = 'Return minutes JSON for the transcript.';
  const parts = [{ text: 'MEETING TITLE: Diag\nMEETING DATE: 2026-09-03\n\nTRANSCRIPT:\nA: We agreed to ship v2 on Friday. B: I will write the release note by Thursday.' }];
  const base = () => MM_geminiPayload_(sys, parts, MM_SCHEMA_BILINGUAL, 1024, 'MINIMAL');

  const variants = [
    ['A 旧请求体(responseSchema + temperature 0.2 + thinkingBudget 0)', () => {
      const p = base(); const g = p.generationConfig;
      delete g.responseJsonSchema; g.responseSchema = MM_SCHEMA_BILINGUAL; g.temperature = 0.2; g.thinkingConfig = { thinkingBudget: 0 };
      return p;
    }],
    ['B 仅把 thinkingBudget 0 换成 thinkingLevel MINIMAL', () => {
      const p = base(); const g = p.generationConfig;
      delete g.responseJsonSchema; g.responseSchema = MM_SCHEMA_BILINGUAL; g.temperature = 0.2;
      return p;
    }],
    ['C B + 去掉 temperature', () => {
      const p = base(); const g = p.generationConfig;
      delete g.responseJsonSchema; g.responseSchema = MM_SCHEMA_BILINGUAL;
      return p;
    }],
    ['D 新请求体(responseJsonSchema + thinkingLevel,无 temperature)= 现行生产配置', base]
  ];

  const lines = ['model: ' + model];
  variants.forEach(v => {
    const r = MM_fetchGemini_(MM_CFG.GLA + '/models/' + model + ':generateContent', {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(v[1]())
    });
    let note = '';
    if (r.code === 200) {
      const c = (r.json().candidates || [])[0] || {};
      note = 'finishReason=' + c.finishReason + ' ' + String(((c.content || {}).parts || []).map(x => x.text || '').join('')).slice(0, 80).replace(/\s+/g, ' ');
    } else {
      note = r.text().replace(/\s+/g, ' ').slice(0, 220);
    }
    lines.push((r.code === 200 ? '✅ ' : '❌ ') + 'HTTP ' + r.code + '  ' + v[0] + '\n      ' + note);
  });
  console.log(lines.join('\n'));
  return lines.join('\n');
}

/** 打开后台数据表 */
function MM_openSheet() {
  const url = MM_ss_().getUrl();
  console.log('后台数据表: ' + url);
  return url;
}

/** 只读:系统涉及的所有链接(后台表、文件夹、最近一个 DONE 任务的 Doc),排查与截图用 */
function MM_urlsDump() {
  MM_budgetStart_();
  const c = MM_conf_();
  const done = MM_tasksLoad_().filter(x => String(x.status) === 'DONE').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const meet = MM_meetFolders_();
  return {
    sheet: MM_ss_().getUrl(),
    zh_folder: MM_zhFolder_().getUrl(),
    en_folder: c.enFolder && c.enFolder.toLowerCase() !== 'meeting' ? MM_folderByName_(c.enFolder).getUrl() : '(同 zh_folder)',
    audio_folder: MM_audioRoot_().getUrl(),
    meet_folder: meet.length ? meet[0].getUrl() : '',
    script: 'https://script.google.com/home/projects/' + ScriptApp.getScriptId(),
    last_done: done ? { task_id: done.task_id, title: done.title, doc_zh: done.doc_url_zh, doc_en: done.doc_url_en, jira: done.jira_sync } : null
  };
}
