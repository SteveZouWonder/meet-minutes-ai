/**
 * MM_members.js — 按项目共享:会议 → 项目判定、项目组成员名单(Jira)
 * 职责:回答两个问题 ①这场会属于哪个项目 ②该项目组有哪些人(邮箱)
 * 依赖:MM_config.js(MM_CFG.PROJECT_SHARE / MEMBER_DOMAINS)、MM_render_jira.js(MM_jiraKeys_ / MM_jiraFetch_)
 * 被谁调用:MM_render_doc.js 的 MM_shareDoc_、MM_setup.js 的诊断函数
 *
 * 成员来源(2026-09-18 定案):Jira 项目角色 API 对本账号 403,改用「最近 N 天该项目 issue 的
 * assignee / reporter」近似项目组;结果缓存在脚本属性 MM_MEMBERS_CACHE_<KEY>(24h),
 * Jira 不可用时退回旧缓存。MM_MEMBERS_<KEY> 设了固定名单则完全不查 Jira。
 */

/**
 * 判定会议所属项目。规则顺序:标题票号前缀 → keywords 正则(不区分大小写)。
 * @return {string} 项目 key(如 'PROJ'),未命中返回 ''
 */
function MM_projectForTask_(task) {
  const rules = MM_conf_().projectShare || {};
  const keys = Object.keys(rules);
  if (!keys.length) return '';
  const title = String((task && task.title) || '');

  const tickets = MM_jiraKeys_(title);
  for (let i = 0; i < tickets.length; i++) {
    const p = tickets[i].split('-')[0];
    if (rules[p]) return p;
  }
  for (let i = 0; i < keys.length; i++) {
    const kws = (rules[keys[i]] && rules[keys[i]].keywords) || [];
    for (let j = 0; j < kws.length; j++) {
      try { if (new RegExp(kws[j], 'i').test(title)) return keys[i]; }
      catch (e) { MM_warn_('PROJECT_SHARE.' + keys[i] + ' 关键词正则非法,已忽略: ' + kws[j]); }
    }
  }
  return '';
}

/**
 * 项目组成员邮箱(小写、去重、已过域白名单、不含所有者)。
 * @param {string} key 项目 key
 * @param {boolean} [force] 忽略缓存重新查 Jira
 * @return {{emails:string[], source:string}} source: fixed | jira | cache | cache-stale
 */
function MM_projectMembers_(key, force) {
  const cfg = MM_conf_();
  const rule = (cfg.projectShare || {})[key];
  if (!rule) return { emails: [], source: 'no-rule' };

  const fixed = MM_emailList_(MM_prop_('MM_MEMBERS_' + key, ''));
  let emails, source;
  if (fixed.length) {
    emails = fixed; source = 'fixed';
  } else {
    const r = MM_membersFromJiraCached_(key, Number(rule.jiraDays) || 120, !!force);
    emails = r.emails; source = r.source;
  }

  const extra = MM_emailList_(MM_prop_('MM_MEMBERS_EXTRA_' + key, ''));
  const exclude = MM_emailList_(MM_prop_('MM_MEMBERS_EXCLUDE_' + key, ''));
  const owner = MM_owner_().toLowerCase();
  const out = [];
  emails.concat(extra).forEach(e => {
    if (!e || e === owner || exclude.indexOf(e) >= 0 || out.indexOf(e) >= 0) return;
    if (!MM_memberDomainOk_(e, cfg.memberDomains)) { MM_warn_('成员邮箱不在域白名单,跳过: ' + e); return; }
    out.push(e);
  });
  return { emails: out, source: source };
}

/** 带缓存的 Jira 查询;Jira 失败时退回旧缓存(有则用,无则抛) */
function MM_membersFromJiraCached_(key, days, force) {
  const propKey = 'MM_MEMBERS_CACHE_' + key;
  const props = PropertiesService.getScriptProperties();
  let cached = null;
  try { cached = JSON.parse(props.getProperty(propKey) || 'null'); } catch (e) { cached = null; }
  const ttl = MM_CFG.MEMBERS_CACHE_HOURS * 3600000;
  if (!force && cached && cached.at && (Date.now() - cached.at) < ttl && Array.isArray(cached.emails)) {
    return { emails: cached.emails, source: 'cache' };
  }
  try {
    const emails = MM_membersFromJira_(key, days);
    props.setProperty(propKey, JSON.stringify({ at: Date.now(), days: days, emails: emails }));
    return { emails: emails, source: 'jira' };
  } catch (e) {
    if (cached && Array.isArray(cached.emails)) {
      MM_warn_('Jira 成员查询失败,使用旧缓存(' + MM_iso_(new Date(cached.at)) + '): ' + e.message);
      return { emails: cached.emails, source: 'cache-stale' };
    }
    throw e;
  }
}

/**
 * GET /rest/api/3/search/jql 分页收集 assignee / reporter 邮箱。
 * 只取 accountType=atlassian 的真人账号(排除 app / customer);受执行预算约束,最多 30 页(3000 张票)。
 */
function MM_membersFromJira_(key, days) {
  const jql = 'project = ' + key + ' AND updated >= -' + days + 'd';
  const seen = {};
  let token = '', pages = 0;
  do {
    const q = '/rest/api/3/search/jql?jql=' + encodeURIComponent(jql) + '&fields=assignee,reporter&maxResults=100'
      + (token ? '&nextPageToken=' + encodeURIComponent(token) : '');
    const r = MM_jiraFetch_(q, 'get');
    if (r.code !== 200) MM_throwHttp_('Jira search ' + key, r.code, r.text());
    const d = r.json();
    (d.issues || []).forEach(it => {
      ['assignee', 'reporter'].forEach(f => {
        const u = it.fields && it.fields[f];
        if (u && u.accountType === 'atlassian' && u.emailAddress) seen[String(u.emailAddress).toLowerCase()] = 1;
      });
    });
    token = d.nextPageToken || '';
    pages++;
  } while (token && pages < 30 && !MM_outOfBudget_());
  if (token) MM_warn_('Jira 成员查询未翻完(' + pages + ' 页),名单可能不全');
  const emails = Object.keys(seen).sort();
  MM_log_('Jira 项目 ' + key + ' 最近 ' + days + ' 天活跃成员 ' + emails.length + ' 人(' + pages + ' 页)');
  return emails;
}

/** 逗号/分号/空白分隔的邮箱串 → 小写数组 */
function MM_emailList_(s) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return String(s || '').split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(x => x && re.test(x));
}

function MM_memberDomainOk_(email, domains) {
  if (!domains || !domains.length) return true;
  const d = String(email).split('@')[1] || '';
  return domains.indexOf(d) >= 0;
}
