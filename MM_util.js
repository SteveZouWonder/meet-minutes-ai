/**
 * MM_util.js — 三个工具共用的小函数(HTML 转义、每日配色)
 * 职责:被 MM_render_mail.js、news.js、schedule.js 同时使用的纯函数;本文件无任何依赖
 * 被谁调用:MM_render_mail.js、news.js、schedule.js
 *
 * Apps Script 把项目里所有文件放在同一个全局作用域,同名函数后加载者覆盖先加载者。
 * 以前 news.js 与 schedule.js 各自定义了一份 escapeHtml_,行为一致所以没出问题;
 * 集中到这里之后,任何一个脚本单独复制走都能用。
 */

/** HTML 转义:所有拼进邮件/文档的外部文本(日历标题、AI 输出、API 内容)都必须经过这里 */
function escapeHtml_(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 每日一套邮件配色:day = Date#getDay()(0 = 周日) */
function getDailyTheme(day) {
  const themes = [
    { dayLabel: 'SUNDAY',    primary: '#78350f', accent: '#92400e', bg: '#fffbeb', border: '#fde68a' },
    { dayLabel: 'MONDAY',    primary: '#9a3412', accent: '#c2410c', bg: '#fff7ed', border: '#ffedd5' },
    { dayLabel: 'TUESDAY',   primary: '#854d0e', accent: '#b45309', bg: '#fffbeb', border: '#fef3c7' },
    { dayLabel: 'WEDNESDAY', primary: '#7c2d12', accent: '#9a3412', bg: '#fdf2f2', border: '#fee2e2' },
    { dayLabel: 'THURSDAY',  primary: '#365314', accent: '#4d7c0f', bg: '#f7fee7', border: '#ecfccb' },
    { dayLabel: 'FRIDAY',    primary: '#831843', accent: '#9d174d', bg: '#fdf2f8', border: '#fce7f3' },
    { dayLabel: 'SATURDAY',  primary: '#1e3a8a', accent: '#1e40af', bg: '#eff6ff', border: '#dbeafe' }
  ];
  return themes[day] || themes[1];
}
