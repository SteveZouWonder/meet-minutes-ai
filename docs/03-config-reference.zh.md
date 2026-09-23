# 03 · 配置项速查

[English](03-config-reference.en.md) · **简体中文**

> 所有配置都是「脚本属性」：编辑器 → 齿轮「项目设置」→ 最底下「脚本属性」。改完立即生效（下一次定时任务），不用重新部署。
> 没写的属性就用默认值。删掉属性 = 恢复默认。

![脚本属性页面，几条属性填好的样子](images/03-script-properties.png)

## 必填

| 属性 | 值 | 说明 |
|---|---|---|
| `GEMINI_API_KEY` | AI Studio 拿到的 key | 没有它整个系统不工作。只填这里，不要写进代码 |

## 输出什么

| 属性 | 可选值 | 默认 | 什么时候改 |
|---|---|---|---|
| `MM_LANG` | `both` / `zh` / `en` | `both` | 只要一种语言 |
| `MM_FILE_MODE` | `split` / `merged` | `split` | `merged` = 中英合成一份 Doc。注意合并版含中文，共享时中文也会被看到 |
| `MM_DELIVER` | `both` / `email` / `doc` | `both` | 不想收邮件只要 Doc → `doc`；反之 `email` |
| `MM_AI_CALL` | `single` / `dual` | `single` | 一次调用出双语。`dual` = 先英文再翻中文，更贵，仅作降级 |

## 谁收邮件

`to` 永远包含部署者。下面三个开关**叠加**生效，收件人全部来自**这场会的参会人**，没有「全体广播」。

| 属性 | 值 | 默认 | 效果 |
|---|---|---|---|
| `MM_SUBSCRIBERS` | 逗号分隔邮箱 | 空 | 名单里的人，只要在这场会的参会人列表里，就进 `bcc`，**同时**获得英文 Doc 查看权。**推荐**的「让某几个同事收到」方式 |
| `MM_MAIL_TO_ORGANIZER` | `on` / `off` | `off` | 别人组织的会，组织者进 `to` |
| `MM_MAIL_POLICY` | `organizer` / `attendees` | `organizer` | `attendees` = 全部参会人进 `bcc`。粒度最粗，不推荐长期开 |

录音文件任务（没有参会人）永远只发部署者。告警、周一汇总永远只发部署者。

## 谁能看 Doc

**中文 Doc 永远只有部署者可见**，任何设置都改不了。下面说的都是英文 Doc（或 `merged` 合并版）。

三级判定，从上到下第一条命中就决定：

1. 标题命中 `MM_PROJECT_SHARE` 的项目 → **项目组成员**逐人可查看（见下一节）。
2. 否则：`MM_SUBSCRIBERS` 里在场的人逐人可查看。
3. 再叠加 `MM_DOC_SHARE`：

| `MM_DOC_SHARE` 值 | 效果 |
|---|---|
| `owner`（默认） | 不再开放 |
| `attendees` | 这场会全部参会人可查看 |
| `domain` | `MM_SHARE_DOMAINS` 列出的组织域「知道链接者可查看」（不可搜索、不发通知）。域列表为空或被公司策略拒绝 → 自动退为 `attendees` |
| `anyone` | 知道链接的任何人。**不推荐** |

| 属性 | 值 | 默认 |
|---|---|---|
| `MM_SHARE_DOMAINS` | 逗号分隔域名，如 `company.com,sub.company.com` | 空 |
| `MM_ZH_FOLDER` | 文件夹名 | `会议纪要（中文·私人）` —— 中英文 Doc 都放这里 |
| `MM_EN_FOLDER` | 空 / 文件夹名 / `meeting` | 空 = 同中文夹；`meeting` = 英文版跟随会议的 Google Meet 目录 |

共享结果记在后台表 `Tasks` 的 `doc_share` 列，邮件底部也会写一句。

## 按项目共享（英文 Doc 给整个项目组）

| 属性 | 值 | 说明 |
|---|---|---|
| `MM_PROJECT_SHARE` | JSON | 项目规则。例：`{"PROJ":{"keywords":["\\bmy\\s*project\\b"],"jiraDays":120}}` —— 标题含 `PROJ-数字` 票号，或匹配 keywords 正则（不分大小写），就算这个项目的会 |
| `MM_MEMBERS_<KEY>` | 逗号邮箱 | 固定名单。设了就**不查 Jira** |
| `MM_MEMBERS_EXTRA_<KEY>` | 逗号邮箱 | 在 Jira 名单之外多加几个人 |
| `MM_MEMBERS_EXCLUDE_<KEY>` | 逗号邮箱 | 从名单里去掉几个人 |
| `MM_MEMBER_DOMAINS` | 逗号域名 | 名单里邮箱域必须在此列表内；空 = 不限 |

`<KEY>` 换成项目 key，如 `MM_MEMBERS_PROJ`。没有固定名单时，成员 = Jira 该项目最近 `jiraDays` 天内 issue 的 assignee / reporter（需要 Jira 配置），缓存 24 小时在 `MM_MEMBERS_CACHE_<KEY>`（系统自动维护，别手改）。

## Jira

| 属性 | 值 | 默认 | 说明 |
|---|---|---|---|
| `JIRA_BASE_URL` | `https://xxx.atlassian.net` | 空 | 空 = 整个 Jira 功能关闭 |
| `JIRA_API_TOKEN` | Atlassian API token | 空 | 空 = 关闭 |
| `JIRA_USER` | 邮箱 | 部署者邮箱 | 评论以谁的账号发出 |
| `MM_JIRA_SYNC` | `on` / `off` | `on` | 临时关掉评论但保留配置 |
| `MM_JIRA_STYLE` | `links` / `full` | `links` | `links` = 3 行短卡片；`full` = 完整英文纪要贴进评论 |
| `MM_JIRA_SOURCE_LINK` | `on` / `off` | `off` | 评论里附上源转录 Doc 的链接 |

## 会议范围

| 属性 | 值 | 默认 | 说明 |
|---|---|---|---|
| `MM_EVENT_SCOPE` | `organizer` / `accepted` / `all` | `accepted` | 处理哪些会：只我组织的 / 我组织的 + 我已接受的 / 所有带 Meet 且未拒绝的（含「待定」「未回复」） |
| `MM_POLL_WINDOW_HOURS` | 数字 | `12` | 会议结束后等转录出现的最长时间，超时标 EXPIRED 并告警 |
| `MM_AUDIO_FOLDER` | 文件夹名 | `会议录音` | 放录音文件的 Drive 文件夹 |

## 成本与节流

| 属性 | 值 | 默认 | 说明 |
|---|---|---|---|
| `MM_MAX_MONTHLY_MINUTES` | 数字 | `1200` | 每月熔断（分钟）。≈ 20 小时会议。超了只告警不处理，下月自动恢复 |
| `MM_MAX_HEAVY_PER_RUN` | 数字 | `2` | 每 15 分钟一轮里最多执行几个耗时步骤（调 AI、生成 Doc）。一场文字会需要 2 步，所以默认约每 15 分钟处理完 1 场 |
| `MM_MAX_RETRY` | 数字 | `3` | 失败重试次数 |
| `MM_MODEL` | 模型名 | `gemini-3.6-flash` | 模型下线时改这里（`MM_probe` 会列可用模型） |
| `MM_THINKING_LEVEL` | `MINIMAL` / `LOW` / `MEDIUM` / `HIGH` | `MINIMAL` | 越高越贵越慢，纪要抽取 MINIMAL 足够 |
| `MM_AUDIO_ASSUMED_KBPS` | 数字 | `32` | 从录音文件大小反推时长时用的码率 |
| `MM_WEEKLY_DIGEST` | `on` / `off` | `on` | 周一「未完成行动项汇总」邮件 |

## 运维（普通使用者不需要）

| 属性 | 说明 |
|---|---|
| `MM_REMOTE_KEY` | Web App 远程入口的暗号。没有这个属性 = 远程入口关闭。见 [OPS](OPS.zh.md) |
| `MM_SHEET_ID` | 后台表格 ID，`MM_setupOnce` 自动写入。**别改** |
| `MM_ALERTED_*` / `MM_MEMBERS_CACHE_*` | 系统自己维护的去重标记和缓存，可以删，会自动重建 |

## 三个常见组合

**A. 只给自己用（默认）** —— 什么都不加，只填 `GEMINI_API_KEY`。

**B. 我跑，团队里两个人也想收到**
```
MM_SUBSCRIBERS = alice@company.com,bob@company.com
```
他们参加的会 → 收邮件 + 能看英文 Doc；他们没参加的会 → 与他们无关。

**C. 项目组会议，全组能看英文 Doc，并评论到 Jira**
```
JIRA_BASE_URL    = https://company.atlassian.net
JIRA_API_TOKEN   = ...
MM_PROJECT_SHARE = {"PROJ":{"keywords":["\\bproj\\b"],"jiraDays":120}}
MM_MEMBER_DOMAINS = company.com
```
标题带 `PROJ-xxxx` 或含 "proj" 的会 → 英文 Doc 对 Jira 上活跃的项目成员开放，票下多一条评论。
