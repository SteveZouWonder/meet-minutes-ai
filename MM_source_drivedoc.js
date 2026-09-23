/**
 * MM_source_drivedoc.js — 数据源 2(SRC_DRIVE_DOC):Drive 中的 Meet 转录/纪要 Doc 兜底
 * 职责:在 Google Meet / Meet Recordings 文件夹里按标题+时间窗定位转录 Doc,读出纯文本
 * 依赖:MM_config.js
 * 被谁调用:MM_main.js 的 NEW / TEXT_READY 状态处理(Meet REST 失败后的降级路径)
 *
 * 命名规律:Meet 生成的转录 Doc 通常叫「<会议标题> - Transcript」或「<会议标题>(转写)」,
 * 但不同版本/语言环境命名不一致,因此匹配策略是「标题关键词 + 创建时间窗」双重条件,宁缺毋滥。
 */

/**
 * 探测 Drive 兜底 Doc(廉价步骤,NEW 状态调用)。
 * @return {?{fileId:string, fileName:string}}
 */
function MM_driveDocProbe_(task) {
  const folders = MM_meetFolders_();
  if (!folders.length) return null;

  const end = MM_parseDate_(task.event_end) || new Date();
  const lo = new Date(end.getTime() - 6 * 3600000);       // 转录文件的创建时间不早于会议开始
  const hi = new Date(end.getTime() + MM_conf_().pollHours * 3600000 + 3600000);
  const keys = MM_titleKeywords_(task.title);

  let best = null, bestScore = -1, bestTime = 0;
  const scan = it => {
    let scanned = 0;
    while (it.hasNext() && scanned < 300 && !MM_outOfBudget_()) {
      const f = it.next();
      scanned++;
      const created = f.getDateCreated();
      if (created < lo || created > hi) continue;
      if (!MM_nameMatches_(f.getName(), keys)) continue;
      // 同一场会可能同时有「转录」「Gemini 笔记」「录制」多个文件:逐字转录优先,其次取最新
      const score = MM_docKindScore_(f.getName());
      if (score > bestScore || (score === bestScore && created.getTime() > bestTime)) {
        bestScore = score; bestTime = created.getTime(); best = f;
      }
    }
  };

  folders.forEach(folder => {
    scan(folder.getFiles());                                  // 我组织的会议:产物直接落在顶层
    // 他人组织的会议:Drive 只给一个「<会议名>」子文件夹,里面放指向组织者文件的快捷方式
    const subs = folder.getFolders();
    let n = 0;
    while (subs.hasNext() && n < 100 && !MM_outOfBudget_()) {
      const sub = subs.next();
      n++;
      const c = sub.getDateCreated();
      if (c < lo || c > hi) continue;                         // 子夹创建时间与会议同期才值得进去扫
      scan(sub.getFiles());
    }
  });

  return best ? { fileId: best.getId(), fileName: best.getName() } : null;
}

/** 文件名 → 数据源优先级:逐字转录 2 > Gemini 摘要笔记 1 > 其他(录制等)0 */
function MM_docKindScore_(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (/transcript|转录|转写|字幕/.test(n)) return 2;
  if (/notes by gemini|gemini/.test(n)) return 1;
  return 0;
}

/** 取 Meet 产物文件夹(可能一个都没有,说明账号从未产生过转录) */
function MM_meetFolders_() {
  const out = [];
  MM_CFG.MEET_FOLDERS.forEach(name => {
    const it = DriveApp.getFoldersByName(name);
    while (it.hasNext()) out.push(it.next());
  });
  return out;
}

/**
 * 标题关键词提取:去掉过短词与常见噪声词,保留有辨识度的片段。
 * 返回空数组时表示标题无可用特征,此时只靠时间窗匹配(风险较高,故要求至少 1 个关键词)。
 */
function MM_titleKeywords_(title) {
  const raw = String(title || '').toLowerCase();
  const stop = ['meeting', 'sync', 'call', 'weekly', 'daily', 'review', '会议', '例会', '周会', '同步'];
  const parts = raw.split(/[\s\-_/|(),.:：、（）]+/).filter(Boolean);
  const keys = parts.filter(p => p.length >= 2 && stop.indexOf(p) < 0);
  // 全是停用词时退而求其次,用原始词(总比无条件匹配安全)
  return keys.length ? keys : parts.filter(p => p.length >= 2);
}

/** 文件名是否命中任一关键词 */
function MM_nameMatches_(fileName, keys) {
  if (!keys.length) return false;
  const n = String(fileName || '').toLowerCase();
  for (let i = 0; i < keys.length; i++) if (n.indexOf(keys[i]) >= 0) return true;
  return false;
}

/**
 * 读出 Doc 正文(TEXT_READY 状态调用)。
 * 支持 Google Doc 与纯文本文件两种形态。
 */
function MM_driveDocText_(fileId) {
  const file = MM_resolveShortcut_(DriveApp.getFileById(fileId));
  const mime = file.getMimeType();
  let text;
  if (mime === MimeType.GOOGLE_DOCS) {
    text = MM_driveExportText_(file.getId());
  } else if (String(mime).indexOf('text/') === 0) {
    text = file.getBlob().getDataAsString();
  } else {
    throw MM_fatal_('不支持的转录文件类型: ' + mime + ' (' + file.getName() + ')');
  }
  const compact = MM_compactPlainText_(text);
  if (compact.length < 200) throw MM_fatal_('转录 Doc 内容过短(' + compact.length + ' 字符),疑似空文件');
  return compact;
}

/**
 * Google Doc → 纯文本。
 * 首选 Drive REST export(只依赖 drive scope;getAs() 对 Docs 仅支持转 PDF,不能用),
 * 失败再退回 DocumentApp(需要 documents scope)。
 */
function MM_driveExportText_(docId) {
  const r = MM_fetchGoogle_('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(docId) +
    '/export?mimeType=' + encodeURIComponent('text/plain') + '&supportsAllDrives=true');
  if (r.code === 200) return r.text();
  MM_warn_('Drive export HTTP ' + r.code + ',退回 DocumentApp: ' + r.text().slice(0, 200));
  if (MM_codeRetryable_(r.code)) throw MM_retryable_('Drive export HTTP ' + r.code);
  return DocumentApp.openById(docId).getBody().getText();
}

/**
 * Drive 快捷方式 → 目标文件。
 * 他人组织的会议,Meet/Gemini 产物落在组织者的 Drive,我方 Google Meet 文件夹里只有一个快捷方式;
 * 直接对快捷方式取 mime 会得到 application/vnd.google-apps.shortcut,必须先解析。
 * 非快捷方式原样返回。
 */
function MM_resolveShortcut_(file) {
  if (String(file.getMimeType()) !== 'application/vnd.google-apps.shortcut') return file;
  const targetId = file.getTargetId();
  if (!targetId) throw MM_fatal_('快捷方式无目标: ' + file.getName());
  return DriveApp.getFileById(targetId);
}
