# 运维手册：不用打开编辑器，从自己电脑上操作脚本

> 适用于部署者本人。普通使用者不需要读这一篇。
> 前提：本机安装了 [clasp](https://github.com/google/clasp) 并 `clasp login` 过（登录的就是脚本所有者账号）。

---

## 1. 为什么需要它

Apps Script 的函数平时只有两种触发方式：定时触发器自动跑，或者人打开编辑器点「运行」。运维时经常需要**从自己电脑上直接执行某个函数并拿到结果**（跑诊断、手工补一场会的纪要、替同事改行动项状态）。官方的远程调用方式 `clasp run` 要求脚本绑定一个自建的 GCP 项目；很多公司账号**没有创建 GCP 项目的权限**，这条路走不通。

替代方案：把脚本部署为 **Web App**，当作一个「远程函数调用网关」。

## 2. 一句话理解

> Web App 就是给脚本装了一个「门铃」（一个 HTTPS 地址）。有人按门铃（发 HTTP 请求），`doPost` 函数就会被叫醒，以脚本所有者的身份干活，然后把结果送回去。

```
本机 mmcall.sh  ──POST {fn, key, args}──▶  doPost()（MM_remote.js）
                                             ├─ 验身份:请求必须带所有者本人的 Google 令牌
                                             ├─ 对暗号:key 必须等于脚本属性 MM_REMOTE_KEY
                                             ├─ 查白名单:fn 必须在 MM_REMOTE_ALLOW 里
                                             └─ 执行 fn(...args),把返回值 + 执行日志打包成 JSON
本机                ◀──JSON {ok, result, logs}──┘
```

## 3. 两个最关键的设置（`appsscript.json` → `webapp`）

| 设置 | 值 | 通俗解释 |
|---|---|---|
| `executeAs` | `USER_DEPLOYING` | 开门后干活的人永远是所有者。不管谁按门铃，脚本都以所有者身份读 Drive、写 Sheet、发邮件 |
| `access` | `MYSELF` | 只有所有者本人能按门铃。请求必须携带所有者的 Google 登录凭据；这是很多组织能选的最严格值 |

门铃只有我能按，开门干活的也是我 —— 前提是「我的凭据」没泄露。`~/.clasprc.json` 里的 clasp 令牌就是这份凭据。所以又加了第二道锁：**暗号 `MM_REMOTE_KEY`**（脚本属性；本机存在 `~/.config/clasp/mm_remote_key`，权限 0600）。

## 4. 一次性搭建

1. 生成暗号并存两处：
   ```bash
   mkdir -p ~/.config/clasp && openssl rand -hex 24 > ~/.config/clasp/mm_remote_key && chmod 600 ~/.config/clasp/mm_remote_key
   cat ~/.config/clasp/mm_remote_key    # 复制这个值
   ```
   编辑器 → 项目设置 → 脚本属性 → 新增 `MM_REMOTE_KEY` = 刚复制的值。
2. 编辑器 → 部署 → 新建部署 → 类型「Web 应用」→ 执行身份「我」→ 访问权限「只有我自己」→ 部署。记下部署 ID（`AKfycb...`）。
3. 把 [`scripts/mmcall.sh`](../scripts/mmcall.sh) 复制到 `~/.config/clasp/mmcall.sh`，把里面的 `DEPLOY_ID` 换成你的，`chmod +x`。
4. 试一下：
   ```bash
   ~/.config/clasp/mmcall.sh MM_status
   ```

## 5. 日常怎么用

```bash
M=~/.config/clasp/mmcall.sh
$M MM_status                              # 任务数 / 状态分布 / 触发器 / 生效配置 / 收件人配置
$M MM_probe                               # 权限探针(Meet API 403 是常见现状,可忽略)
$M MM_calDump '[36]'                      # 未来 36h 日历事件:eligible / reasons / existing_task
$M MM_taskDump '[10]'                     # 任务表关键列
$M MM_membersDump '["PROJ-1234 Sync"]'    # 预演这个标题会按哪个项目共享;'["PROJ", true]' 强制刷新 Jira 名单
$M MM_actionsDump '[30, true]'            # 行动项表(最近 30 条,只看 OPEN)
$M MM_actionSetStatus '["T2026...#2", "DONE"]'          # 改行动项状态;第三个参数可给 due,如 "2026-10-01"
$M MM_propsGet                            # 线上脚本属性(含 KEY / TOKEN 的只显示长度)
$M MM_propsSet '[{"MM_SUBSCRIBERS":"a@x.com,b@x.com"}]'   # 改非敏感属性;值为 "" 表示删除
$M MM_resyncTask '["T2026..."]'           # 按当前共享策略重做某个已完成任务的 Doc 共享与 Jira 评论
$M MM_plannerDaily                        # 手动跑一次 planner
```

白名单在 `MM_remote.js` → `MM_REMOTE_ALLOW`。不在名单里的函数即使知道名字也调不到。`MM_propsSet` 额外拒绝任何含 `KEY / TOKEN / SECRET / PASSWORD` 的键和 `MM_SHEET_ID` —— 密钥只能在编辑器里手工填。

## 6. 排查「这场会为什么没出纪要」

```bash
$M MM_calDump '[36]' | grep -E '"title"|"eligible"|"reasons"|"existing_task"'
```

- `eligible:false` → 看 `reasons`：无 Meet 链接 / 全天事件 / 不在范围（我的应答不是 accepted）
- `eligible:true` 但 `existing_task:null` 且会议在 24h 内 → planner 没跑或失败，手动 `$M MM_plannerDaily`
- 任务卡在 `NEW` → Drive 里还没有转录文件。等，或确认会中确实开了转录
- `FAILED / EXPIRED` → `$M MM_taskDump` 看 `last_error`；重跑：编辑器里 `MM_retryTask()` 填 taskId 后运行
- 历史会议 / 别人共享给你的转录 Doc → 编辑器里填 `MM_ADHOC` 后运行 `MM_adhocDriveDoc()`

## 7. 改了代码之后

```bash
for f in *.js; do node --check "$f"; done    # GAS 文件可直接语法检查
clasp push -f                                # 只更新 HEAD(触发器跑 HEAD)
clasp deploy -i <你的部署ID> -d "<说明>"       # Web App 才跟着变
sleep 15; ~/.config/clasp/mmcall.sh MM_status
```

**改了代码 ≠ 生效（最常踩的坑）**：`clasp push` 只更新「草稿」（HEAD）。Web App 地址永远执行「上次拍的快照」，push 之后忘了 `deploy -i` 就会出现「明明改了为什么行为没变」。始终用 `-i` 更新同一个部署 —— 每个脚本最多约 20 个部署，且新建会换地址。定时触发器跑的是 HEAD，Web App 跑的是快照，两者可能短暂不一致。

## 8. 必须知道的注意点

- **看返回内容，别看 HTTP 状态码。** Web App 几乎永远返回 200，包括身份校验失败（那时返回的是 HTML 登录页）。`mmcall.sh` 只认我们自己的 JSON。
- **请求会跳转一次。** `POST script.google.com/.../exec` 会 302 到 `script.googleusercontent.com`，`curl -L` 自动跟随。
- **偶发 Google 的 404 HTML**「Sorry, unable to open the file at this time」，与代码无关，`mmcall.sh` 会自动重试。服务端可能已执行过一次 —— 所有步骤都是幂等的（同名 Doc 复用、`mail_sent` 标记、`jira_sync` 记录），所以不会重复发邮件。
- **客户端断开，服务端不会停。** Ctrl-C 只关掉自己这边，Google 那边跑到结束（上限 6 分钟）。
- **不要并发调用同一个有副作用的函数。** `MM_adhocDriveDoc` 没拿锁，连按两次会同时推进同一个任务。
- **日志只在响应里。** `console.log` 进 Cloud Logging（要 GCP 项目才能看），所以远程调用把日志缓存在 `MM_LOGBUF_` 随响应带回。
- **令牌换取依赖 Bearer 访问方式。** `mmcall.sh` 用 clasp 的 refresh token 换 access token。这属于「当前可用」，不是 SLA。某天突然返回 HTML 登录页而代码没动，先怀疑这一点；退回编辑器手动运行即可。
- **clasp 令牌过期（错误 9109）**：`clasp login` 重新登录。

## 9. 安全清单

已实现：Google 身份 + 暗号双重校验（常量时间比较）、函数白名单、参数只接受 JSON 数组、暗号放 POST body 不放 URL、本机密钥不在项目目录（`.claspignore` 只放 `*.js` 与 `appsscript.json`）。

需要维护：
- 保护 `~/.clasprc.json` —— 它等同于你的 Google 身份。换机器或不再使用时先 `clasp logout`
- 脚本属性对所有有编辑权限的人可见；不要随手给他人此脚本的编辑权限
- **一键关闭**：删掉脚本属性 `MM_REMOTE_KEY`，立即生效，无需重新部署。彻底移除用 `clasp undeploy <deploymentId>`
- 长期不需要远程调用的高副作用函数（`MM_setupOnce`、`MM_retryTask`、`MM_propsSet`），可从 `MM_REMOTE_ALLOW` 删除以缩小攻击面

## 10. 与其他方案的对比

| 方案 | 结论 |
|---|---|
| `clasp run`（Apps Script API） | 需要自建 GCP 项目并绑定，公司账号常无权限 |
| Web App + `ANYONE_ANONYMOUS` + 暗号 | 多数域管理员禁用；且只剩一道锁 |
| 编辑器手动运行 | 可行，但每次要人点按钮、手工复制日志 → 作为兜底 |
| **Web App + `MYSELF` + 暗号 + 白名单** | **采用**。在「无 GCP、域策略受限」下安全性与自动化程度最好的组合 |

## 11. 按场景的配置动作（S1–S8）

同事按 [04 · 找 Steve 代跑](04-use-steve-instance.zh.md) 的场景编号来找你时，对应的操作如下。命令都经 `mmcall.sh` 远程执行，也可以在编辑器里手动跑同名函数。

| 场景 | 动作 |
|---|---|
| S1 新项目 | `MM_propsSet '[{"MM_PROJECT_SHARE":"{...加一条...}"}]'`；固定名单用 `MM_MEMBERS_<KEY>` |
| S2 / S3 / S4 | `MM_propsGet` 看当前 `MM_SUBSCRIBERS` → `MM_propsSet` 追加邮箱 |
| S5 | 编辑器填 `MM_ADHOC` → `MM_adhocDriveDoc()`；共享用 `MM_resyncTask` |
| S6 | 文件放进 `会议录音/` |
| S8 | `MM_actionsDump '[30,true]'` 找 id → `MM_actionSetStatus '["<id>","DONE"]'` |
| 排查「为什么没出」 | `MM_calDump '[36]'` 看 `eligible` / `reasons`，再按 [§6](#6-排查这场会为什么没出纪要) 往下查 |

加订阅或新项目之前先看一眼 `MM_status` 的「本月用量」：实例的容量边界见 04 的 [容量与边界](04-use-steve-instance.zh.md#容量与边界)，快到月度额度时，建议对方自己部署，而不是调高额度。
