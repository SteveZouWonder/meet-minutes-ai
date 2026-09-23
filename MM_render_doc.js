/**
 * MM_render_doc.js — 纪要 Google Doc 生成
 * 职责:按 LANG / FILE_MODE 产出中文 / 英文 / 双语 Doc,按「目标文件夹 + 标题」查重保证幂等(C13)
 * 依赖:MM_config.js、MM_source_audio.js(取音频纪要子文件夹)
 * 被谁调用:MM_main.js 的 RENDER_DOC 状态处理
 *
 * 落点与共享(见 MM_CFG.DOC_SHARE / SUBSCRIBERS / ZH_FOLDER / EN_FOLDER):
 *  - 中英文版默认都落在所有者私人文件夹 ZH_FOLDER(MM_EN_FOLDER 可让英文版单独一夹,或 'meeting' 恢复跟随会议目录);
 *  - 英文版生成后按 MM_shareDoc_ 的优先级开放:项目组成员 → 订阅者(在参会人中的)+ MM_DOC_SHARE;
 *    落在私人文件夹只影响「在哪找得到」,不影响链接可见性;
 *  - 中文版永远仅所有者可见,不做任何共享;
 *  - 'anyone' 需显式配置,默认不开放「知道链接的任何人」(§10)。
 */

const MM_DOC_L = {
  zh: { summary: '摘要', decisions: '决策项', actions: '行动项', topics: '议题详情', glossary: '术语对照表',
        owner: '负责人', due: '截止', none: '（无）', task: '任务', term: '术语', trans: '中文' },
  en: { summary: 'Summary', decisions: 'Decisions', actions: 'Action Items', topics: 'Topic Details', glossary: 'Glossary',
        owner: 'Owner', due: 'Due', none: '(none)', task: 'Task', term: 'Term', trans: 'Chinese' }
};

const MM_DOC_SUFFIX = {
  zh: '中文纪要',
  en: 'English Minutes',
  both: '双语纪要 / Bilingual Minutes'
};

/**
 * 生成纪要 Doc。
 * @param {Object} task 任务行
 * @param {Object} data 规范化后的双语纪要
 * @return {{zh:string, en:string}} 文档 URL(未生成的为空串)
 */
function MM_renderDocs_(task, data) {
  const cfg = MM_conf_();
  const folder = MM_enFolder_(task);                 // 英文版 / 合并版落点
  const base = MM_docBaseName_(task, data);
  const enOnly = data._enOnly === true;               // §7:中文生成失败 → 只出英文版

  let langs;
  if (enOnly) langs = ['en'];
  else if (cfg.lang === 'zh') langs = ['zh'];
  else if (cfg.lang === 'en') langs = ['en'];
  else langs = ['zh', 'en'];

  const urls = { zh: '', en: '' };

  // merged 模式:中英合成一份,中文在前。注意:合并版含中文,共享范围仍按 DOC_SHARE 执行(需要私密中文请用 split)
  if (cfg.fileMode === 'merged' && langs.length === 2) {
    const url = MM_docEnsure_(folder, base + ' — ' + MM_DOC_SUFFIX.both, doc => MM_docFill_(doc, task, data, ['zh', 'en']));
    urls.zh = url; urls.en = url;
    task.doc_share = MM_shareDoc_(MM_docIdFromUrl_(url), task);
    return urls;
  }

  langs.forEach(lang => {
    // 中文版进私人文件夹且不共享;英文版落点见 MM_enFolder_,生成后按策略开放
    const target = lang === 'zh' ? MM_zhFolder_() : folder;
    urls[lang] = MM_docEnsure_(target, base + ' — ' + MM_DOC_SUFFIX[lang], doc => MM_docFill_(doc, task, data, [lang]));
    if (lang === 'en') task.doc_share = MM_shareDoc_(MM_docIdFromUrl_(urls.en), task);
  });
  return urls;
}

/** 中文版专用私人文件夹(仅所有者可见) */
function MM_zhFolder_() {
  return MM_folderByName_(MM_conf_().zhFolder);
}

/**
 * 英文版 / 合并版落点(MM_EN_FOLDER):
 *  ''        → 与中文版同一私人文件夹(默认)
 *  'meeting' → 旧行为:跟随源转录 Doc 所在目录 → Google Meet → 会议纪要
 *  其他      → 该名字的私人文件夹(不存在则创建)
 */
function MM_enFolder_(task) {
  const v = MM_conf_().enFolder;
  if (!v) return MM_zhFolder_();
  if (v.toLowerCase() === 'meeting') return MM_docFolder_(task);
  return MM_folderByName_(v);
}

/** 按名字取 My Drive 下的文件夹,不存在则创建(同名多个时取第一个) */
function MM_folderByName_(name) {
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

function MM_docIdFromUrl_(url) {
  const m = /\/d\/([-\w]+)/.exec(String(url || ''));
  return m ? m[1] : '';
}

// ============================================================
// 共享(Drive REST permissions.create;DriveApp.setSharing 只能覆盖所有者自己的域,跨域需 REST)
// ============================================================

/**
 * 开放英文 Doc。优先级:
 *  1. 命中 PROJECT_SHARE 的项目 → 对项目组成员逐人 reader(不看是否参会),到此为止;
 *  2. 否则先对「MM_SUBSCRIBERS 中且在参会人列表里」的订阅者逐人 reader,
 *  3. 再按 MM_DOC_SHARE(默认 owner)叠加。
 * 幂等:已有同类权限不重复创建。永不发通知邮件,域共享不可搜索。
 * @return {string} 结果摘要,落任务表 doc_share 列,如 "owner" / "subscribers:2+owner" / "domain:example.com"
 */
function MM_shareDoc_(fileId, task) {
  if (!fileId) return '';
  const cfg = MM_conf_();
  try {
    const proj = MM_projectForTask_(task);
    if (proj) {
      const m = MM_projectMembers_(proj);
      const existing = MM_docPermissions_(fileId);
      const n = MM_shareWithUsers_(fileId, m.emails, existing.users, '项目组成员');
      MM_log_('英文 Doc 按项目 ' + proj + ' 共享给 ' + n + '/' + m.emails.length + ' 人(名单来源 ' + m.source + ')');
      return 'project:' + proj + ':' + n + '/' + m.emails.length + ' (' + m.source + ')';
    }

    // 订阅者(按人,只对这场会的参会人生效)
    let prefix = '';
    const subs = MM_subscribersInMeeting_(task);
    if (subs.length) {
      const existing0 = MM_docPermissions_(fileId);
      const n = MM_shareWithUsers_(fileId, subs, existing0.users, '订阅者');
      MM_log_('英文 Doc 共享给订阅者 ' + n + '/' + subs.length + ' 人');
      prefix = 'subscribers:' + n + '+';
    }

    if (cfg.docShare === 'owner') return prefix + 'owner';
    if (cfg.docShare === 'anyone') {
      DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return prefix + 'anyone';
    }
    const existing = MM_docPermissions_(fileId);
    if (cfg.docShare === 'domain' && cfg.shareDomains.length) {
      // 同一 Workspace 组织下的多个域,Drive 会把任何一个域的共享归一为组织主域的一条权限。
      // 因此已存在任何 domain 权限即视为「已对组织开放」。
      if (existing.domains.length) return prefix + 'domain:' + existing.domains.join('|');
      const ok = [], bad = [];
      cfg.shareDomains.forEach(d => {
        const r = MM_docPermissionCreate_(fileId, { type: 'domain', domain: d, role: 'reader', allowFileDiscovery: false });
        if (r.code === 200) {
          const got = String((r.json() || {}).domain || d).toLowerCase();    // 记实际生效的域,而非请求的域
          if (ok.indexOf(got) < 0) ok.push(got);
        } else { bad.push(d + '(' + r.code + ')'); MM_warn_('域共享失败 ' + d + ': HTTP ' + r.code + ' ' + r.text().slice(0, 160)); }
      });
      if (ok.length) return prefix + 'domain:' + ok.join('|') + (bad.length ? ' failed:' + bad.join('|') : '');
      MM_warn_('域共享全部被拒,回退为参会人可查看');
    } else if (cfg.docShare === 'domain') {
      MM_warn_('MM_DOC_SHARE=domain 但 MM_SHARE_DOMAINS 为空,回退为参会人可查看');
    }
    // attendees(显式配置或域共享回退)
    const n = MM_shareWithAttendees_(fileId, task, existing.users);
    return prefix + 'attendees:' + n + (cfg.docShare === 'domain' ? ' (domain fallback)' : '');
  } catch (e) {
    MM_warn_('Doc 共享异常(不阻断流程): ' + e.message);
    return 'ERR ' + String(e.message || e).slice(0, 120);
  }
}

function MM_shareWithAttendees_(fileId, task, alreadyUsers) {
  return MM_shareWithUsers_(fileId, MM_taskAttendees_(task), alreadyUsers, '参会人');
}

/** 任务的参会人邮箱数组(小写;解析失败为空数组) */
function MM_taskAttendees_(task) {
  let list = [];
  try { list = JSON.parse((task && task.attendees) || '[]'); } catch (e) { list = []; }
  return (list || []).map(a => String(a || '').trim().toLowerCase()).filter(Boolean);
}

/**
 * MM_SUBSCRIBERS 里、且出现在这场会参会人列表中的人(不含所有者)。
 * 音频任务没有参会人 → 空。邮件与 Doc 共享都用这一份名单。
 */
function MM_subscribersInMeeting_(task) {
  const subs = MM_conf_().subscribers;
  if (!subs.length || String(task.source) === 'AUDIO') return [];
  const owner = MM_owner_().toLowerCase();
  const att = MM_taskAttendees_(task);
  return subs.filter(s => s !== owner && att.indexOf(s) >= 0);
}

/** 逐人开 reader;已有权限计入成功不重复创建;跳过所有者与非法地址。返回成功人数 */
function MM_shareWithUsers_(fileId, emails, alreadyUsers, label) {
  const owner = MM_owner_().toLowerCase();
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const done = {};
  let n = 0;
  (emails || []).forEach(a => {
    const addr = String(a || '').trim().toLowerCase();
    if (!addr || addr === owner || !re.test(addr) || done[addr]) return;
    done[addr] = 1;
    if (alreadyUsers.indexOf(addr) >= 0) { n++; return; }
    if (MM_outOfBudget_()) { MM_warn_(label + '共享因执行预算中断,剩余下次 resync 补齐'); return; }
    const r = MM_docPermissionCreate_(fileId, { type: 'user', emailAddress: addr, role: 'reader' });
    if (r.code === 200) n++;
    else MM_warn_(label + '共享失败 ' + addr + ': HTTP ' + r.code + ' ' + r.text().slice(0, 120));
  });
  return n;
}

function MM_docPermissions_(fileId) {
  const r = MM_fetchGoogle_('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '/permissions?fields=' + encodeURIComponent('permissions(type,role,domain,emailAddress)') + '&supportsAllDrives=true');
  const out = { domains: [], users: [] };
  if (r.code !== 200) return out;
  (r.json().permissions || []).forEach(p => {
    if (p.type === 'domain' && p.domain) out.domains.push(String(p.domain).toLowerCase());
    if (p.type === 'user' && p.emailAddress) out.users.push(String(p.emailAddress).toLowerCase());
  });
  return out;
}

function MM_docPermissionCreate_(fileId, body) {
  return MM_fetchGoogle_('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '/permissions?sendNotificationEmail=false&supportsAllDrives=true', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(body)
  });
}

/** 目标文件夹:音频任务 → 会议录音/纪要/;会议任务 → 源 Doc 所在夹 → Google Meet 夹 → 默认「会议纪要」 */
function MM_docFolder_(task) {
  if (String(task.source) === 'AUDIO') return MM_audioSub_(MM_CFG.AUDIO_MINUTES_SUB);

  if (String(task.src_kind) === 'DRIVE_DOC' && task.src_ref) {
    try {
      const parents = DriveApp.getFileById(String(task.src_ref)).getParents();
      if (parents.hasNext()) return parents.next();
    } catch (e) { MM_warn_('源 Doc 父目录获取失败,回退默认目录: ' + e.message); }
  }
  const meetFolders = MM_meetFolders_();
  if (meetFolders.length) return meetFolders[0];

  const name = '会议纪要';
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** 文件名主干:「2026-08-20 Product Sync」 */
function MM_docBaseName_(task, data) {
  const d = MM_parseDate_(task.meeting_date) || new Date();
  const title = String(task.title || (data && data.t && (data.t.en || data.t.zh)) || 'Meeting');
  return MM_fmtDate_(d, 'yyyy-MM-dd') + ' ' + MM_safeName_(title);
}

/**
 * 幂等创建:目标文件夹内已存在同名 Doc 则直接复用其 URL,不重复生成(C13)。
 * 这样 RENDER_DOC 失败重试不会产生重复文档。
 */
function MM_docEnsure_(folder, name, fillFn) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();
    MM_log_('复用已存在的 Doc: ' + name);
    return f.getUrl();
  }
  const doc = DocumentApp.create(name);
  try {
    fillFn(doc);
    doc.saveAndClose();
    const file = DriveApp.getFileById(doc.getId());
    file.moveTo(folder);                 // create 默认落在 My Drive 根目录,需移动
    return file.getUrl();
  } catch (e) {
    // 填充失败就把半成品删掉,避免下次查重命中空壳文档
    try { DriveApp.getFileById(doc.getId()).setTrashed(true); } catch (ignored) {}
    throw e;
  }
}

// ============================================================
// 正文填充
// ============================================================

function MM_docFill_(doc, task, data, langs) {
  const body = doc.getBody();
  body.clear();

  const dateStr = MM_fmtDate_(MM_parseDate_(task.meeting_date) || new Date(), 'yyyy-MM-dd');
  const titleText = langs.length === 2
    ? (data.t.zh || '') + (data.t.zh && data.t.en ? ' / ' : '') + (data.t.en || '')
    : (data.t[langs[0]] || task.title || '');

  body.appendParagraph(titleText || String(task.title || '')).setHeading(DocumentApp.ParagraphHeading.TITLE);
  body.appendParagraph(dateStr + '  ·  ' + MM_srcLabel_(task.src_kind))
    .setHeading(DocumentApp.ParagraphHeading.SUBTITLE);

  langs.forEach((lang, idx) => {
    if (idx > 0) body.appendPageBreak();
    MM_docSection_(body, data, lang);
  });

  body.appendParagraph('');
  body.appendParagraph('由「会议双语纪要系统」自动生成 · 内容经 AI 抽取,请以会议原文为准')
    .setFontSize(8).setForegroundColor('#999999');
}

function MM_docSection_(body, data, lang) {
  const L = MM_DOC_L[lang];
  const pick = x => String((x && x[lang]) || '');

  // ---- 摘要 ----
  body.appendParagraph(L.summary).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph(pick(data.s) || L.none);

  // ---- 决策项(状态文案由 MM_CFG.DECISION_LABEL 映射,不让模型输出)----
  body.appendParagraph(L.decisions).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  if (!data.d.length) {
    body.appendParagraph(L.none);
  } else {
    data.d.forEach(x => {
      const tag = (MM_CFG.DECISION_LABEL[x.k] || MM_CFG.DECISION_LABEL[1])[lang];
      body.appendListItem('[' + tag + '] ' + pick(x)).setGlyphType(DocumentApp.GlyphType.BULLET);
    });
  }

  // ---- 行动项(表格:任务 / 负责人 / 截止)----
  body.appendParagraph(L.actions).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  if (!data.a.length) {
    body.appendParagraph(L.none);
  } else {
    const rows = [[L.task, L.owner, L.due]];
    data.a.forEach(x => rows.push([pick(x), x.o || '-', x.u || '-']));
    const table = body.appendTable(rows);
    table.getRow(0).editAsText().setBold(true);
  }

  // ---- 议题详情 ----
  body.appendParagraph(L.topics).setHeading(DocumentApp.ParagraphHeading.HEADING1);
  if (!data.p.length) {
    body.appendParagraph(L.none);
  } else {
    data.p.forEach(x => body.appendListItem(pick(x)).setGlyphType(DocumentApp.GlyphType.BULLET));
  }

  // ---- 术语对照表(可选)----
  if (data.g && data.g.length) {
    body.appendParagraph(L.glossary).setHeading(DocumentApp.ParagraphHeading.HEADING1);
    const rows = [[L.term, L.trans]];
    data.g.forEach(x => rows.push([x.e, x.z]));
    const table = body.appendTable(rows);
    table.getRow(0).editAsText().setBold(true);
  }
}

function MM_srcLabel_(kind) {
  return { MEET_API: 'Meet 转录', DRIVE_DOC: 'Drive 转录文档', AUDIO: '音频识别' }[String(kind)] || String(kind || '');
}
