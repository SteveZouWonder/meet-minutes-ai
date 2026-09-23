<h1 align="center">Meet Minutes AI</h1>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <b>开完 Google Meet，15~45 分钟后，中英双语纪要、带标签的决策和行动项就在你的邮箱里。</b><br>
  没做完的行动项每周一再提醒 · Jira 票下自动挂链接 · 免费，跑在你自己的 Google 账号里
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Google%20Apps%20Script-V8-4285F4?logo=google&logoColor=white" alt="Google Apps Script V8">
  <img src="https://img.shields.io/badge/Gemini-API-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini API">
</p>

<p align="center">
  <img src="docs/images/readme-hero.png" width="860" alt="纪要邮件：标题栏、摘要、带「已对齐 / 待讨论 / 有分歧」标签的决策项、带负责人和截止日期的行动项">
</p>

<p align="center">
  同一个仓库里还有：<a href="extras/news/README.zh.md">每日财经双语简报</a> · <a href="extras/schedule/README.zh.md">日程邮件提醒</a>
</p>

## 它替你省掉什么

| 你是 | 不用再做的事 |
|---|---|
| 产品经理（PM） | 会后整理纪要。每条决策都带标签：**已对齐 / 待讨论 / 有分歧 / 已搁置**，没谈拢的事不会被写成已定。 |
| TPM / 项目负责人 | 手工追行动项。每一条都进追踪表，带负责人和截止日期；每周一收到一封「还没关掉的」清单，过期的标红。 |
| Jira 票负责人 | 往票里贴链接。标题叫 `PROJ-1234 Weekly Sync` 的会，结束后 PROJ-1234 下面多一条评论，指向英文纪要。 |
| 中英混合团队 | 给另一半同事翻译。中文版只有你自己能看，英文版可以开放给整个项目组。 |
| 每个参会人 | 一边听一边记。 |

## 选一条路

| 你是 | 推荐 | 你要做的 |
|---|---|---|
| PM、TPM 或其他非技术同事 | 用 Steve 的实例 | 邀请 Steve，打开 Gemini 记笔记；想自己收到邮件，给 Steve 发一次消息。[说明](docs/04-use-steve-instance.zh.md) |
| 工程师，或会议很多的团队 | 自己部署一份 | 约 30 分钟。额度是你自己的，邮件只进你的邮箱。[部署教程](docs/02-self-setup.zh.md) |

Steve 的实例跑在他个人的 Google 账号上：默认每月额度约 20 小时会议，大约每 15 分钟处理完一场。够几个项目组的关键会议用，撑不起全公司。见 [容量与边界](docs/04-use-steve-instance.zh.md#容量与边界)。

### 公司同事：两步

1. 日历邀请里加上 Steve（`szou@xm.xxxx.xxx`）。
2. 同一个日历事件里，Google Meet 链接下方打开「Use Gemini to take meeting notes」开关，保存。忘了也没关系，会中任何一个人点右上角的 Gemini 笔记图标、勾上「Also start transcription」再开始，也行。

会后纪要会自动生成。谁收邮件、谁能打开 Doc，取决于 Steve 那边的一行配置，看 [场景速查表](docs/04-use-steve-instance.zh.md#场景速查) 就知道你属于哪一种。

## 用之前先知道三件事

**准确性。** 纪要由 Gemini 生成，会漏、会听错，中英混说时的人名和数字最容易出错。决策、金额、截止日期转发之前请对照转录核一遍。每封邮件底部都印着这句提醒。

**数据。** 转录会离开公司的 Google Workspace，发给 Gemini API。请先确认团队政策允许这样做。用免费额度时，Google 可能拿这些数据改进模型。细节见 [隐私与成本](docs/06-privacy-and-cost.zh.md)。

**成本。** Apps Script、Drive、Gmail 都在 Workspace 配额内，不另收费。Gemini 免费额度够一个人的会议用，系统还有月度熔断，用量到顶就停。

## 文档

| 给谁 | 文档 | 内容 |
|---|---|---|
| 所有人 | [01 · 能得到什么](docs/01-what-you-get.zh.md) | 邮件、两份 Doc、Jira 评论、周一汇总长什么样，带截图 |
| 用 Steve 实例的同事 | [04 · 找 Steve 代跑](docs/04-use-steve-instance.zh.md) | 按场景说明你做什么、Steve 做什么；容量与边界 |
| 所有人 | [05 · 日常使用与常见问题](docs/05-daily-use.zh.md) | 怎么保证会议被处理、行动项怎么关、没收到邮件的原因 |
| 所有人 | [06 · 隐私与成本](docs/06-privacy-and-cost.zh.md) | 数据去了哪里、谁能看到、要花多少钱 |
| 自己部署的人 | [02 · 自己部署](docs/02-self-setup.zh.md) | 约 30 分钟，一步一步带截图 |
| 自己部署的人 | [03 · 配置项速查](docs/03-config-reference.zh.md) | 每个开关是什么、什么时候改 |
| 改代码 / 维护实例的人 | [设计文档](docs/DESIGN.zh.md) · [运维手册](docs/OPS.zh.md) | 架构、状态机、远程运维 |

## 附赠的两个小工具

同一个 Apps Script 项目里还有两个独立脚本，复制时会一起带上，不用可以删：

- [`extras/news/`](extras/news/README.zh.md)：每天早上一封财经新闻双语简报（NewsAPI + Gemini 板块研判）
- [`extras/schedule/`](extras/schedule/README.zh.md)：每天 / 每周把日程发到自己邮箱

## 仓库结构

```
MM_*.js            会议纪要系统(全部文件)
MM_util.js         三个工具共用的两个小函数
news.js            财经日报(extras/news 有说明)
schedule.js        日程提醒(extras/schedule 有说明)
appsscript.json    权限清单与时区,复制项目时必须一起复制
docs/              教程与设计文档(zh / en 各一份)
scripts/mmcall.sh  部署者本机用的远程运维脚本
```

MIT License。有问题找 Steve：szou@xm.xxxx.xxx（或公司 IM），也可以开 GitHub Issue。
