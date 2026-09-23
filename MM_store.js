/**
 * MM_store.js — 会议双语纪要系统 · Sheets 持久层
 * 职责:任务表(状态机)、行动项追踪表、月度用量计数、result_json 溢出与过期清理
 * 依赖:MM_config.js
 * 被谁调用:MM_main.js / MM_render_*.js / MM_source_*.js / MM_setup.js
 *
 * 设计:C5 要求状态全部落 Sheets(Properties 单值仅 9KB)。
 *      表格 id 存脚本属性 MM_SHEET_ID,由 MM_setupOnce() 创建。
 */

const MM_SHEET = { TASKS: 'Tasks', ACTIONS: 'Actions', USAGE: 'Usage' };

// 任务表列定义(顺序即列序,改动需同步迁移已有表)
const MM_TASK_HEAD = [
  'task_id',        // 主键
  'source',         // MEET | AUDIO(入口 A / 入口 B)
  'dedup_key',      // 入口A=日历事件 instance id;入口B=Drive fileId(§4.3 / §3.2)
  'status',         // 见 §5 状态机
  'title',
  'meeting_date',   // ISO,会议日期(音频=文件创建时间)
  'event_id',
  'event_end',      // ISO
  'poll_deadline',  // ISO,结束时间 + POLL_WINDOW_HOURS
  'attendees',      // JSON 数组,attendees 邮件策略用
  'meet_code',      // Meet 会议码(从 hangoutLink 提取),Meet REST 查询用
  'src_kind',       // MEET_API | DRIVE_DOC | AUDIO
  'src_ref',        // 转录资源名 / Drive fileId
  'transcript_ref', // 压缩后转录正文;超长时存 'drive:<fileId>'
  'gemini_file',    // Gemini File API 资源名(files/xxx),终态后删除(C15)
  'duration_sec',   // 处理时长(分钟熔断计数用)
  'retry_count',
  'next_attempt_at',// ISO,指数退避后的最早重试时间
  'last_error',
  'result_json',    // Gemini 结果暂存(C7);超长时存 'drive:<fileId>'
  'doc_url_zh',
  'doc_url_en',
  'mail_sent',      // 'Y' 表示已发,保证 SEND_MAIL 幂等(C13)
  'jira_sync',      // "KEY:commentId;..." 已同步的 Jira 评论,保证 SYNC_JIRA 幂等;失败为 "ERR ..."
  'created_at',
  'updated_at',
  'doc_share',      // 英文 Doc 的共享结果,如 "domain:example.com" / "attendees:3" / "owner"(追加在末尾,避免迁移已有行)
  'organizer'       // 会议组织者邮箱(MM_MAIL_TO_ORGANIZER 用;追加在末尾,旧行为空)
];

const MM_ACTION_HEAD = [
  'action_id', 'meeting_id', 'meeting_title', 'meeting_date',
  'task_zh', 'task_en', 'owner', 'due', 'status', 'doc_url', 'created_at'
];

const MM_USAGE_HEAD = ['month', 'minutes', 'calls', 'updated_at'];

const MM_CELL_LIMIT = 45000;   // Sheets 单元格上限 5 万字符,留安全余量
const MM_DATA_FOLDER = 'MM_data';

// ============================================================
// 表格与工作表
// ============================================================

/** 打开后台表格;未初始化时给出明确指引 */
function MM_ss_() {
  const id = PropertiesService.getScriptProperties().getProperty(MM_CFG.P_SHEET_ID);
  if (!id) throw MM_fatal_('后台表格未初始化,请先运行 MM_setupOnce()');
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    throw MM_fatal_('后台表格打开失败(id=' + id + '): ' + e.message);
  }
}

/** 取工作表,不存在则创建并写表头;表头缺列时自动补齐 */
function MM_sheet_(name, head) {
  const ss = MM_ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  const cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), head.length)).getValues()[0];
  let need = false;
  for (let i = 0; i < head.length; i++) if (cur[i] !== head[i]) { need = true; break; }
  if (need) sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  return sh;
}

function MM_tasksSheet_() { return MM_sheet_(MM_SHEET.TASKS, MM_TASK_HEAD); }
function MM_actionsSheet_() { return MM_sheet_(MM_SHEET.ACTIONS, MM_ACTION_HEAD); }
function MM_usageSheet_() { return MM_sheet_(MM_SHEET.USAGE, MM_USAGE_HEAD); }

// ============================================================
// 任务表读写
// ============================================================

/** 全量读任务(每行转对象,附 _row 行号供回写) */
function MM_tasksLoad_() {
  const sh = MM_tasksSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, MM_TASK_HEAD.length).getValues();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i];
    if (!row[0]) continue;                        // 跳过空行
    const o = { _row: i + 2 };
    for (let c = 0; c < MM_TASK_HEAD.length; c++) o[MM_TASK_HEAD[c]] = row[c];
    o.retry_count = Number(o.retry_count || 0);
    out.push(o);
  }
  return out;
}

/** 回写整行(状态机每步落盘都走这里,保证列序一致) */
function MM_taskSave_(task) {
  if (!task || !task._row) throw MM_fatal_('MM_taskSave_: 缺少 _row');
  task.updated_at = MM_iso_(new Date());
  const sh = MM_tasksSheet_();
  sh.getRange(task._row, 1, 1, MM_TASK_HEAD.length).setValues([MM_TASK_HEAD.map(k => {
    const v = task[k];
    return (v === undefined || v === null) ? '' : v;
  })]);
}

/** 新建任务行;返回带 _row 的任务对象 */
function MM_taskAppend_(obj) {
  const sh = MM_tasksSheet_();
  const now = MM_iso_(new Date());
  const t = Object.assign({
    task_id: MM_newTaskId_(),
    retry_count: 0, next_attempt_at: '', last_error: '', result_json: '', transcript_ref: '',
    doc_url_zh: '', doc_url_en: '', mail_sent: '', jira_sync: '', doc_share: '', organizer: '', gemini_file: '', duration_sec: 0,
    created_at: now, updated_at: now
  }, obj);
  sh.appendRow(MM_TASK_HEAD.map(k => (t[k] === undefined || t[k] === null) ? '' : t[k]));
  t._row = sh.getLastRow();
  return t;
}

function MM_newTaskId_() {
  return 'T' + MM_fmtDate_(new Date(), 'yyyyMMddHHmmss') + '-' +
    Utilities.getUuid().replace(/-/g, '').slice(0, 4);
}

/** 按去重键查任务(§4.3:入口A 用事件 instance id,入口B 用 Drive fileId) */
function MM_taskByDedup_(tasks, key) {
  for (let i = 0; i < tasks.length; i++) if (String(tasks[i].dedup_key) === String(key)) return tasks[i];
  return null;
}

/** 终态判定 */
function MM_isTerminal_(status) {
  return ['DONE', 'FAILED', 'EXPIRED', 'CANCELLED'].indexOf(String(status)) >= 0;
}

// ============================================================
// 大字段存取(超长自动溢出到 Drive,规避 5 万字符单元格上限)
// ============================================================

function MM_dataFolder_() {
  const it = DriveApp.getFoldersByName(MM_DATA_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(MM_DATA_FOLDER);
}

/** 存字符串:短则内联返回原串,长则落 Drive 返回 'drive:<fileId>' */
function MM_putBlob_(name, str) {
  const s = String(str == null ? '' : str);
  if (s.length <= MM_CELL_LIMIT) return s;
  const f = MM_dataFolder_().createFile(name, s, 'text/plain');
  return 'drive:' + f.getId();
}

/** 取字符串:自动识别 drive: 前缀 */
function MM_getBlob_(ref) {
  const raw = String(ref || '');
  if (!raw) return '';
  if (raw.indexOf('drive:') !== 0) return raw;
  try {
    return DriveApp.getFileById(raw.slice(6)).getBlob().getDataAsString();
  } catch (e) {
    MM_warn_('溢出文件读取失败 ' + raw + ': ' + e.message);
    return '';
  }
}

/** 删除溢出文件(内联值直接忽略) */
function MM_delBlob_(ref) {
  const raw = String(ref || '');
  if (raw.indexOf('drive:') !== 0) return;
  try { DriveApp.getFileById(raw.slice(6)).setTrashed(true); } catch (e) { /* 已删则忽略 */ }
}

/** 写入 Gemini 结果(C7:成功后落盘,重试不重复调用) */
function MM_putResult_(task, obj) {
  task.result_json = MM_putBlob_(task.task_id + '.json', JSON.stringify(obj));
}

/** 读取 Gemini 结果;无结果返回 null */
function MM_getResult_(task) {
  const s = MM_getBlob_(task.result_json);
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) {
    MM_warn_('result_json 解析失败 ' + task.task_id + ': ' + e.message);
    return null;
  }
}

/** C15:DONE 超过 RESULT_TTL_DAYS 的任务清空 result_json / transcript_ref */
function MM_purgeResults_() {
  const tasks = MM_tasksLoad_();
  const cutoff = Date.now() - MM_CFG.RESULT_TTL_DAYS * 86400000;
  let n = 0;
  tasks.forEach(t => {
    if (t.status !== 'DONE' || (!t.result_json && !t.transcript_ref)) return;
    const upd = MM_parseDate_(t.updated_at);
    if (!upd || upd.getTime() > cutoff) return;
    MM_delBlob_(t.result_json);
    MM_delBlob_(t.transcript_ref);
    t.result_json = '';
    t.transcript_ref = '';
    MM_taskSave_(t);
    n++;
  });
  if (n) MM_log_('已清理 ' + n + ' 条过期 result_json');
  return n;
}

// ============================================================
// 行动项表(按 action_id upsert,保证 WRITE_SHEET 幂等 C13)
// ============================================================

/**
 * rows: [{action_id, meeting_id, meeting_title, meeting_date, task_zh, task_en, owner, due, doc_url}]
 * status 列由人工维护:已存在的行不覆盖 status。
 */
function MM_actionsUpsert_(rows) {
  if (!rows || !rows.length) return 0;
  const sh = MM_actionsSheet_();
  const last = sh.getLastRow();
  const existing = {};
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) if (ids[i][0]) existing[String(ids[i][0])] = i + 2;
  }
  const now = MM_iso_(new Date());
  const appends = [];
  rows.forEach(r => {
    const rowIdx = existing[String(r.action_id)];
    if (rowIdx) {
      // 已存在:更新内容列,保留人工维护的 status 与 created_at
      const cur = sh.getRange(rowIdx, 1, 1, MM_ACTION_HEAD.length).getValues()[0];
      const merged = MM_ACTION_HEAD.map((k, i) => {
        if (k === 'status') return cur[i] || 'OPEN';
        if (k === 'created_at') return cur[i] || now;
        return (r[k] === undefined || r[k] === null) ? '' : r[k];
      });
      sh.getRange(rowIdx, 1, 1, MM_ACTION_HEAD.length).setValues([merged]);
    } else {
      appends.push(MM_ACTION_HEAD.map(k => {
        if (k === 'status') return 'OPEN';
        if (k === 'created_at') return now;
        return (r[k] === undefined || r[k] === null) ? '' : r[k];
      }));
    }
  });
  if (appends.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appends.length, MM_ACTION_HEAD.length).setValues(appends);
  }
  return rows.length;
}

/** 读取待跟进行动项(status=OPEN 且 due 已过或 daysAhead 天内到期;无 due 的按超龄 14 天纳入) */
function MM_actionsPending_(daysAhead) {
  const sh = MM_actionsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const vals = sh.getRange(2, 1, last - 1, MM_ACTION_HEAD.length).getValues();
  const horizon = Date.now() + (daysAhead || 7) * 86400000;
  const staleCut = Date.now() - 14 * 86400000;
  const out = [];
  vals.forEach(row => {
    const o = {};
    MM_ACTION_HEAD.forEach((k, i) => { o[k] = row[i]; });
    if (!o.action_id || String(o.status).toUpperCase() !== 'OPEN') return;
    const due = MM_parseDate_(o.due);
    if (due) {
      if (due.getTime() <= horizon) out.push(o);
    } else {
      const c = MM_parseDate_(o.created_at);
      if (c && c.getTime() <= staleCut) out.push(o);   // 无截止但挂了两周以上,也提醒
    }
  });
  out.sort((a, b) => {
    const da = MM_parseDate_(a.due), db = MM_parseDate_(b.due);
    return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
  });
  return out;
}

/**
 * 只读诊断:导出行动项表(最近 limit 条,默认 30;onlyOpen=true 只看 OPEN)。
 * 远程运维用,回答「这条行动项的 action_id 是什么 / 现在什么状态」。
 */
function MM_actionsDump(limit, onlyOpen) {
  MM_budgetStart_();
  const sh = MM_actionsSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  const n = Number(limit) > 0 ? Number(limit) : 30;
  const vals = sh.getRange(2, 1, last - 1, MM_ACTION_HEAD.length).getValues();
  const rows = [];
  vals.forEach(row => {
    const o = {};
    MM_ACTION_HEAD.forEach((k, i) => { o[k] = row[i] instanceof Date ? MM_iso_(row[i]) : String(row[i] == null ? '' : row[i]); });
    if (!o.action_id) return;
    if (onlyOpen && String(o.status).toUpperCase() !== 'OPEN') return;
    rows.push(o);
  });
  return rows.slice(-n);
}

/**
 * 改一条行动项的 status(OPEN / DONE / DROPPED),可选同时改 due(ISO 日期,传 '' 清空)。
 * 供所有者替同事更新用;下一次周一汇总即按新状态过滤。
 * @return {{action_id:string, status:string, due:string, task_zh:string}}
 */
function MM_actionSetStatus(actionId, status, due) {
  MM_budgetStart_();
  const id = String(actionId || '').trim();
  const st = String(status || '').trim().toUpperCase();
  if (!id) throw MM_fatal_('缺少 action_id');
  if (['OPEN', 'DONE', 'DROPPED'].indexOf(st) < 0) throw MM_fatal_('status 只能是 OPEN / DONE / DROPPED,收到: ' + status);

  const sh = MM_actionsSheet_();
  const last = sh.getLastRow();
  if (last < 2) throw MM_fatal_('行动项表为空');
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  let row = 0;
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === id) { row = i + 2; break; }
  if (!row) throw MM_fatal_('未找到行动项 ' + id);

  const iStatus = MM_ACTION_HEAD.indexOf('status') + 1;
  const iDue = MM_ACTION_HEAD.indexOf('due') + 1;
  const iTask = MM_ACTION_HEAD.indexOf('task_zh') + 1;
  sh.getRange(row, iStatus).setValue(st);
  if (due !== undefined && due !== null) {
    const d = String(due).trim() ? MM_parseDate_(due) : null;
    if (String(due).trim() && !d) throw MM_fatal_('due 不是合法日期: ' + due);
    sh.getRange(row, iDue).setValue(d ? MM_iso_(d) : '');
  }
  const out = { action_id: id, status: st, due: String(sh.getRange(row, iDue).getValue() || ''), task_zh: String(sh.getRange(row, iTask).getValue() || '') };
  MM_log_('行动项 ' + id + ' → ' + st);
  return out;
}

// ============================================================
// 月度用量与熔断(§9)
// ============================================================

function MM_monthKey_() { return MM_fmtDate_(new Date(), 'yyyy-MM'); }

/** 返回当月 {row, minutes, calls};不存在则建行 */
function MM_usageRow_() {
  const sh = MM_usageSheet_();
  const key = MM_monthKey_();
  const last = sh.getLastRow();
  if (last >= 2) {
    const vals = sh.getRange(2, 1, last - 1, MM_USAGE_HEAD.length).getValues();
    for (let i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === key) {
        return { row: i + 2, minutes: Number(vals[i][1] || 0), calls: Number(vals[i][2] || 0) };
      }
    }
  }
  sh.appendRow([key, 0, 0, MM_iso_(new Date())]);   // 新月份自动开新行,等同按月重置
  return { row: sh.getLastRow(), minutes: 0, calls: 0 };
}

/** 累加处理时长(分钟)与调用次数 */
function MM_usageAdd_(minutes, calls) {
  const sh = MM_usageSheet_();
  const u = MM_usageRow_();
  sh.getRange(u.row, 2, 1, 3).setValues([[
    u.minutes + Number(minutes || 0),
    u.calls + Number(calls || 1),
    MM_iso_(new Date())
  ]]);
}

/** 熔断判定:当月累计处理时长是否已超上限 */
function MM_usageOverLimit_() {
  const cap = MM_conf_().maxMonthlyMinutes;
  return MM_usageRow_().minutes >= cap;
}
