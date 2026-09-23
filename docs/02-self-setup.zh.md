# 02 · 自己部署（约 30 分钟）

[English](02-self-setup.en.md) · **简体中文**

> 不需要会写代码。全程在浏览器里点，只有一步是「复制粘贴文件内容」。

## 开始前准备

| 需要 | 怎么拿 | 说明 |
|---|---|---|
| 公司 Google Workspace 账号 | 你已经有 | 脚本以你的身份运行，读你的日历和 Drive |
| Meet 转录功能可用 | 开一场测试会，点右上角 Gemini 笔记图标，看有没有「Also start transcription」 | 管理员可能关掉；关了就只能走录音文件 |
| **Gemini API Key** | 打开 [Google AI Studio](https://aistudio.google.com/apikey) → Create API key | 免费额度够个人用；Key 只填进脚本属性，不要发给别人 |
| Jira API Token（可选） | Atlassian 账户设置 → Security → API tokens | 只有需要「纪要自动评论到 Jira」才要 |

![AI Studio 的 Create API key 页面（把 key 本体打码） (1/3)](images/ai_studio_create_apikey_1.png)
![AI Studio 的 Create API key 页面（把 key 本体打码） (2/3)](images/ai_studio_create_apikey_2.png)
![AI Studio 的 Create API key 页面（把 key 本体打码） (3/3)](images/ai_studio_create_apikey_3.png)

## 第 1 步：新建 Apps Script 项目

1. 打开 [script.google.com](https://script.google.com) → 左上角「新建项目」。
2. 点左上角「无标题项目」改名，比如 `Meet Minutes`。

![新建后的空项目](images/02-new-project.png)

## 第 2 步：让 `appsscript.json` 显示出来

左侧齿轮「项目设置」→ 勾选「在编辑器中显示 appsscript.json 清单文件」。

这个文件写着脚本需要哪些权限、用哪个时区。**必须**用仓库里的版本覆盖，否则后面会缺权限。

![项目设置里那个勾选框](images/02-show-manifest.png)

## 第 3 步：把文件贴进去

回到编辑器。仓库根目录下每一个 `.js` 文件都要在项目里建一个同名文件：

1. 左侧「文件」旁的 `+` → 「脚本」→ 输入文件名（不带 `.js`，比如 `MM_config`）。
2. 打开仓库里对应的文件，全选复制，粘贴进去覆盖默认内容。
3. 重复，直到下面这些都有了：

```
MM_ai  MM_config  MM_main  MM_members  MM_prompts  MM_remote
MM_render_doc  MM_render_jira  MM_render_mail  MM_setup
MM_source_audio  MM_source_drivedoc  MM_source_meetapi  MM_store  MM_util
```

`news` 和 `schedule` 是两个附赠工具，想用再加（见 `extras/`）。

4. 点开 `appsscript.json`，用仓库里 `appsscript.json` 的内容整个替换。
5. 默认那个 `代码.gs` / `Code.gs` 删掉。
6. `Ctrl/Cmd + S` 保存所有文件。

![左侧文件列表贴完后的样子](images/02-files-list.png)

**会用命令行的同事**：装 [clasp](https://github.com/google/clasp)，`clasp login` → 复制 `.clasp.json.example` 为 `.clasp.json` 填上项目 ID → `clasp push -f`，一条命令搞定，且以后更新方便。

## 第 4 步：填脚本属性

齿轮「项目设置」→ 最底下「脚本属性」→「添加脚本属性」：

| 属性名 | 值 | 必填 |
|---|---|---|
| `GEMINI_API_KEY` | 第 0 步拿到的 key | **是** |
| `JIRA_BASE_URL` | 如 `https://your-company.atlassian.net` | 要 Jira 评论才填 |
| `JIRA_API_TOKEN` | Atlassian API token | 同上 |

其他开关都有默认值，先不用管，跑通后再看 [03 · 配置项](03-config-reference.zh.md)。

![填好 GEMINI_API_KEY 的脚本属性页（值打码）](images/02-script-properties.png)

## 第 5 步：授权 + 跑探针

1. 编辑器顶部函数下拉框选 `MM_probe` → 点「运行」。
2. 弹出「需要授权」→ 审核权限 → 选你的账号。
3. 公司 Workspace 账号会直接看到下面这个授权页：点「Continue」，权限全部勾上 → 允许。个人 Gmail 账号会先多一页「Google 尚未验证此应用」，这是自己写的脚本的正常提示：点「高级」→「转至 Meet Minutes（不安全）」再继续。
4. 等 10~20 秒，下方「执行日志」出现一份报告，同时邮箱会收到一封 `[MM_probe] 会议纪要系统权限探针报告`。

![函数下拉选中 MM_probe 和运行按钮](images/02-run-probe.png)
![Workspace 账号的授权页，点 Continue（账号已打码）](images/02-oauth-consent.png)
![执行日志里的探针报告](images/02-probe-report.png)

看报告：

| 行 | 期望 | 不是怎么办 |
|---|---|---|
| `[CAL]` | ✅ | ❌ 多半是没勾全权限：运行 `MM_authCheck`，按它的提示去 myaccount.google.com 撤销再重授权 |
| `[V4a]` `[V4b]` | ✅ | ❌ Key 填错或模型名过期，报告里会列出可用模型 |
| `[V1]` | 常见 ❌ 403 | **正常**。Meet API 在多数公司账号不可用，系统会自动改读 Drive 里的转录文档 |
| `[V2]` | ⚠️ 没有 Google Meet 文件夹 | 正常 —— 你还没开过带转录的会。做第 6 步 |

## 第 6 步：开一场测试会

1. 日历里建一个 10 分钟后开始的会，带 Meet，只邀请自己（或一个同事）。
2. 进会后，点会中右上角的 Gemini 笔记图标 → 勾上「Also start transcription」→「Start taking notes」。
3. 念一段中英混说的话，比如探针邮件末尾附的那段。1~2 分钟即可。
4. 结束会议。等 10~30 分钟，Drive 里会出现 `Google Meet/` 文件夹和一份转录 Doc。

![会中右上角 Gemini 笔记图标，勾上「Also start transcription」](images/meet-transcribe.png)
![Drive 里新出现的 Google Meet 文件夹](images/02-drive-google-meet.png)

只要转录、不要 Gemini 笔记的话，也可以点右下角「Meeting tools」→「Transcribe」。两个入口都找不到，多半是管理员关了这个功能：系统仍可用，但要把会议录音（≤ 50 MB）放进 Drive 的 `会议录音/` 文件夹来处理。

## 第 7 步：初始化

函数下拉选 `MM_setupOnce` → 运行。它会：

- 在 Drive 建后台表格 `会议双语纪要系统 — 后台数据表`
- 建 `会议录音/`（含 `已处理/` `纪要/`）文件夹
- 装两个定时任务：每天 00:30 排未来 24 小时的会；每 15 分钟推进一步
- 给你发一封 `[会议纪要系统] 初始化完成`

![初始化完成邮件](images/02-setup-done.png)

## 第 8 步：确认它在工作

运行 `MM_status`，执行日志里应看到：

```
任务总数: 0
触发器: MM_workerEvery15Min, MM_plannerDaily
生效配置: scope=accepted lang=both fileMode=split docShare=owner ...
收件人: mailPolicy=organizer toOrganizer=off subscribers=0
```

再运行 `MM_calDump`，会列出未来 24 小时的日历事件和每一场「合格 / 不合格 + 原因」。

## 以后每次开会只需要两件事

1. **接受邀请**（日历上点「是」—— 系统默认只处理你组织的和你已接受的会）
2. **让会议留下文字**：建会时打开「Use Gemini to take meeting notes」开关（推荐），或会中右上角的 Gemini 笔记图标 → 勾上「Also start transcription」→「Start taking notes」

会议结束后 15~45 分钟收邮件。收不到就看 [05 · 常见问题](05-daily-use.zh.md)。

## 想让别人也收到？

默认只发你自己。三个开关（都在脚本属性里加）：

| 想要 | 加 |
|---|---|
| 某几个同事只要参加了会就收到 + 能看英文 Doc | `MM_SUBSCRIBERS` = `a@company.com,b@company.com` |
| 别人组织的会，组织者也收到 | `MM_MAIL_TO_ORGANIZER` = `on` |
| 某项目的会，项目组全员能看英文 Doc | `MM_PROJECT_SHARE`，见 03 |

改完属性不用重新部署，下一场会就生效。
