/**
 * MM_remote.js — 远程执行入口(Web App)
 * 职责:让运维端(clasp/curl)无需 GCP 项目也能触发白名单内的 MM 函数并取回返回值与日志。
 *      背景:scripts.run 要求 OAuth 客户端与脚本同属一个 GCP 项目,而本账号无权创建 GCP 项目。
 * 依赖:MM_config.js(MM_LOGBUF_)
 *
 * 安全模型(双层):
 *  - 部署为 executeAs=USER_DEPLOYING / access=MYSELF:调用方必须持有脚本所有者本人的 OAuth 令牌
 *    (域策略禁止 ANYONE 访问);
 *  - 此外每次请求必须在 POST body 里携带 key,与脚本属性 MM_REMOTE_KEY 比对(常量时间比较);
 *  - 属性缺失即整体禁用 —— 删掉 MM_REMOTE_KEY 就是关闭远程入口;
 *  - 只允许调用 MM_REMOTE_ALLOW 里列出的函数名,参数为 JSON 数组。
 */

const MM_REMOTE_ALLOW = [
  'MM_authCheck', 'MM_geminiDiag', 'MM_probe', 'MM_status', 'MM_openSheet', 'MM_calDump', 'MM_taskDump', 'MM_membersDump',
  'MM_actionsDump', 'MM_actionSetStatus', 'MM_propsGet', 'MM_propsSet', 'MM_urlsDump', 'MM_previewMail', 'MM_previewDigest',
  'MM_setupOnce', 'MM_adhocDriveDoc', 'MM_retryTask', 'MM_resyncTask',
  'MM_workerEvery15Min', 'MM_plannerDaily'
];

function doPost(e) {
  const t0 = Date.now();
  MM_LOGBUF_ = [];
  let req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return MM_remoteOut_({ ok: false, error: 'body 不是合法 JSON' }); }

  const expect = PropertiesService.getScriptProperties().getProperty('MM_REMOTE_KEY') || '';
  if (!expect) return MM_remoteOut_({ ok: false, error: '远程入口未启用(脚本属性 MM_REMOTE_KEY 缺失)' });
  if (!MM_remoteKeyOk_(String(req.key || ''), expect)) return MM_remoteOut_({ ok: false, error: 'key 校验失败' });

  const fn = String(req.fn || '');
  if (MM_REMOTE_ALLOW.indexOf(fn) < 0) return MM_remoteOut_({ ok: false, error: '函数不在白名单: ' + fn });
  const impl = globalThis[fn];
  if (typeof impl !== 'function') return MM_remoteOut_({ ok: false, error: '函数不存在: ' + fn });

  try {
    const result = impl.apply(null, Array.isArray(req.args) ? req.args : []);
    return MM_remoteOut_({ ok: true, fn: fn, result: MM_remoteSafe_(result), logs: MM_LOGBUF_, ms: Date.now() - t0 });
  } catch (err) {
    return MM_remoteOut_({ ok: false, fn: fn, error: String((err && err.message) || err), stack: String((err && err.stack) || ''), logs: MM_LOGBUF_, ms: Date.now() - t0 });
  } finally {
    MM_LOGBUF_ = null;
  }
}

function doGet() {
  return MM_remoteOut_({ ok: false, error: '仅接受 POST' });
}

/**
 * 远程读脚本属性(值脱敏:含 KEY / TOKEN / SECRET 的键只显示长度)。
 * 回答「现在线上到底配了什么」,避免在编辑器里翻。
 */
function MM_propsGet() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const out = {};
  Object.keys(all).sort().forEach(k => {
    out[k] = MM_propSecret_(k) ? '<' + String(all[k]).length + ' chars>' : all[k];
  });
  return out;
}

/**
 * 远程写脚本属性:obj = { KEY: value, ... };value 为 null / '' 表示删除该属性。
 * 拒绝任何含 KEY / TOKEN / SECRET 的键(密钥只能在编辑器里手工填),拒绝 MM_SHEET_ID(误改等于丢表)。
 * @return {{set:string[], deleted:string[]}}
 */
function MM_propsSet(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw MM_fatal_('参数必须是 {KEY: value} 对象');
  const p = PropertiesService.getScriptProperties();
  const set = [], deleted = [];
  Object.keys(obj).forEach(k => {
    const key = String(k).trim();
    if (!key) return;
    if (MM_propSecret_(key) || key === MM_CFG.P_SHEET_ID) throw MM_fatal_('拒绝远程修改敏感属性: ' + key);
    const v = obj[k];
    if (v === null || v === undefined || String(v) === '') { p.deleteProperty(key); deleted.push(key); }
    else { p.setProperty(key, String(v)); set.push(key); }
  });
  MM_resetCache_();
  MM_log_('脚本属性已更新: set=' + set.join(',') + ' deleted=' + deleted.join(','));
  return { set: set, deleted: deleted };
}

function MM_propSecret_(key) {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(String(key));
}

/** 常量时间比较,避免时序侧信道 */
function MM_remoteKeyOk_(given, expect) {
  if (given.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= given.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

/** 返回值瘦身:去掉内部行号等私有字段,保证可 JSON 序列化 */
function MM_remoteSafe_(v) {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v, (k, val) => (k && k.charAt(0) === '_') ? undefined : val));
  } catch (e) {
    return String(v);
  }
}

function MM_remoteOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
