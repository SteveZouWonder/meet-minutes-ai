// ===== 配置(集中管理,便于修改)=====
const CONFIG = {
  QUOTE_API_URL: 'https://dummyjson.com/quotes/random',
  THEME: {
    daily:  { accent: '#4285F4', eventBorder: '#34A853', bg: '#f9f9f9' },
    weekly: { accent: '#185abc', eventBorder: '#FBBC05', bg: '#f0f4f8' }
  },
  FALLBACK_QUOTES: [
    { text: 'The only way to do great work is to love what you do.', from: 'Steve Jobs' },
    { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', from: 'Winston Churchill' },
    { text: "Believe you can and you're halfway there.", from: 'Theodore Roosevelt' },
    { text: 'In the middle of every difficulty lies opportunity.', from: 'Albert Einstein' },
    { text: 'Life is 10% what happens to us and 90% how we react to it.', from: 'Charles R. Swindoll' }
  ]
};

// ===== 工具函数(escapeHtml_ 在 MM_util.js)=====

function formatDate_(date, pattern) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}

/** 获取名言;API 失败/结构异常时记录日志并使用本地 fallback */
function getDailyQuote_() {
  try {
    // 注:UrlFetchApp 不支持自定义超时,deadlineInSeconds 是无效参数,已移除
    const response = UrlFetchApp.fetch(CONFIG.QUOTE_API_URL, { muteHttpExceptions: true });
    const code = response.getResponseCode();
    if (code === 200) {
      const json = JSON.parse(response.getContentText());
      if (json && typeof json.quote === 'string' && json.quote.trim()) {
        return { text: json.quote, from: json.author || 'Unknown' };
      }
      Logger.log('Quote API returned 200 but unexpected payload, using fallback.');
    } else {
      Logger.log('Quote API returned HTTP ' + code + ', using fallback.');
    }
  } catch (e) {
    Logger.log('Quote fetch failed, using fallback. Error: ' + e.message);
  }
  const fallbacks = CONFIG.FALLBACK_QUOTES;
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

/** 渲染单个事件卡片;处理全天事件;showDate 控制是否显示日期行(周报用) */
function renderEventCard_(event, borderColor, showDate) {
  const title = escapeHtml_(event.getTitle() || '(No title)');
  let timeLine;
  if (event.isAllDayEvent()) {
    timeLine = '🕒 All day';
  } else {
    const start = formatDate_(event.getStartTime(), 'hh:mm a');
    const end = formatDate_(event.getEndTime(), 'hh:mm a');
    timeLine = '🕒 ' + start + ' - ' + end;
  }

  let html = "<li style='background-color: #ffffff; margin-bottom: 12px; padding: 16px; border-radius: 8px; border-left: 5px solid " + borderColor + ";'>";
  html += "<div style='color: #202124; font-size: 16px; font-weight: bold; margin-bottom: 6px;'>" + title + '</div>';
  if (showDate) {
    const dateStr = formatDate_(event.getStartTime(), 'EEEE, MMMM d, yyyy');
    html += "<div style='color: #5f6368; font-size: 14px; margin-bottom: 4px;'>📅 " + dateStr + '</div>';
  }
  html += "<div style='color: #5f6368; font-size: 14px;'>" + timeLine + '</div>';
  html += '</li>';
  return html;
}

/**
 * 构建邮件正文(日报/周报共用,消除重复代码)
 * 说明:主流邮件客户端会剥离 <style>/@keyframes,故不再输出无效的动画 CSS,全部使用内联样式
 */
function buildEmailBody_(options) {
  const theme = options.theme;
  const quote = getDailyQuote_();

  let body = '<html><body style="margin: 0; padding: 10px; background-color: ' + theme.bg + ';">';
  body += "<div style='font-family: Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: " + theme.bg + "; border-radius: 12px;'>";

  // Header
  body += "<div style='border-bottom: 2px solid #e0e0e0; padding-bottom: 12px; margin-bottom: 16px;'>";
  body += "<h2 style='color: " + theme.accent + "; margin: 0; font-size: 24px;'>" + options.headerIcon + ' ' + escapeHtml_(options.headerTitle) + '</h2>';
  body += '</div>';

  body += "<p style='color: #555; font-size: 14px; margin-bottom: 20px;'><strong>" + escapeHtml_(options.dateLabel) + ':</strong> ' + escapeHtml_(options.dateStr) + '</p>';

  // 事件列表
  if (options.events.length === 0) {
    body += "<div style='background-color: #ffffff; padding: 20px; border-radius: 8px; text-align: center;'>";
    body += "<p style='color: #666; margin: 0; font-size: 15px;'>" + escapeHtml_(options.emptyMessage) + '</p></div>';
  } else {
    body += "<ul style='list-style-type: none; padding: 0; margin: 0;'>";
    for (const event of options.events) {
      body += renderEventCard_(event, theme.eventBorder, options.showDate);
    }
    body += '</ul>';
  }

  // 名言区块
  body += "<div style='margin-top: 28px; border-top: 1px dashed #e0e0e0; padding-top: 20px;'>";
  body += "<div style='background-color: #ffffff; border-left: 4px solid " + theme.accent + "; padding: 14px 16px; border-radius: 4px;'>";
  body += "<p style='margin: 0; font-size: 14px; color: #555; font-style: italic; line-height: 1.6; font-family: Georgia, serif;'>&ldquo;" + escapeHtml_(quote.text) + '&rdquo;</p>';
  body += "<p style='margin: 6px 0 0 0; font-size: 12px; color: #888; text-align: right;'>&mdash; " + escapeHtml_(quote.from) + '</p>';
  body += '</div></div>';

  body += '</div></body></html>';
  return body;
}

/** 发送邮件;校验收件人,失败时记录日志(便于排查配额/权限问题) */
function sendEmail_(subject, htmlBody) {
  // getActiveUser 在某些触发器环境下返回空,getEffectiveUser 更可靠
  const recipient = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
  if (!recipient) {
    Logger.log('No recipient email available; aborting send.');
    return;
  }
  try {
    MailApp.sendEmail({ to: recipient, subject: subject, htmlBody: htmlBody });
    Logger.log('Email sent to ' + recipient + ': ' + subject);
  } catch (e) {
    Logger.log('Failed to send email: ' + e.message);
    throw e;
  }
}

// ===== 入口函数 =====

/** 发送今日日程 */
function sendDailySchedule() {
  const today = new Date();
  const events = CalendarApp.getDefaultCalendar().getEventsForDay(today);
  const fullDateStr = formatDate_(today, 'EEEE, MMMM d, yyyy');

  const body = buildEmailBody_({
    theme: CONFIG.THEME.daily,
    headerIcon: '📅',
    headerTitle: "Today's Schedule",
    dateLabel: 'Date',
    dateStr: fullDateStr,
    events: events,
    showDate: false,
    emptyMessage: 'You have no events scheduled for today. Enjoy your day! 🎉'
  });

  sendEmail_("📅 Today's Schedule: " + fullDateStr, body);
}

/** 发送本周日程(从今天 0 点起完整 7 天,避免漏掉今天已开始的事件或截断第 7 天) */
function sendWeeklySchedule() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 7);

  const events = CalendarApp.getDefaultCalendar().getEvents(start, end);
  const fullDateStr = formatDate_(start, 'EEEE, MMMM d, yyyy');

  const body = buildEmailBody_({
    theme: CONFIG.THEME.weekly,
    headerIcon: '🗓️',
    headerTitle: "This Week's Overview",
    dateLabel: 'Week of',
    dateStr: fullDateStr,
    events: events,
    showDate: true,
    emptyMessage: 'You have no events scheduled for this week.'
  });

  sendEmail_("🗓️ This Week's Overview: Starting " + fullDateStr, body);
}