/**
 * MM_source_audio.js — 数据源 3(SRC_AUDIO):音频文件夹入口 + Gemini File API
 * 职责:扫描 Drive/会议录音、体积与时长熔断、resumable 上传、ACTIVE 轮询、终态删除(C15)、归档移动
 * 依赖:MM_config.js、MM_store.js
 * 被谁调用:MM_main.js 的音频扫描步骤与 AUDIO_PENDING / AUDIO_PROCESSING / 终态清理
 *
 * ⚠️ 外部 API 不确定性:Gemini File API 的 resumable 上传协议依赖三个自定义请求头
 * (X-Goog-Upload-Protocol / -Command / -Header-Content-Length)与响应头 x-goog-upload-url。
 * 该协议未在 Apps Script 环境实测过,若上传起步返回 200 但取不到 upload url,
 * 本文件会抛出可读错误而非静默失败,便于按真实响应调整。
 */

// ============================================================
// Drive 文件夹
// ============================================================

/** 音频根文件夹(不存在则创建) */
function MM_audioRoot_() {
  const name = MM_conf_().audioFolder;
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}

/** 子文件夹(已处理 / 纪要) */
function MM_audioSub_(sub) {
  const root = MM_audioRoot_();
  const it = root.getFoldersByName(sub);
  return it.hasNext() ? it.next() : root.createFolder(sub);
}

/** 判定是否音频文件(MIME 优先,扩展名兜底) */
function MM_isAudioFile_(file) {
  const mime = String(file.getMimeType() || '').toLowerCase();
  for (let i = 0; i < MM_CFG.AUDIO_MIME_PREFIXES.length; i++) {
    if (mime.indexOf(MM_CFG.AUDIO_MIME_PREFIXES[i]) === 0) return true;
  }
  const ext = (String(file.getName()).split('.').pop() || '').toLowerCase();
  return MM_CFG.AUDIO_EXT.indexOf(ext) >= 0;
}

/**
 * 扫描音频根目录的直接子文件(已处理/纪要在子文件夹里,天然被排除)。
 * @return {Array<{fileId,name,bytes,created,mime}>}
 */
function MM_audioScan_(limit) {
  const out = [];
  const it = MM_audioRoot_().getFiles();
  const cap = limit || 20;
  while (it.hasNext() && out.length < cap && !MM_outOfBudget_()) {
    const f = it.next();
    if (!MM_isAudioFile_(f)) continue;
    out.push({
      fileId: f.getId(),
      name: f.getName(),
      bytes: f.getSize(),
      created: f.getDateCreated(),
      mime: f.getMimeType()
    });
  }
  return out;
}

/** 处理成功后归档到「已处理/」 */
function MM_audioArchive_(fileId) {
  try {
    DriveApp.getFileById(fileId).moveTo(MM_audioSub_(MM_CFG.AUDIO_DONE_SUB));
    return true;
  } catch (e) {
    MM_warn_('音频归档失败(不影响结果) ' + fileId + ': ' + e.message);
    return false;
  }
}

// ============================================================
// 熔断校验(C6)
// ============================================================

/**
 * 体积与预估 token 校验。不通过时抛致命错误(直接 FAILED + 告警附 ffmpeg 命令)。
 * @return {{seconds:number, tokens:number}}
 */
function MM_audioGuard_(bytes, name) {
  if (bytes > MM_CFG.AUDIO_MAX_BYTES) {
    throw MM_fatal_('音频 ' + name + ' 体积 ' + (bytes / 1048576).toFixed(1) +
      ' MB 超过 50 MB 上限。' + MM_FFMPEG_HINT);
  }
  const seconds = MM_estimateAudioSeconds_(bytes);
  const tokens = MM_estimateAudioTokens_(seconds);
  if (tokens > MM_CFG.MAX_INPUT_TOKENS) {
    throw MM_fatal_('音频 ' + name + ' 预估 ' + Math.round(seconds / 60) + ' 分钟 / ' +
      tokens + ' token,超过 ' + MM_CFG.MAX_INPUT_TOKENS + ' 上限(约 2.2 小时)。' +
      '音频不做分段处理,请拆分成多段后分别放入音频文件夹。' + MM_FFMPEG_HINT);
  }
  return { seconds: seconds, tokens: tokens };
}

const MM_FFMPEG_HINT = '\n本地转码命令:\nffmpeg -i meeting.mp4 -vn -ac 1 -ar 16000 -c:a aac -b:a 32k meeting.m4a';

// ============================================================
// Gemini File API
// ============================================================

/**
 * resumable 上传(昂贵步骤,AUDIO_PENDING 调用)。
 * @return {{name:string, uri:string, state:string, mime:string}}
 */
function MM_geminiUpload_(driveFileId) {
  const file = DriveApp.getFileById(driveFileId);
  const bytes = file.getSize();
  const name = file.getName();
  MM_audioGuard_(bytes, name);

  const blob = file.getBlob();
  const mime = blob.getContentType() || 'audio/mp4';

  // --- 步骤 1:起步请求,拿 upload url ---
  const start = MM_fetchGemini_(MM_CFG.GLA_UPLOAD + '/files', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes),
      'X-Goog-Upload-Header-Content-Type': mime
    },
    payload: JSON.stringify({ file: { display_name: name } })
  });
  if (start.code !== 200) MM_throwHttp_('File API start', start.code, start.text());

  const uploadUrl = start.headers['x-goog-upload-url'];
  if (!uploadUrl) {
    throw MM_fatal_('File API 起步成功但未返回 x-goog-upload-url,响应头: ' +
      JSON.stringify(start.headers).slice(0, 400));
  }

  // --- 步骤 2:一次性上传并 finalize(≤50 MB,不做分片)---
  const up = MM_fetchGemini_(uploadUrl, {
    method: 'post',
    contentType: mime,
    headers: {
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    payload: blob.getBytes()
  });
  if (up.code !== 200) MM_throwHttp_('File API upload', up.code, up.text());

  const f = (up.json() || {}).file;
  if (!f || !f.name) throw MM_fatal_('File API 上传返回体缺少 file.name: ' + up.text().slice(0, 300));

  MM_log_('音频已上传 Gemini: ' + f.name + ' state=' + f.state);
  return { name: f.name, uri: f.uri || '', state: f.state || 'PROCESSING', mime: mime };
}

/**
 * 查询文件状态(廉价步骤,AUDIO_PROCESSING 调用)。
 * @return {{state:string, uri:string, mime:string}}
 */
function MM_geminiFileState_(fileName) {
  const r = MM_fetchGemini_(MM_CFG.GLA + '/' + fileName);
  if (r.code !== 200) MM_throwHttp_('File API get', r.code, r.text());
  const f = r.json();
  if (String(f.state) === 'FAILED') {
    throw MM_fatal_('Gemini 侧音频处理失败: ' + JSON.stringify(f.error || {}).slice(0, 300));
  }
  return { state: String(f.state || ''), uri: f.uri || '', mime: f.mimeType || '' };
}

/** 删除 File API 上的音频(C15:任务到达终态后立即调用,失败只告警不阻断) */
function MM_geminiFileDelete_(fileName) {
  if (!fileName) return;
  try {
    const r = MM_fetchGemini_(MM_CFG.GLA + '/' + fileName, { method: 'delete' });
    if (r.code === 200 || r.code === 404) {
      MM_log_('已删除 Gemini 音频: ' + fileName);
    } else {
      MM_warn_('删除 Gemini 音频失败 HTTP ' + r.code + ': ' + fileName);
    }
  } catch (e) {
    MM_warn_('删除 Gemini 音频异常: ' + e.message);
  }
}
