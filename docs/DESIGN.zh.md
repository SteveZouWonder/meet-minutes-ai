# 会议双语纪要系统 — 设计文档（面向开发者）

> 这份文档讲「为什么这么设计」。只想用的话不用读，看 [`02-self-setup.zh.md`](02-self-setup.zh.md) 就够了。
> 运行环境：Google Workspace 账号 + Google Apps Script（无需 GCP 项目、无需服务器）。
> 代码文件全部以 `MM_` 开头，运行时全部读脚本属性，仓库里不含任何账号信息。

---

## 1. 系统目标

把会议内容（Meet 转录 / 会议纪要 Doc / 任意音频）自动转成**中英双语结构化纪要**，产出 Google Doc、一封邮件，并把行动项汇总进一张 Sheets 做跨会议追踪；标题含 Jira 票号时把英文版链接评论到该票。

**非目标**：实时字幕、Meet 界面内按钮、视频画面理解、多租户（一个部署只服务脚本所有者，见 §6.4 的「代跑」模式）。

---

## 2. 关键设计决策

| # | 决策 | 结果 |
|---|---|---|
| 1 | 数据源优先级：Meet 转录 API → Drive Doc 兜底 → 音频文件夹 | 三级降级，见 §3 |
| 2 | 音频文件夹入口独立于日历 | 覆盖非 Meet 会议 |
| 3 | `LANG='both'` + `FILE_MODE='split'` + `AI_CALL='single'` | 一次调用出双语，两份 Doc |
| 4 | 日历事件结束后触发，结束后 12 小时内每 15 分钟扫一次 | 转录产物通常延迟 10~30 分钟出现 |
| 5 | 行动项写回 Sheets，人工维护 status | 周一汇总只看 `OPEN` |
| 6 | 收件人只来自「这场会」 | 禁止全局广播；三种叠加开关见 §6.4 |
| 7 | 所有公司专属配置走脚本属性 | 代码默认值全部中性，可公开 |

---

## 3. 数据源（两个入口，三级降级）

### 3.1 入口 A：日历驱动（会议类）

| 优先级 | 代号 | 来源 | 产出 |
|---|---|---|---|
| 1 | **SRC_MEET_API** | Meet REST API `conferenceRecords.transcripts.entries` | 带说话人 + 时间戳的结构化文本 |
| 2 | **SRC_DRIVE_DOC** | Drive `Google Meet/` 文件夹内的转录 / Gemini 笔记 Doc（含他人组织会议落下的快捷方式） | 纯文本 |

> Meet REST API 在很多组织里对普通账号返回 403（默认 GCP 项目未启用且无权限开启），代码遇 403 直接降级到 Drive Doc，不视为错误。

### 3.2 入口 B：音频文件驱动（非会议类，独立于日历）

| 代号 | 来源 | 说明 |
|---|---|---|
| **SRC_AUDIO** | Drive 音频文件夹（默认 `会议录音/`），单文件 **≤ 50 MB** | 无日历事件。worker 扫描到新文件即建 `NEW` 任务；去重键 = Drive fileId；标题 = 文件名；日期 = 文件创建时间。成功后移入 `已处理/` |

### 3.3 明确不支持

- **视频直送 Gemini**：官方上限约 45 分钟（含音频）。用户需本地转音频：
  ```bash
  ffmpeg -i meeting.mp4 -vn -ac 1 -ar 16000 -c:a aac -b:a 32k meeting.m4a
  ```
  2 小时输出约 29 MB，落在 Apps Script 的 **50 MB URL Fetch POST** 上限内。
- **超长音频的 map-reduce**：音频无法按说话人边界切块。按 **约 32 token/秒** 估算，超 25 万 token（约 2.2 小时）直接 `FAILED` 并告警。

### 3.4 容量参考（2 小时会议）

| 形态 | 体积 / Token | 结论 |
|---|---|---|
| 转录文本 | ≈ 3.5 万 token | 轻松 |
| 音频 32kbps 单声道 | 28.8 MB ≈ 24 万 token | 可行 |
| 视频 | 50 万+ token，且超 45 分钟上限 | 不支持 |

---

## 4. 触发与调度

### 4.1 触发器（单脚本单用户**最多 20 个触发器**）

不为每个会议单独建触发器。只用 2 个常驻触发器，会议队列放 Sheets：

| 触发器 | 频率 | 职责 |
|---|---|---|
| `MM_plannerDaily` | 每日 1 次（00:30） | 全量规划：扫描未来 24 小时内带 Meet 链接的日历事件，写入任务表，状态 `SCHEDULED`；周一附带发「未完成行动项汇总」；清理 30 天前的 `result_json` |
| `MM_workerEvery15Min` | 每 15 分钟 | ① 增量规划（补录过去 2 小时结束的会）② 日历核对（取消 / 改期）③ 扫描音频文件夹 ④ 推进活跃任务 |

### 4.2 会议范围（`MM_EVENT_SCOPE`）

只扫脚本所有者的 primary 日历。他人组织的会议按所有者的应答状态决定：

| 值 | 处理 |
|---|---|
| `organizer` | 只处理我组织的 |
| `accepted`（默认） | 我组织的 + 我已接受邀请的 |
| `all` | 所有带 Meet 链接且未拒绝的 |

### 4.3 取消 / 改期 / 周期性

| 场景 | 处理 |
|---|---|
| 事件被取消 | `SCHEDULED` 任务核对日历发现已不存在 → `CANCELLED`（终态，不告警） |
| 事件被改期 | 更新结束时间与轮询窗口 |
| 周期性会议 | 每个 instance 是独立任务；去重键 = **instance id** |

### 4.4 轮询窗口

- 任务在事件结束后才进入 `NEW`；轮询窗口 = 结束时间 + **12 小时**（`MM_POLL_WINDOW_HOURS`）
- 超窗仍无产物 → `EXPIRED` + 告警邮件（附「转音频补救」说明）

### 4.5 并发与预算

- 所有入口函数先 `LockService.getScriptLock().tryLock(30s)`，拿不到锁静默退出
- 单次执行 ≤ 60 秒硬要求；内部预算 50 秒（`EXEC_BUDGET_MS`），超时收尾退出
- 廉价步骤（日历核对、探测）每轮全部任务执行；昂贵步骤（Gemini、Doc、音频上传）每轮最多 `MM_MAX_HEAVY_PER_RUN`（默认 2）个

---

## 5. 状态机

| 状态 | 动作 | 类型 | 下一步 |
|---|---|---|---|
| `SCHEDULED` | 等待事件结束；每轮核对日历 | 廉价 | → `NEW` / `CANCELLED` |
| `NEW` | 判定数据源（Meet API → Drive Doc） | 廉价 | → `TEXT_READY` / `AUDIO_PENDING` / 原地等待 |
| `AUDIO_PENDING` | 上传音频到 Gemini File API | 昂贵 | → `AUDIO_PROCESSING` |
| `AUDIO_PROCESSING` | 轮询文件 `ACTIVE` | 廉价 | → `TEXT_READY` |
| `TEXT_READY` | 预处理转录（压缩） | 廉价 | → `SUMMARIZING` |
| `SUMMARIZING` | 调 Gemini 出双语 JSON | 昂贵 | → `RENDER_DOC` |
| `RENDER_DOC` | 生成中 / 英 Doc 并共享（幂等：按标题查重） | 昂贵 | → `WRITE_SHEET` |
| `WRITE_SHEET` | 行动项写入追踪表（按 action_id upsert） | 廉价 | → `SYNC_JIRA` |
| `SYNC_JIRA` | 标题含票号则评论到 Jira（按 `jira_sync` 幂等）；顺带补齐未完成的共享 | 廉价 | → `SEND_MAIL` |
| `SEND_MAIL` | 发送纪要邮件（`mail_sent` 幂等） | 廉价 | → `DONE` |
| `DONE` / `FAILED` / `EXPIRED` / `CANCELLED` | 终态 | — | — |

- 每次触发每个任务只推进一步
- 可重试错误（429 / 5xx / 超时）指数退避，上限 3 次后 `FAILED`；4xx 业务错误直接 `FAILED`
- `SUMMARIZING` 成功后 JSON 存 `result_json`，后续步骤复用，重试不重复调 Gemini

---

## 6. 输出规格

### 6.1 配置项（静态默认，可用同名脚本属性覆盖）

```js
OUTPUT: {
  LANG:      'both',   // 'both' | 'zh' | 'en'          → MM_LANG
  FILE_MODE: 'split',  // 'split'(两个 Doc) | 'merged'   → MM_FILE_MODE
  DELIVER:   'both',   // 'both' | 'email' | 'doc'       → MM_DELIVER
  AI_CALL:   'single'  // 'single' | 'dual'              → MM_AI_CALL
}
```

全部属性的说明见 [`03-config-reference.zh.md`](03-config-reference.zh.md)。

### 6.2 Google Doc：落点与可见范围

```
2026-08-20 Product Sync — 中文纪要.gdoc
2026-08-20 Product Sync — English Minutes.gdoc
```

| 版本 | 存放位置 | 可见范围 |
|---|---|---|
| English Minutes | 默认与中文版同夹 `MM_ZH_FOLDER`；`MM_EN_FOLDER=<名字>` 单独一夹；`MM_EN_FOLDER=meeting` 跟随会议目录 | 三级判定，见下 |
| 中文纪要 | `MM_ZH_FOLDER`（默认 `会议纪要（中文·私人）/`） | **永远仅所有者**，不做任何共享 |

英文版共享优先级（`MM_shareDoc_`）：

1. **命中项目规则**（`MM_PROJECT_SHARE`：标题含该项目票号，或匹配 keywords 正则）→ 对**项目组成员逐人** reader，不看是否参会，不发通知。到此为止。
2. 否则 **订阅者**（`MM_SUBSCRIBERS` 中且出现在这场会参会人列表里的人）逐人 reader。
3. 再叠加 **`MM_DOC_SHARE`**：`owner`（默认，不再开放）/ `domain`（对 `MM_SHARE_DOMAINS` 的组织域「知道链接者可查看」，域列表为空或被策略拦截时回退 `attendees`）/ `attendees`（参会人逐人 reader）/ `anyone`（不推荐）。

任务表 `doc_share` 列记录实际结果，如 `owner` / `subscribers:2+owner` / `project:PROJ:12/47 (jira)` / `domain:example.com`。邮件底部据此生成「谁能看」说明。

**项目组成员怎么来**（`MM_members.js`）：Jira 项目角色 API 对普通账号常返回 403，采用近似 —— `project = KEY AND updated >= -<jiraDays>d` 的 issue 的 assignee / reporter（`accountType=atlassian`）。缓存在脚本属性 `MM_MEMBERS_CACHE_<KEY>`（24h），Jira 不可用时退回旧缓存。过滤：去掉所有者；`MM_MEMBER_DOMAINS` 非空时邮箱域必须在列表内。覆盖：`MM_MEMBERS_<KEY>`（固定名单）、`MM_MEMBERS_EXTRA_<KEY>` / `MM_MEMBERS_EXCLUDE_<KEY>`。名单大时 `RENDER_DOC` 可能因预算只共享一部分，`SYNC_JIRA` 开头 `MM_shareTopUp_` 补齐；历史任务用 `MM_resyncTask()`。

`merged` 模式合成一份双语 Doc，中文在前 —— 注意合并版含中文，共享范围仍按英文版规则执行；需要中文私密请保持 `split`。

### 6.3 纪要结构

摘要 / 决策项（已对齐 · 待讨论 · 有分歧 · 已搁置）/ 行动项（任务 · 负责人 · 截止）/ 议题详情 / 术语对照表

### 6.4 邮件与收件人策略（会议纪要是敏感内容，不做全局广播）

`to` 恒含所有者；其他人全部来自**这场会**，四个开关可叠加：

| 开关 | 效果 | 适用 |
|---|---|---|
| （默认） | 只发所有者 | 最安全 |
| `MM_MAIL_TO_ORGANIZER=on` | 他人组织的会，`to` 加上组织者 | 组织者想自动收到 |
| `MM_SUBSCRIBERS=a@x.com,b@x.com` | 名单里的人只要在参会人列表中就进 `bcc`，并获英文 Doc reader | **同事不自建实例、由所有者代跑**时的核心开关：按人订阅 |
| `MM_MAIL_POLICY=attendees` | 全部参会人进 `bcc` | 粒度最粗，不推荐长期开 |

- 音频任务（无参会人）一律只发所有者
- 一封邮件：中文在上、英文在下，底部附 Doc 链接与「谁能看」说明
- 告警邮件、周一行动项汇总只发所有者

**「代跑」模式的物理前提**：系统只读所有者的日历与 Drive，所以只能处理**所有者在场**（被邀请且接受、且会中开了转录）的会议。这不是配置问题，是数据可达性问题；真正的多租户需要每人各自部署。

### 6.5 行动项追踪表（Sheets `Actions`）

| 列 | 说明 |
|---|---|
| `action_id` | 主键，`任务ID#序号`（upsert 依据） |
| `meeting_id` / `meeting_title` / `meeting_date` | 会议信息 |
| `task_zh` / `task_en` | 双语任务描述 |
| `owner` | 负责人（取自说话人归属，未知留空） |
| `due` | ISO 8601 或空 |
| `status` | `OPEN` / `DONE` / `DROPPED`，**人工维护**，系统 upsert 时不覆盖 |
| `doc_url` | 纪要 Doc 链接 |
| `created_at` | 写入时间 |

**周一汇总**（`MM_weeklyDigest_`）：`status=OPEN` 且（有 `due` 且 7 天内到期或已过期）或（无 `due` 且创建超 14 天）的条目；没有则不发信。`MM_WEEKLY_DIGEST=off` 关闭。远程改状态：`MM_actionSetStatus(action_id, status[, due])`。

---

## 7. 容错与降级

| 场景 | 处理 |
|---|---|
| `single` 双语输出被截断 / 解析失败 | 降级 `dual`（英文 → 翻译成中文 → 按下标 zip 合并；长度不一致则只发英文版并告警） |
| 转录超长（> 25 万 token） | map-reduce：分段摘要 → 合并 → 出双语（仅文本） |
| Meet API 403 / 404 | 降级 Drive Doc；仍无 → 继续轮询直至超窗 |
| Gemini 429 / 5xx | 指数退避，上限 3 次 |
| Gemini 4xx / 音频超限 | 直接 `FAILED` + 告警 |
| 音频 > 50 MB | `FAILED`，告警附 ffmpeg 命令 |
| 任何未捕获异常 | `last_error` 落盘 + 告警 + rethrow |
| 超窗无产物 | `EXPIRED` + 告警 |

---

## 8. 存储

| 数据 | 位置 | 理由 |
|---|---|---|
| 任务表 / 状态机 | Sheets `Tasks` | Properties 单值仅 9 KB，且要能人工排查 |
| 行动项 | Sheets `Actions` | 人工维护 status |
| 月度用量 | Sheets `Usage`（按月一行） | 熔断依据 |
| 超长字段（转录、`result_json`） | Drive `MM_data/` 文件，单元格存 `drive:<id>` | 绕开 5 万字符单元格上限 |
| API Key / 配置覆盖 | 脚本属性 | 代码可公开 |

---

## 9. 成本控制

| 措施 | 说明 |
|---|---|
| 优先走转录文本 | 2 小时约 3.5 万 token，是音频路径的 1/7 |
| 转录预处理压缩 | 合并同说话人连续发言、去时间戳、去填充词，省 15~30% |
| 一次调用出双语 | 比两次调用省约 45% 输入 |
| `responseJsonSchema` + 短键名 | 省数百 token / 次 |
| `thinkingLevel: MINIMAL` | 纪要抽取不需要深度推理 |
| `maxOutputTokens` 动态 | 8192 / 16384 / 32768 按输入规模 |
| **月度熔断** | `MM_MAX_MONTHLY_MINUTES`（默认 1200 分钟 ≈ 20 小时会议），超限只告警不处理，按月重置 |
| `result_json` 暂存 | 重试不重复调 Gemini |

---

## 10. 数据隐私与安全

| 项 | 策略 |
|---|---|
| 转录 / 音频送 Gemini API | 属于送第三方处理。**部署者需确认组织政策允许** |
| Gemini File API 上的音频 | 任务到达终态后立即删除 |
| Doc 共享 | 中文版永不共享；英文版默认仅所有者，开放范围全部显式配置；不自动开放「任何人」 |
| Jira 评论 | 纯英文短卡片（标题 + 英文 Doc 链接 + 统计），不含正文、不含中文；以 `JIRA_USER`（默认所有者）的账号发出 |
| 邮件收件人 | 只来自这场会，禁止全局列表 |
| `result_json` | `DONE` 超过 30 天后清空 |
| API Key / Token | 只存脚本属性；Gemini Key 走请求头不入 URL；远程入口拒绝读写含 KEY / TOKEN 的属性 |
| 外部文本进 HTML | 一律 `escapeHtml_` |

---

## 11. oauthScopes（`appsscript.json`）

```json
"oauthScopes": [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/script.send_mail",
  "https://www.googleapis.com/auth/script.scriptapp",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/meetings.space.created"
]
```

- 日历只读；`drive` 为完整权限（需要读他人共享的转录、创建 Doc、移动文件、设置权限）
- `enabledAdvancedServices` 声明了 Calendar v3：这是让默认 GCP 项目自动开通 Calendar API 的唯一途径（没有 GCP 控制台权限时，REST 直接调会 403「API has not been used in project」）。Meet 没有对应高级服务，所以 Meet REST 保持 403 降级
- 同一项目里的 `extras/` 脚本：`schedule.js` 用 `CalendarApp`（读，已覆盖）；`news.js` 用 `LanguageApp`（无需 scope）

---

## 12. 文件一览

| 文件 | 职责 |
|---|---|
| `MM_config.js` | 静态配置 + 脚本属性覆盖、预算、HTTP 封装、错误分类 |
| `MM_main.js` | 两个触发器入口、planner / worker、状态机每一步 |
| `MM_store.js` | Sheets 持久层（任务 / 行动项 / 用量）、大字段溢出、行动项远程操作 |
| `MM_source_meetapi.js` / `MM_source_drivedoc.js` / `MM_source_audio.js` | 三个数据源 |
| `MM_ai.js` / `MM_prompts.js` | Gemini 调用、schema、map-reduce、dual 降级 |
| `MM_render_doc.js` | Doc 生成与共享 |
| `MM_render_mail.js` | 纪要邮件、告警、周一汇总 |
| `MM_render_jira.js` | Jira 评论 |
| `MM_members.js` | 项目判定、项目组名单 |
| `MM_setup.js` | 探针、初始化、状态看板、诊断、手工入口 |
| `MM_remote.js` | Web App 远程入口（见 [`OPS.zh.md`](OPS.zh.md)） |
| `MM_util.js` | `escapeHtml_` / `getDailyTheme`，三个工具共用 |
| `news.js` / `schedule.js` | 附赠的财经日报 / 日程提醒，与 MM 无依赖关系（见 `extras/`） |
