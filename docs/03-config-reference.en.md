# 03 · Configuration reference

**English** · [简体中文](03-config-reference.zh.md)

> Every setting is a "script property": editor → gear "Project Settings" → "Script Properties" at the bottom. Changes apply on the next timer run — no redeploy.
> A property you have not set uses its default. Deleting a property restores the default.

![the properties page with a few entries filled in](images/03-script-properties.png)

## Required

| Property | Value | Notes |
|---|---|---|
| `GEMINI_API_KEY` | key from AI Studio | Nothing works without it. Only here, never in code |

## What gets produced

| Property | Values | Default | When to change |
|---|---|---|---|
| `MM_LANG` | `both` / `zh` / `en` | `both` | You only want one language |
| `MM_FILE_MODE` | `split` / `merged` | `split` | `merged` = one bilingual Doc. Note the merged Doc contains Chinese, so sharing it exposes the Chinese too |
| `MM_DELIVER` | `both` / `email` / `doc` | `both` | `doc` = no email, just the Docs; `email` = the reverse |
| `MM_AI_CALL` | `single` / `dual` | `single` | One call produces both languages. `dual` = English first, then translate; costlier, exists as a fallback |

## Who gets the email

`to` always includes the deployer. The three switches below **stack**, and every recipient comes from **that meeting's attendee list** — there is no broadcast list.

| Property | Value | Default | Effect |
|---|---|---|---|
| `MM_SUBSCRIBERS` | comma-separated emails | empty | Anyone on this list who is in the meeting's attendees goes on `bcc` **and** gets read access to the English Doc. The **recommended** way to let specific colleagues receive minutes |
| `MM_MAIL_TO_ORGANIZER` | `on` / `off` | `off` | For meetings organised by someone else, the organiser goes on `to` |
| `MM_MAIL_POLICY` | `organizer` / `attendees` | `organizer` | `attendees` = every attendee on `bcc`. Coarsest option; not recommended long-term |

Audio-file tasks (no attendees) always go to the deployer only. Alerts and the Monday digest always go to the deployer only.

## Who can open the Docs

**The Chinese Doc is only ever visible to the deployer** — no setting changes that. Everything below is about the English Doc (or the `merged` Doc).

Three levels, first match wins:

1. Title matches a project in `MM_PROJECT_SHARE` → **project members** get read access (next section).
2. Otherwise: people in `MM_SUBSCRIBERS` who attended get read access.
3. Then `MM_DOC_SHARE` is applied on top:

| `MM_DOC_SHARE` | Effect |
|---|---|
| `owner` (default) | Nothing further |
| `attendees` | Every attendee of that meeting can read |
| `domain` | Anyone in the domains listed in `MM_SHARE_DOMAINS` with the link can read (not searchable, no notification). Empty list or blocked by company policy → falls back to `attendees` |
| `anyone` | Anyone with the link. **Not recommended** |

| Property | Value | Default |
|---|---|---|
| `MM_SHARE_DOMAINS` | comma-separated domains, e.g. `company.com,sub.company.com` | empty |
| `MM_ZH_FOLDER` | folder name | `会议纪要（中文·私人）` — both Docs live here |
| `MM_EN_FOLDER` | empty / folder name / `meeting` | empty = same folder as Chinese; `meeting` = English Doc follows the meeting's Google Meet folder |

The outcome is recorded in the `doc_share` column of the `Tasks` sheet and summarised at the bottom of the email.

## Project sharing (English Doc for a whole project team)

| Property | Value | Notes |
|---|---|---|
| `MM_PROJECT_SHARE` | JSON | Project rules. Example: `{"PROJ":{"keywords":["\\bmy\\s*project\\b"],"jiraDays":120}}` — a title containing a `PROJ-<number>` key, or matching any keyword regex (case-insensitive), counts as that project's meeting |
| `MM_MEMBERS_<KEY>` | comma-separated emails | Fixed member list. If set, **Jira is not queried** |
| `MM_MEMBERS_EXTRA_<KEY>` | comma-separated emails | Add people beyond the Jira list |
| `MM_MEMBERS_EXCLUDE_<KEY>` | comma-separated emails | Remove people from the list |
| `MM_MEMBER_DOMAINS` | comma-separated domains | Member emails must be in one of these domains; empty = no restriction |

Replace `<KEY>` with the project key, e.g. `MM_MEMBERS_PROJ`. Without a fixed list, members = assignees / reporters of that project's issues updated in the last `jiraDays` days (needs the Jira settings below), cached 24 h in `MM_MEMBERS_CACHE_<KEY>` (system-managed, do not edit).

## Jira

| Property | Value | Default | Notes |
|---|---|---|---|
| `JIRA_BASE_URL` | `https://xxx.atlassian.net` | empty | Empty = all Jira features off |
| `JIRA_API_TOKEN` | Atlassian API token | empty | Empty = off |
| `JIRA_USER` | email | deployer's email | Whose account the comment is posted from |
| `MM_JIRA_SYNC` | `on` / `off` | `on` | Pause comments without removing the credentials |
| `MM_JIRA_STYLE` | `links` / `full` | `links` | `links` = 3-line card; `full` = entire English minutes in the comment |
| `MM_JIRA_SOURCE_LINK` | `on` / `off` | `off` | Also link the source transcript Doc in the comment |

## Meeting scope

| Property | Values | Default | Notes |
|---|---|---|---|
| `MM_EVENT_SCOPE` | `organizer` / `accepted` / `all` | `accepted` | Which meetings: only mine / mine + ones I accepted / every Meet I have not declined (includes "maybe" and "no reply") |
| `MM_POLL_WINDOW_HOURS` | number | `12` | How long after the meeting to wait for a transcript before marking EXPIRED and alerting |
| `MM_AUDIO_FOLDER` | folder name | `会议录音` | Drive folder for audio files |

## Cost and throttling

| Property | Value | Default | Notes |
|---|---|---|---|
| `MM_MAX_MONTHLY_MINUTES` | number | `1200` | Monthly circuit breaker in minutes, ≈ 20 h of meetings. Over the cap: alert only, no processing; resets next month |
| `MM_MAX_HEAVY_PER_RUN` | number | `2` | How many expensive steps (AI call, Doc generation) one 15-minute run may do. A text meeting needs 2, so the default finishes about one meeting every 15 minutes |
| `MM_MAX_RETRY` | number | `3` | Retries on failure |
| `MM_MODEL` | model name | `gemini-3.6-flash` | Change when a model is retired (`MM_probe` lists available ones) |
| `MM_THINKING_LEVEL` | `MINIMAL` / `LOW` / `MEDIUM` / `HIGH` | `MINIMAL` | Higher = slower and costlier; MINIMAL is enough for minutes |
| `MM_AUDIO_ASSUMED_KBPS` | number | `32` | Bitrate used to estimate duration from audio file size |
| `MM_WEEKLY_DIGEST` | `on` / `off` | `on` | The Monday open-action-items email |

## Operations (not needed by ordinary users)

| Property | Notes |
|---|---|
| `MM_REMOTE_KEY` | Shared secret for the Web App remote entry point. No property = remote entry disabled. See [OPS](OPS.zh.md) |
| `MM_SHEET_ID` | Backend spreadsheet ID, written by `MM_setupOnce`. **Do not edit** |
| `MM_ALERTED_*` / `MM_MEMBERS_CACHE_*` | System-managed dedup markers and caches; safe to delete, they rebuild |

## Three common setups

**A. Just me (default)** — set nothing but `GEMINI_API_KEY`.

**B. I run it, two teammates also want the minutes**
```
MM_SUBSCRIBERS = alice@company.com,bob@company.com
```
Meetings they attend → they get the email and can open the English Doc. Meetings they do not attend → nothing.

**C. Project meetings: whole team reads the English Doc, comment lands on Jira**
```
JIRA_BASE_URL    = https://company.atlassian.net
JIRA_API_TOKEN   = ...
MM_PROJECT_SHARE = {"PROJ":{"keywords":["\\bproj\\b"],"jiraDays":120}}
MM_MEMBER_DOMAINS = company.com
```
Any meeting titled with `PROJ-xxxx` or containing "proj" → English Doc shared with active Jira members of that project, and one comment on the ticket.
