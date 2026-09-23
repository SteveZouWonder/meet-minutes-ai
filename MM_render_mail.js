/**
 * MM_render_mail.js — 邮件渲染与发送
 * 职责:纪要邮件(中文在上英文在下)、告警邮件、每周未完成行动项汇总
 * 依赖:MM_config.js、MM_store.js、MM_util.js(escapeHtml_ / getDailyTheme)
 * 被谁调用:MM_main.js 的 SEND_MAIL 状态、异常处理、planner 的周一汇总
 *
 * 收件人纪律(C11 / §6.4):默认只发脚本所有者。可按需叠加三种收件人,全部来自「这场会」:
 *  - MM_MAIL_POLICY=attendees      → bcc 该会议全部参会人(粒度最粗,不推荐长期开)
 *  - MM_MAIL_TO_ORGANIZER=on       → 他人组织的会,to 加上组织者
 *  - MM_SUBSCRIBERS=a@x.com,b@x.com → 名单里的人只要在参会人列表中就收到(按人订阅)
 * 严禁接入 news.js 的全局 RECIPIENTS 列表。告警与周报一律只发所有者。
 */

/**
 * 按策略解析收件人。音频任务无参会人,恒定只发所有者。
 * to  = 所有者 (+ 组织者,若 MM_MAIL_TO_ORGANIZER=on 且组织者不是所有者)
 * bcc = 订阅者(MM_SUBSCRIBERS ∩ 参会人) ∪ 全部参会人(仅 MM_MAIL_POLICY=attendees)
 */
function MM_recipients_(task) {
  const cfg = MM_conf_();
  const owner = MM_owner_();
  const ownerLc = owner.toLowerCase();
  const out = { to: owner, bcc: '' };
  if (String(task.source) === 'AUDIO') return out;

  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const to = [owner];
  const org = String(task.organizer || '').trim().toLowerCase();
  if (cfg.mailToOrganizer && org && org !== ownerLc && re.test(org)) to.push(org);

  const bcc = [];
  const add = addr => {
    const a = String(addr || '').trim().toLowerCase();
    if (a && a !== ownerLc && a !== org && re.test(a) && bcc.indexOf(a) < 0) bcc.push(a);
  };
  MM_subscribersInMeeting_(task).forEach(add);
  if (cfg.mailPolicy === 'attendees') MM_taskAttendees_(task).forEach(add);

  out.to = to.join(',');
  out.bcc = bcc.join(',');
  return out;
}

/**
 * 发送纪要邮件(SEND_MAIL 状态;调用方负责 mail_sent 幂等标记)。
 * @param {Object} task
 * @param {Object} data 规范化双语纪要
 * @param {{zh:string,en:string}} urls
 * @param {string} warn 降级说明(可空)
 */
function MM_sendMinutes_(task, data, urls, warn) {
  const cfg = MM_conf_();
  if (cfg.deliver === 'doc') { MM_log_('DELIVER=doc,跳过邮件'); return; }

  const r = MM_recipients_(task);
  const dateStr = MM_fmtDate_(MM_parseDate_(task.meeting_date) || new Date(), 'yyyy-MM-dd');
  const title = String(task.title || data.t.zh || data.t.en || 'Meeting');
  const html = MM_minutesHtml_(task, data, urls, warn, dateStr, title);

  MailApp.sendEmail({
    to: r.to,
    bcc: r.bcc,
    subject: '[会议纪要] ' + dateStr + ' ' + title,
    htmlBody: html
  });
  MM_log_('纪要邮件已发送 to=' + r.to.split(',').length + ' 人 bcc=' + (r.bcc ? r.bcc.split(',').length + ' 人' : '无'));
}

// ============================================================
// HTML 构建(全内联样式;所有外部文本一律 escapeHtml_,C4)
// ============================================================

function MM_minutesHtml_(task, data, urls, warn, dateStr, title) {
  const theme = getDailyTheme(new Date().getDay());       // 复用 news.js 的每日配色
  const enOnly = data._enOnly === true;
  const cfg = MM_conf_();

  let h = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:\'Segoe UI\',Tahoma,sans-serif;background:' + theme.bg + ';margin:0;padding:0;">' +
    '<div style="max-width:680px;margin:20px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ' + theme.border + ';">' +
    '<div style="background:' + theme.primary + ';color:#fff;padding:28px 20px;">' +
    '<div style="font-size:11px;letter-spacing:3px;opacity:.8;">MEETING MINUTES / 会议纪要</div>' +
    '<h1 style="margin:8px 0 0;font-size:21px;font-weight:500;">' + escapeHtml_(title) + '</h1>' +
    '<p style="margin:6px 0 0;font-size:13px;opacity:.9;">' + escapeHtml_(dateStr) + ' · ' + escapeHtml_(MM_srcLabel_(task.src_kind)) + '</p>' +
    '</div>';

  if (warn) {
    h += '<div style="margin:16px 20px;padding:12px;background:#fef3c7;border-left:4px solid #d97706;font-size:13px;color:#78350f;">' +
      '⚠️ ' + escapeHtml_(warn) + '</div>';
  }

  // 中文在上、英文在下(§6.4)
  if (!enOnly && cfg.lang !== 'en') h += MM_mailSection_(data, 'zh', theme);
  if (cfg.lang !== 'zh' || enOnly) h += MM_mailSection_(data, 'en', theme);

  // 底部 Doc 链接(merged 模式下中英同一份,只出一个链接)
  const links = [];
  if (urls && urls.zh && urls.zh === urls.en) {
    links.push({ label: '双语纪要 Doc', url: urls.zh });
  } else {
    if (urls && urls.zh) links.push({ label: '中文纪要 Doc', url: urls.zh });
    if (urls && urls.en) links.push({ label: 'English Minutes Doc', url: urls.en });
  }
  if (links.length) {
    h += '<div style="padding:20px;border-top:1px solid #eee;background:#f8fafc;">';
    links.forEach(l => {
      h += '<a href="' + escapeHtml_(l.url) + '" style="display:inline-block;margin:0 8px 8px 0;padding:9px 16px;background:' +
        theme.accent + ';color:#fff!important;text-decoration:none;border-radius:6px;font-size:12px;font-weight:bold;">' +
        escapeHtml_(l.label) + '</a>';
    });
    h += '<p style="font-size:11px;color:#94a3b8;margin:8px 0 0;">' + escapeHtml_(MM_shareNote_(task)) + '</p></div>';
  }

  h += '<div style="text-align:center;padding:18px;font-size:11px;color:#94a3b8;background:#f8fafc;border-top:1px solid #eee;">' +
    '内容由 AI 自动抽取,可能存在遗漏或误解,请以会议原文为准</div></div></body></html>';
  return h;
}

function MM_mailSection_(data, lang, theme) {
  const L = MM_DOC_L[lang];
  const pick = x => escapeHtml_(String((x && x[lang]) || ''));
  const head = t => '<div style="font-size:15px;color:' + theme.primary + ';border-left:5px solid ' + theme.accent +
    ';padding-left:10px;margin:24px 20px 10px;font-weight:bold;">' + escapeHtml_(t) + '</div>';

  let h = '<div style="padding-bottom:8px;">';

  h += head(L.summary);
  h += '<p style="margin:0 20px;font-size:14px;color:#1e293b;line-height:1.7;">' + (pick(data.s) || L.none) + '</p>';

  h += head(L.decisions);
  if (!data.d.length) {
    h += '<p style="margin:0 20px;font-size:13px;color:#94a3b8;">' + L.none + '</p>';
  } else {
    h += '<ul style="margin:0 20px;padding-left:18px;font-size:14px;color:#1e293b;line-height:1.7;">';
    data.d.forEach(x => {
      const tag = (MM_CFG.DECISION_LABEL[x.k] || MM_CFG.DECISION_LABEL[1])[lang];
      h += '<li><span style="display:inline-block;padding:1px 7px;margin-right:6px;border-radius:3px;background:' +
        MM_kColor_(x.k) + ';color:#fff;font-size:11px;">' + escapeHtml_(tag) + '</span>' + pick(x) + '</li>';
    });
    h += '</ul>';
  }

  h += head(L.actions);
  if (!data.a.length) {
    h += '<p style="margin:0 20px;font-size:13px;color:#94a3b8;">' + L.none + '</p>';
  } else {
    h += '<table style="margin:0 20px;border-collapse:collapse;font-size:13px;width:calc(100% - 40px);">' +
      '<tr style="background:' + theme.bg + ';"><th align="left" style="padding:6px 8px;border:1px solid ' + theme.border + ';">' + escapeHtml_(L.task) + '</th>' +
      '<th align="left" style="padding:6px 8px;border:1px solid ' + theme.border + ';width:110px;">' + escapeHtml_(L.owner) + '</th>' +
      '<th align="left" style="padding:6px 8px;border:1px solid ' + theme.border + ';width:100px;">' + escapeHtml_(L.due) + '</th></tr>';
    data.a.forEach(x => {
      h += '<tr><td style="padding:6px 8px;border:1px solid #e2e8f0;">' + pick(x) + '</td>' +
        '<td style="padding:6px 8px;border:1px solid #e2e8f0;">' + escapeHtml_(x.o || '-') + '</td>' +
        '<td style="padding:6px 8px;border:1px solid #e2e8f0;">' + escapeHtml_(x.u || '-') + '</td></tr>';
    });
    h += '</table>';
  }

  h += head(L.topics);
  if (!data.p.length) {
    h += '<p style="margin:0 20px;font-size:13px;color:#94a3b8;">' + L.none + '</p>';
  } else {
    h += '<ul style="margin:0 20px;padding-left:18px;font-size:14px;color:#334155;line-height:1.7;">';
    data.p.forEach(x => { h += '<li>' + pick(x) + '</li>'; });
    h += '</ul>';
  }

  if (data.g && data.g.length) {
    h += head(L.glossary);
    h += '<p style="margin:0 20px;font-size:13px;color:#475569;line-height:1.8;">' +
      data.g.map(x => escapeHtml_(x.e) + ' = ' + escapeHtml_(x.z)).join(' · ') + '</p>';
  }

  return h + '</div>';
}

/** 邮件底部的可见范围说明,按实际共享结果生成 */
function MM_shareNote_(task) {
  let s = String(task.doc_share || '');
  let pre = '';
  const m = /^subscribers:(\d+)\+/.exec(s);
  if (m) { pre = '英文版已对 ' + m[1] + ' 位订阅者开放查看'; s = s.slice(m[0].length); }
  let en;
  if (s.indexOf('project:') === 0) en = '英文版已对 ' + s.split(':')[1] + ' 项目组成员开放查看';
  else if (s.indexOf('domain:') === 0) en = '英文版对 ' + s.slice(7).split(' ')[0].replace(/\|/g, ' / ') + ' 组织成员(知道链接者)可查看';
  else if (s.indexOf('attendees:') === 0) en = '英文版已对参会人开放查看';
  else if (s === 'anyone') en = '英文版对任何拥有链接者可查看';
  else en = pre ? '其他人需要访问请申请权限' : '英文版仅所有者可见,需要访问请申请权限';
  return (pre ? pre + ',' : '') + en + ';中文版为私人文件,仅所有者可见。';
}

function MM_kColor_(k) {
  return { 0: '#15803d', 1: '#a16207', 2: '#b91c1c', 3: '#64748b' }[MM_kInt_(k)] || '#64748b';
}

// ============================================================
// 告警(§6.4:只发所有者,不打扰任何其他人)
// ============================================================

function MM_alert_(subject, text) {
  try {
    MailApp.sendEmail(MM_owner_(), '[会议纪要系统] ' + subject, String(text || '').slice(0, 8000));
  } catch (e) {
    MM_warn_('告警邮件发送失败: ' + e.message);   // 告警失败不能再抛,否则递归
  }
}

/**
 * 每日至多一封的告警(用于熔断这类「只要不解决就每 15 分钟触发一次」的条件),
 * 避免一天灌 96 封重复邮件。去重标记存脚本属性(仅一个日期字符串,远低于 9KB 限制)。
 */
function MM_alertOncePerDay_(key, subject, text) {
  const p = PropertiesService.getScriptProperties();
  const propKey = 'MM_ALERTED_' + key;
  const today = MM_fmtDate_(new Date(), 'yyyy-MM-dd');
  if (p.getProperty(propKey) === today) return false;
  p.setProperty(propKey, today);
  MM_alert_(subject, text);
  return true;
}

/** 超窗告警:附「转音频补救」说明(§4.4) */
function MM_alertExpired_(task) {
  MM_alert_('会议超窗无产物:' + task.title, [
    '会议:' + task.title,
    '日期:' + MM_fmtDate_(MM_parseDate_(task.meeting_date) || new Date(), 'yyyy-MM-dd HH:mm'),
    '任务:' + task.task_id,
    '',
    '结束后 ' + MM_conf_().pollHours + ' 小时内既没有 Meet 转录,也没有 Drive 转录文档,已标记 EXPIRED。',
    '',
    '补救方式:把会议录音转成音频后放进 Drive/' + MM_conf_().audioFolder + '/,系统会在 15 分钟内自动处理。',
    MM_FFMPEG_HINT
  ].join('\n'));
}

// ============================================================
// 每周未完成行动项汇总(§6.5 / §11-Q3;只发所有者)
// ============================================================

function MM_weeklyDigest_() {
  const rows = MM_actionsPending_(7);
  const owner = MM_owner_();
  if (!rows.length) {
    MM_log_('本周无待跟进行动项,跳过汇总邮件');
    return 0;
  }
  const today = MM_fmtDate_(new Date(), 'yyyy-MM-dd');
  MailApp.sendEmail({ to: owner, subject: '[会议纪要系统] 未完成行动项汇总 ' + today, htmlBody: MM_digestHtml_(rows) });
  MM_log_('周报已发送,' + rows.length + ' 项');
  return rows.length;
}

/** 周一汇总的 HTML(与发送内容一致;MM_previewDigest 也用它) */
function MM_digestHtml_(rows) {
  const theme = getDailyTheme(new Date().getDay());
  const today = MM_fmtDate_(new Date(), 'yyyy-MM-dd');
  let h = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
    '<body style="font-family:\'Segoe UI\',Tahoma,sans-serif;background:' + theme.bg + ';margin:0;padding:20px;">' +
    '<div style="max-width:720px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid ' + theme.border + ';">' +
    '<div style="background:' + theme.primary + ';color:#fff;padding:22px;">' +
    '<h1 style="margin:0;font-size:19px;font-weight:500;">未完成行动项汇总 / Open Action Items</h1>' +
    '<p style="margin:6px 0 0;font-size:12px;opacity:.85;">' + escapeHtml_(today) + ' · 共 ' + rows.length + ' 项</p></div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
    '<tr style="background:' + theme.bg + ';">' +
    ['任务 / Task', '负责人', '截止', '会议', ''].map(t =>
      '<th align="left" style="padding:8px;border-bottom:1px solid ' + theme.border + ';">' + escapeHtml_(t) + '</th>').join('') +
    '</tr>';

  const now = Date.now();
  rows.forEach(r => {
    const due = MM_parseDate_(r.due);
    const overdue = due && due.getTime() < now;
    const dueTxt = due ? MM_fmtDate_(due, 'yyyy-MM-dd') : '—';
    h += '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + escapeHtml_(r.task_zh || r.task_en) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' + escapeHtml_(r.owner || '—') + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #f1f5f9;color:' + (overdue ? '#b91c1c' : '#334155') + ';font-weight:' + (overdue ? 'bold' : 'normal') + ';">' +
        escapeHtml_(dueTxt) + (overdue ? ' ⚠️' : '') + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#64748b;">' + escapeHtml_(String(r.meeting_title || '')) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #f1f5f9;">' +
        (r.doc_url ? '<a href="' + escapeHtml_(String(r.doc_url)) + '" style="color:' + theme.accent + ';font-size:12px;">纪要</a>' : '') +
      '</td></tr>';
  });

  h += '</table><div style="padding:16px;font-size:11px;color:#94a3b8;background:#f8fafc;">' +
    '在追踪表的 status 列填 DONE 或 DROPPED 即可从本汇总中移除。</div></div></body></html>';
  return h;
}

// ============================================================
// 预览(只读,不发信):给文档截图 / 调样式用,远程白名单可调
// ============================================================

/** 虚构示例(文档截图 / 调样式用,不含任何真实会议内容) */
const MM_SAMPLE = {
  task: { task_id: 'SAMPLE', title: 'PROJ-1234 Q4 Launch Planning', meeting_date: '2026-10-08T10:00:00+08:00', src_kind: 'DRIVE_DOC',
    source: 'MEET', doc_share: 'subscribers:2+owner', doc_url_zh: 'https://docs.google.com/document/d/SAMPLE-ZH/edit', doc_url_en: 'https://docs.google.com/document/d/SAMPLE-EN/edit' },
  data: {
    t: { zh: 'Q4 发布计划', en: 'Q4 Launch Planning' },
    s: { zh: '会议确认 Q4 发布日期定为 11 月 18 日,范围收窄为结算与通知两个模块;支付网关切换推迟到 Q1。团队同意在 UAT 环境先做两周灰度,由 Alex 负责发布清单,Mia 负责客服话术。',
         en: 'The team fixed the Q4 launch for 18 November and narrowed scope to the billing and notification modules; the payment-gateway switch moves to Q1. A two-week canary in UAT was agreed, with Alex owning the release checklist and Mia the support scripts.' },
    d: [
      { k: 0, zh: '发布日期定为 11 月 18 日,不再顺延。', en: 'Launch date is 18 November; no further slips.' },
      { k: 0, zh: '支付网关切换移出 Q4 范围,进入 Q1 规划。', en: 'Payment-gateway switch is out of Q4 scope and goes to Q1 planning.' },
      { k: 1, zh: '通知模块是否保留短信通道,待成本数据出来后再定。', en: 'Whether the notification module keeps the SMS channel is deferred until cost data is in.' },
      { k: 2, zh: '灰度比例 5% 还是 20%,工程与运营意见不一致。', en: 'Canary ratio 5% vs 20% — engineering and operations disagree.' }
    ],
    a: [
      { zh: '整理 Q4 发布清单并在周五前发给全组。', en: 'Compile the Q4 release checklist and circulate by Friday.', o: 'Alex Chen', u: '2026-10-10' },
      { zh: '起草客服话术,覆盖结算与通知两个模块的常见问题。', en: 'Draft support scripts covering billing and notification FAQs.', o: 'Mia Wang', u: '2026-10-15' },
      { zh: '拉取短信通道近三个月的成本数据。', en: 'Pull three months of SMS-channel cost data.', o: 'Sam Lee', u: '' }
    ],
    p: [
      { zh: '范围收窄:Alex 提出把支付网关切换移出 Q4,理由是第三方 SDK 的合规审查要到 12 月才结束;全组无异议。', en: 'Scope cut: Alex proposed moving the payment-gateway switch out of Q4 because the third-party SDK compliance review runs until December; no objections.' },
      { zh: '灰度策略:Mia 主张 20% 以尽快暴露问题,Sam 担心客服承压,建议 5% 起步、一周后评估。未达成一致,下周复议。', en: 'Canary strategy: Mia argued for 20% to surface issues quickly; Sam worried about support load and suggested starting at 5% with a review after one week. No consensus; revisit next week.' },
      { zh: '短信通道:每月成本约占通知模块总成本的 60%,但打开率高于推送。等 Sam 的数据后再决定是否保留。', en: 'SMS channel: about 60% of the notification module cost but a higher open rate than push. Decision waits for Sam\'s data.' }
    ],
    g: [ { e: 'Canary release', z: '灰度发布' }, { e: 'UAT', z: '用户验收测试' }, { e: 'Release checklist', z: '发布清单' } ]
  },
  actions: [
    { action_id: 'SAMPLE#1', meeting_title: 'PROJ-1234 Q4 Launch Planning', task_zh: '整理 Q4 发布清单并在周五前发给全组。', owner: 'Alex Chen', due: '2026-10-10', status: 'OPEN', doc_url: 'https://docs.google.com/document/d/SAMPLE-EN/edit' },
    { action_id: 'SAMPLE#2', meeting_title: 'PROJ-1234 Q4 Launch Planning', task_zh: '起草客服话术,覆盖结算与通知两个模块的常见问题。', owner: 'Mia Wang', due: '2026-09-20', status: 'OPEN', doc_url: 'https://docs.google.com/document/d/SAMPLE-EN/edit' },
    { action_id: 'SAMPLE#3', meeting_title: 'Weekly Ops Sync', task_zh: '更新值班表并同步到日历。', owner: 'Sam Lee', due: '', status: 'OPEN', doc_url: 'https://docs.google.com/document/d/SAMPLE-OPS/edit' }
  ]
};

/** 某个已完成任务的纪要邮件 HTML;缺省取最近一个 DONE 任务;sample=true 用虚构示例 */
function MM_previewMail(taskId, sample) {
  MM_budgetStart_();
  if (sample) {
    const st = MM_SAMPLE.task, sd = MM_SAMPLE.data;
    const ds = MM_fmtDate_(MM_parseDate_(st.meeting_date), 'yyyy-MM-dd');
    return { task_id: 'SAMPLE', subject: '[会议纪要] ' + ds + ' ' + st.title, html: MM_minutesHtml_(st, sd, { zh: st.doc_url_zh, en: st.doc_url_en }, '', ds, st.title) };
  }
  const tasks = MM_tasksLoad_();
  const t = taskId
    ? tasks.filter(x => String(x.task_id) === String(taskId))[0]
    : tasks.filter(x => String(x.status) === 'DONE' && x.result_json).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (!t) throw MM_fatal_('未找到可预览的任务(需 DONE 且 result_json 未过期)');
  const data = MM_getResult_(t);
  if (!data) throw MM_fatal_('任务 ' + t.task_id + ' 的 result_json 已清空');
  const dateStr = MM_fmtDate_(MM_parseDate_(t.meeting_date) || new Date(), 'yyyy-MM-dd');
  const title = String(t.title || data.t.zh || data.t.en || 'Meeting');
  return { task_id: t.task_id, subject: '[会议纪要] ' + dateStr + ' ' + title,
    html: MM_minutesHtml_(t, data, { zh: t.doc_url_zh, en: t.doc_url_en }, data._warn || '', dateStr, title) };
}

/**
 * 周一汇总的 HTML。mode: 缺省 = 真实待办;'all' = 忽略 status / due 过滤渲染全部行动项;'sample' = 虚构示例。
 */
function MM_previewDigest(mode) {
  MM_budgetStart_();
  let rows;
  if (mode === 'sample') rows = MM_SAMPLE.actions;
  else if (mode === 'all' || mode === true) rows = MM_actionsDump(50);
  else rows = MM_actionsPending_(7);
  return { count: rows.length, html: rows.length ? MM_digestHtml_(rows) : '' };
}
