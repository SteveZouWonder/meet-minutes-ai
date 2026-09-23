# 财经日报（附赠工具）

> 每天早上一封邮件：10 条全球财经头条（英文原文 + 中文翻译）+ Gemini 对科技 / 金融 / 能源三个板块的看涨看跌研判 + 一段中英双语市场综述。[English](README.en.md) · [长版介绍文章](ARTICLE.zh.md)

文件：仓库根目录 [`news.js`](../../news.js)，依赖 [`MM_util.js`](../../MM_util.js) 里的两个小函数。与会议纪要系统没有其他关系，可以单独用。

![一封日报的顶部（徽章 + 市场综述 + 第一条新闻）](../../docs/images/extras-news-mail.png)

## 需要什么

| 东西 | 哪里拿 | 必填 |
|---|---|---|
| NewsAPI Key | [newsapi.org](https://newsapi.org) 免费注册 | 是 |
| Gemini API Key | [Google AI Studio](https://aistudio.google.com/apikey) | 否 —— 没有就退化为关键词分析，邮件照发 |

## 部署（10 分钟）

1. Apps Script 项目里新建文件 `news`，粘贴 `news.js`；新建 `MM_util`，粘贴 `MM_util.js`（如果已经装了会议纪要系统，`MM_util` 已经有了）。
2. 项目设置 → 脚本属性：

   | 属性 | 值 |
   |---|---|
   | `NEWS_API_KEY` | NewsAPI 的 key |
   | `GEMINI_API_KEY` | 可选 |
   | `RECIPIENTS` | 可选，逗号分隔的订阅者邮箱。不填只发自己 |

3. 函数下拉选 `sendEnglishPrimaryBilingualReport` → 运行 → 完成授权。几秒后收到第一封。
4. 左侧闹钟图标「触发器」→ 添加触发器 → 函数 `sendEnglishPrimaryBilingualReport` → 时间驱动 → 天定时器 → 选一个小时段（如上午 8~9 点）。

![触发器设置页](../../docs/images/extras-news-trigger.png)

## 它怎么工作

- 从 NewsAPI 拉最近 24 小时最热的 100 条商业 / 金融新闻
- 过滤促销软文（标题、正文、来源三层黑名单）
- 3 天滑动窗口去重，同一条新闻不会连着几天出现
- 100 条标题一次性给 Gemini，让它输出板块研判和综述；失败自动退回词袋法，邮件顶部徽章会标明用的是哪种
- 订阅者走 BCC，互相看不到邮箱
- 出错时给你发一封失败告警

## 诚实提示

- NewsAPI 免费版有约 24 小时延迟，适合「每日复盘」，不适合盘中决策
- AI 分析基于**标题**不是全文，会出错、会幻觉
- **不构成投资建议**
