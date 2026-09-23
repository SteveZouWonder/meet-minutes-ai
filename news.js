// ===== 配置 =====
const CFG = {
  QUERY: '(stock market OR business OR finance) NOT (promo OR coupon OR gift OR deal OR "sponsored post")',
  DISPLAY_COUNT: 10,
  ANALYSIS_COUNT: 100,          // 免费版单页上限 100,加大候选池以防过滤后凑不够
  DEDUP_KEEP_DAYS: 3,
  DEDUP_PROP_KEY: 'SENT_URLS',  // 单个 JSON 属性存 {url: timestamp},避免属性数量无限增长
  RECIPIENTS_PROP_KEY: 'RECIPIENTS', // 脚本属性:逗号分隔的收件人列表;未配置时只发自己
  BLACKLIST_TEXT: ['gift guide', 'discount', 'promo', 'coupon', 'exclusive deal', 'giveaway', 'save $', 'bogo', 'shop now', 'free shipping', 'sponsored'],
  BLACKLIST_SOURCES: ['youtube', 'daily mail', 'the sun', 'blogger', 'pr newswire', 'bizjournals']
};

// ===== 入口 =====
function sendEnglishPrimaryBilingualReport() {
  const owner = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
  try {
    if (!owner) throw new Error('No owner email available.');
    const recipients = getRecipients_(owner);

    const allArticles = fetchArticles_();
    const now = new Date();
    const theme = getDailyTheme(now.getDay());
    const dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'EEEE, MMMM d, yyyy');

    const sentMap = loadSentMap_();
    const picked = pickArticles_(allArticles, sentMap);

    if (picked.length === 0) {
      // 仅通知脚本所有者,不打扰订阅者
      MailApp.sendEmail(owner, '[Market Report] No fresh articles today', 'All fetched articles were filtered or already sent. Script ran normally.');
      return;
    }

    const ai = analyzeWithAI_(allArticles);                       // AI 优先
    const sectorReport = ai ? mapAiSectors_(ai) : performBilingualSectorAnalysis(allArticles); // 失败降级词袋
    const html = buildReportHtml_(theme, dateStr, picked, sectorReport, allArticles.length, ai);

    // to 填所有者,其余收件人走 BCC:订阅者之间互不可见对方邮箱
    MailApp.sendEmail({
      to: owner,
      bcc: recipients.filter(r => r !== owner).join(','),
      subject: `[${theme.dayLabel}]${ai ? ' [AI]' : ''} Market Report - ${Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd')}`,
      htmlBody: html
    });

    // 发送成功后才批量写入去重记录
    picked.forEach(p => { sentMap[p.dedupKey] = Date.now(); });
    saveSentMap_(sentMap);
    console.log('Report sent to ' + recipients.length + ' recipient(s).');
  } catch (e) {
    console.error('Execution Error: ' + e.toString());
    if (owner) {
      try { MailApp.sendEmail(owner, '[Market Report] Script FAILED', String(e && e.stack || e)); } catch (ignored) {}
    }
    throw e; // rethrow 让触发器失败通知生效
  }
}

/**
 * 读取收件人列表(脚本属性 RECIPIENTS,支持逗号/分号/换行分隔)。
 * 未配置时默认只发所有者;非法邮箱跳过并记日志;自动去重。
 */
function getRecipients_(owner) {
  const raw = PropertiesService.getScriptProperties().getProperty(CFG.RECIPIENTS_PROP_KEY) || '';
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const valid = [];
  for (const addr of raw.split(/[,;\n]/).map(s => s.trim()).filter(Boolean)) {
    if (!emailRe.test(addr)) {
      console.warn('Invalid recipient skipped: ' + addr);
    } else if (!valid.includes(addr)) {
      valid.push(addr);
    }
  }
  if (!valid.includes(owner)) valid.unshift(owner); // 所有者始终收到一份
  return valid;
}

// ===== 取数 =====
function fetchArticles_() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('NEWS_API_KEY');
  if (!apiKey) throw new Error('NEWS_API_KEY not set. Add it under Project Settings → Script properties.');

  // from=昨天,避免 sortBy=popularity 捞出多天前的旧闻(注:免费版本身有约24h延迟)
  const from = Utilities.formatDate(new Date(Date.now() - 24 * 3600 * 1000), 'UTC', 'yyyy-MM-dd');
  const url = 'https://newsapi.org/v2/everything?q=' + encodeURIComponent(CFG.QUERY)
    + '&language=en&sortBy=popularity&from=' + from
    + '&pageSize=' + CFG.ANALYSIS_COUNT + '&apiKey=' + apiKey;

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = response.getResponseCode();
  if (code !== 200) throw new Error('NewsAPI HTTP ' + code + ': ' + response.getContentText().slice(0, 300));

  const json = JSON.parse(response.getContentText());
  if (json.status !== 'ok') throw new Error('NewsAPI error: ' + (json.message || 'unknown'));
  return (json.articles || []).filter(a => a && a.title && a.title !== '[Removed]');
}

// ===== 过滤 + 去重 + 翻译,凑够 DISPLAY_COUNT 即停 =====
function pickArticles_(articles, sentMap) {
  const picked = [];
  for (const item of articles) {
    if (picked.length >= CFG.DISPLAY_COUNT) break;
    if (isSpamOrUseless_(item)) continue;
    if (!/^https?:\/\//i.test(item.url || '')) continue;

    const dedupKey = stripUrl_(item.url);
    if (sentMap[dedupKey]) continue;
    if (picked.some(p => p.dedupKey === dedupKey)) continue;

    const enTitle = item.title;
    const enDesc = item.description || 'No summary available.';
    picked.push({
      dedupKey,
      url: item.url,
      enTitle,
      enDesc,
      zhTitle: translateSafe_(enTitle),
      zhDesc: translateSafe_(enDesc)
    });
  }
  return picked;
}

function isSpamOrUseless_(item) {
  const title = (item.title || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  const source = ((item.source && item.source.name) || '').toLowerCase();

  if (title.length < 15 || desc.length < 20 || desc === '[removed]') return true;
  if (CFG.BLACKLIST_SOURCES.some(s => source.includes(s))) return true; // 媒体源黑名单匹配 source 而非正文
  const text = title + ' ' + desc;
  return CFG.BLACKLIST_TEXT.some(w => text.includes(w));
}

/** 翻译失败时降级为空串(邮件仍发,仅缺中文),不中断整封邮件 */
function translateSafe_(text) {
  try {
    return LanguageApp.translate(text, 'en', 'zh');
  } catch (e) {
    console.warn('Translate failed: ' + e.message);
    return '';
  }
}

/** 剥离 query/hash,避免 UTM 参数导致同文重复推送 */
function stripUrl_(url) {
  return String(url).split(/[?#]/)[0];
}

// ===== 去重存储(单属性 JSON + 过期清理)=====
function loadSentMap_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CFG.DEDUP_PROP_KEY);
  const map = raw ? JSON.parse(raw) : {};
  const cutoff = Date.now() - CFG.DEDUP_KEEP_DAYS * 24 * 3600 * 1000;
  for (const key of Object.keys(map)) {
    if (map[key] < cutoff) delete map[key]; // 清理超过 3 天的记录,容量恒定不膨胀
  }
  return map;
}

function saveSentMap_(map) {
  PropertiesService.getScriptProperties().setProperty(CFG.DEDUP_PROP_KEY, JSON.stringify(map));
}

// ===== HTML 渲染(全部内联样式,兼容剥离 <style> 的客户端;escapeHtml_ / getDailyTheme 在 MM_util.js)=====
function mapAiSectors_(ai) {
  const colors = { BULLISH: '#b45309', BEARISH: '#991b1b', NEUTRAL: '#78716c' };
  const zhNames = { Technology: '科技板块', Finance: '金融板块', Energy: '能源板块' };
  const zhTrends = { BULLISH: '看涨', BEARISH: '看跌', NEUTRAL: '中性' };
  return (ai.sectors || []).map(s => ({
    nameEn: s.name, nameZh: zhNames[s.name] || s.name,
    trendEn: s.trend, trendZh: zhTrends[s.trend] || s.trend,
    color: colors[s.trend] || '#78716c',
    insightEn: s.reason_en, insightZh: s.reason_zh,
    matched: '-', score: 'AI'
  }));
}

function buildReportHtml_(theme, dateStr, picked, sectorReport, poolSize, ai) {
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family: 'Segoe UI', Tahoma, sans-serif; background-color: ${theme.bg}; margin: 0; padding: 0;">
<div style="max-width: 600px; margin: 20px auto; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid ${theme.border};">
  <div style="background: ${theme.primary}; color: #ffffff; padding: 40px 20px; text-align: center;">
    <div style="font-size: 11px; letter-spacing: 3px; opacity: 0.8; margin-bottom: 8px; font-weight: bold;">${theme.dayLabel} MARKET REPORT</div>
    <h1 style="margin:0; font-size: 24px; font-weight: 500;">Intelligence Briefing</h1>
    <p style="margin:8px 0 0 0; font-size: 14px; opacity: 0.9;">${escapeHtml_(dateStr)}</p>
    <div style="margin-top: 12px;">
      <span style="display: inline-block; padding: 3px 12px; border: 1px solid rgba(255,255,255,0.5); border-radius: 12px; font-size: 11px; letter-spacing: 1px;">
        ${ai ? '🤖 AI-POWERED ANALYSIS / AI 智能分析' : '📊 KEYWORD ANALYSIS / 关键词分析(AI 不可用)'}
      </span>
    </div>
  </div>`;
  // AI 市场综述(仅当 AI 分析成功时显示)
  if (ai && ai.summary_en) {
    html += `
  <div style="margin: 20px; padding: 16px; background: ${theme.bg}; border-radius: 8px; border: 1px solid ${theme.border};">
    <b style="font-size: 13px; color: ${theme.primary};">AI MARKET SUMMARY / 市场综述</b>
    <p style="font-size: 14px; color: #1e293b; margin: 8px 0 4px 0;">${escapeHtml_(ai.summary_en)}</p>
    <p style="font-size: 13px; color: #64748b; margin: 0;">${escapeHtml_(ai.summary_zh)}</p>
  </div>`;
  }

  html += `
  <div style="font-size: 16px; color: ${theme.primary}; border-left: 5px solid ${theme.accent}; padding-left: 12px; margin: 30px 20px 20px 20px; font-weight: bold; letter-spacing: 1px;">TOP HEADLINES / 今日要闻</div>`;

  for (const p of picked) {
    html += `
  <div style="padding: 0 20px 25px 20px; border-bottom: 1px solid #f1f5f9; margin-bottom: 25px;">
    <div style="font-size: 17px; font-weight: 700; color: #0f172a; margin-bottom: 4px; line-height: 1.4;">${escapeHtml_(p.enTitle)}</div>`;
    if (p.zhTitle) html += `
    <div style="font-size: 14px; color: #64748b; margin-bottom: 10px; font-weight: 500;">${escapeHtml_(p.zhTitle)}</div>`;
    html += `
    <div style="font-size: 14px; color: #334155; line-height: 1.6; margin-bottom: 8px;">${escapeHtml_(p.enDesc)}</div>`;
    if (p.zhDesc) html += `
    <div style="font-size: 13px; color: #94a3b8; line-height: 1.5; margin-bottom: 15px;">${escapeHtml_(p.zhDesc)}</div>`;
    html += `
    <a href="${escapeHtml_(p.url)}" style="display: inline-block; padding: 10px 20px; background-color: ${theme.accent}; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-size: 12px; font-weight: bold;">Read Full Article / 阅读全文</a>
  </div>`;
  }

  html += `
  <div style="font-size: 16px; color: ${theme.primary}; border-left: 5px solid ${theme.accent}; padding-left: 12px; margin: 30px 20px 20px 20px; font-weight: bold; letter-spacing: 1px;">SECTOR ANALYSIS / 板块分析</div>
  <div style="background-color: ${theme.bg}; padding: 25px; border-top: 1px solid ${theme.border};">
    <p style="font-size: 11px; color: #94a3b8; margin: 0 0 12px 0;">${ai ? 'AI-powered analysis over ' + poolSize + ' articles.' : 'Keyword-based sentiment gauge over ' + poolSize + ' articles.'} Not investment advice. / ${ai ? '基于 AI 的板块分析' : '基于关键词的粗略情绪统计'},不构成投资建议。</p>`;

  for (const s of sectorReport) {
    html += `
    <div style="background: #ffffff; border-radius: 10px; padding: 20px; margin-bottom: 15px; border-top: 4px solid ${s.color};">
      <div style="margin-bottom: 12px;">
        <b style="font-size: 16px; color: #0f172a;">${escapeHtml_(s.nameEn)} / ${escapeHtml_(s.nameZh)}</b>
        <b style="float: right; color: ${s.color}; font-size: 12px; border: 1.5px solid ${s.color}; padding: 2px 8px; border-radius: 4px;">${escapeHtml_(s.trendEn)} / ${escapeHtml_(s.trendZh)}</b>
      </div>
      <p style="font-size: 14px; color: #1e293b; margin: 5px 0;"><strong>Insight:</strong> ${escapeHtml_(s.insightEn)}${s.score === 'AI' ? '' : ' (' + s.matched + ' articles, score ' + s.score + ')'}</p>
      <p style="font-size: 13px; color: #64748b; margin: 4px 0 0 0;"><strong>分析:</strong> ${escapeHtml_(s.insightZh)}${s.score === 'AI' ? '' : '(命中 ' + s.matched + ' 篇,得分 ' + s.score + ')'}</p>
    </div>`;
  }

  html += `
  </div>
  <div style="text-align: center; padding: 25px; font-size: 11px; color: #94a3b8; background: #f8fafc; border-top: 1px solid #eee;">
    Sent via Google Apps Script Intelligence<br>Theme: ${theme.dayLabel} Warmth
  </div>
</div></body></html>`;
  return html;
}

// ===== 板块情绪(词袋法,输出命中篇数与得分以示局限)=====
function performBilingualSectorAnalysis(articles) {
  const sectors = [
    { nameEn: 'Technology', nameZh: '科技板块', keywords: ['ai', 'nvidia', 'apple', 'semiconductor', 'nasdaq'], score: 0, matched: 0 },
    { nameEn: 'Finance', nameZh: '金融板块', keywords: ['fed', 'interest', 'bank', 'inflation', 'yield'], score: 0, matched: 0 },
    { nameEn: 'Energy', nameZh: '能源板块', keywords: ['oil', 'gas', 'crude', 'energy', 'opec'], score: 0, matched: 0 }
  ];
  const bullish = ['growth', 'beat', 'surge', 'rally', 'upgrade', 'profit'];
  const bearish = ['drop', 'slump', 'cut', 'layoff', 'recession', 'regulation'];

  for (const art of articles) {
    const text = ((art.title || '') + ' ' + (art.description || '')).toLowerCase();
    for (const s of sectors) {
      if (s.keywords.some(k => text.includes(k))) {
        s.matched++;
        bullish.forEach(w => { if (text.includes(w)) s.score++; });
        bearish.forEach(w => { if (text.includes(w)) s.score--; });
      }
    }
  }

  return sectors.map(s => {
    let trendEn, trendZh, color, insightEn, insightZh;
    if (s.score >= 2) {
      trendEn = 'BULLISH'; trendZh = '看涨'; color = '#b45309';
      insightEn = 'Positive keyword momentum in sector news.'; insightZh = '板块新闻中正面关键词占优。';
    } else if (s.score <= -2) {
      trendEn = 'BEARISH'; trendZh = '看跌'; color = '#991b1b';
      insightEn = 'Negative keyword pressure in sector news.'; insightZh = '板块新闻中负面关键词占优。';
    } else {
      trendEn = 'NEUTRAL'; trendZh = '中性'; color = '#78716c';
      insightEn = 'Balanced keyword sentiment.'; insightZh = '正负面关键词大致平衡。';
    }
    return { ...s, trendEn, trendZh, color, insightEn, insightZh };
  });
}

function analyzeWithAI_(articles) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const headlines = articles.map(a => '- ' + a.title).join('\n');
  const prompt = 'Based on these headlines, return JSON only: {"summary_en":"...","summary_zh":"...","sectors":[{"name":"Technology","trend":"BULLISH|BEARISH|NEUTRAL","reason_en":"...","reason_zh":"..."}]}\n\n' + headlines;

  const resp = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },   // 改为 header 传 Key
      muteHttpExceptions: true,
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );
  if (resp.getResponseCode() !== 200) return null; // 降级回词袋分析
  try {
    return JSON.parse(JSON.parse(resp.getContentText()).candidates[0].content.parts[0].text);
  } catch (e) { return null; }
}