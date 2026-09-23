# 04 · Don't want to set it up? Use Steve's instance

**English** · [简体中文](04-use-steve-instance.zh.md)

> For colleagues who just want the minutes and would rather not touch Apps Script.

## One constraint first

Steve runs a copy of this system. It **can only see Steve's own calendar and Drive**. So a meeting can be processed only if both are true:

1. **Steve (`szou@xm.xxxx.xxx`) is on the invite** and has accepted it ("Yes" in Calendar);
2. **The meeting leaves text behind**: turn on "Use Gemini to take meeting notes" when creating the event (recommended: set once, works every time), or someone in the call uses the Gemini notes icon at the top right of the call → tick "Also start transcription" → "Start taking notes". No text, no minutes, and nobody can do this step for you.

With those two in place the system processes the meeting 15–45 minutes after it ends. What is left is only: **who receives the output, and who can open it**. That is what the scenarios below are about.

![Calendar event: Steve added on the right, the Gemini notes toggle switched on at the bottom left](images/04-invite-steve.png)
![Fallback during the call: the Gemini notes icon at the top right, with "Also start transcription" ticked](images/meet-transcribe.png)

## Scenario cheat sheet

| Your situation | You do | Steve does |
|---|---|---|
| **S1** Project meeting (title has a ticket key `PROJ-1234` or the project name) | Invite Steve; switch on Gemini notes | Nothing if the project is already configured; one rule for a new project |
| **S2** Ordinary meeting, you want the minutes **yourself** | Invite Steve; Gemini notes; tell Steve your email | Adds you to the subscriber list (once) |
| **S3** You organise the meeting and want it **every time** | Same as S2 | Same as S2 (the subscriber list applies to organisers too) |
| **S4** You want **every attendee** to receive it | Invite Steve; Gemini notes; give Steve the list of people | Adds those people to the subscriber list. No "send to all" switch will be turned on |
| **S5** Past meeting / Steve was not there but you have the transcript Doc | Share the transcript Doc with Steve (view is enough); tell him title and date | Runs it manually |
| **S6** Not a Meet, just an audio recording | Share the file (≤ 50 MB) with Steve | Drops it in the audio folder; processed within 15 min |
| **S7** Only want the Jira comment, no email | Ticket key in the title; invite Steve; Gemini notes | Nothing to configure |
| **S8** You finished an action item from the minutes | Tell Steve which one | Marks it in the tracking sheet; gone from next Monday's digest |

## Scenario details

### S1 · Project meetings

A title with a ticket key (`PROJ-1234 Weekly Sync`) or a project keyword makes the system treat it as that project's meeting:

- the English Doc is shared with **project members** (people with assignee / reporter activity on that Jira project in the last 4 months), whether or not they attended;
- the ticket gets one comment with the English Doc link;
- the email still goes to Steve only by default; stack S2 if you want it.

**Which projects are configured**: ask Steve. **New project**: give Steve the key and the usual keywords; one rule.

### S2 / S3 · I want minutes for meetings I attend

Steve adds your email to `MM_SUBSCRIBERS`. From then on:

- meetings you attend (you are on the attendee list) where Steve is also present → you get the email and can open the English Doc;
- meetings you did not attend → nothing reaches you.

One-time setup, no per-meeting sign-up.

### S4 · Everyone in the meeting

There is **no** "send to all attendees" button. Well, there is, but Steve will not turn it on: it would mail every meeting's minutes to every attendee, including people who should not receive them. The alternative is S2: put the people who need it on the subscriber list. The list can change any time.

### S5 · Past meeting / transcript exists but Steve was absent

The Meet transcript Doc lives in the organiser's Drive. Share it with Steve as **Viewer**, then send him the **meeting title** and **date**. Steve runs it once by hand; the output is shared per S1 / S2 rules or directly with you.

### S6 · Audio files

Any audio format (m4a / mp3 / wav…), one file ≤ 50 MB. Video is not accepted; convert first:

```bash
ffmpeg -i meeting.mp4 -vn -ac 1 -ar 16000 -c:a aac -b:a 32k meeting.m4a
```

Share it with Steve; he drops it in the `会议录音/` folder and it is processed within 15 minutes. The file name becomes the meeting title.

### S7 · Jira comment only

Nothing extra: ticket key in the title + Steve present + the meeting left text behind, and the comment appears. It is posted from Steve's Atlassian account.

### S8 · Closing an action item

Action items in the email and the Monday digest come from a tracking sheet. When one is done, tell Steve "which meeting, which item" and he sets it to DONE. Alternatively Steve can share the sheet with you and you edit the `status` column on the `Actions` tab yourself (`DONE` or `DROPPED`).

## Capacity and limits

Steve's instance runs on one person's Google account. These limits decide how many meetings it can take:

| Limit | Value | What it means |
|---|---|---|
| Monthly budget | 1,200 "minutes" a month; a one-hour meeting uses about 50–70 | Roughly 20 hours of meetings a month by default. When it runs out, processing pauses until the 1st. Steve can raise it; the rows below can't be raised |
| Throughput | One run every 15 minutes, at most 2 expensive steps per run, 2 steps per meeting | About one meeting finished every 15 minutes. When many meetings end in the same afternoon they queue, and minutes can arrive hours later |
| Gemini key | Steve's personal key | The whole company's meetings should not go through one person's key; see [06 · Privacy & cost](06-privacy-and-cost.en.md) |
| Email quota | 1,500 recipients a day on Workspace | Counted per recipient, not per email |
| Single point of failure | Steve must be invited and accept; Jira comments post as Steve; only Steve can open the Chinese Doc | If Steve is on leave or his authorisation expires, the instance stops |

The key meetings of a few project teams (weekly syncs, reviews, launch check-ins) fit comfortably. If your team has a lot of meetings, or you are an engineer, [run your own copy](02-self-setup.en.md): the quota and the data stay in your account. Covering the whole company would need a deployment on a company account with an approved paid key, not one person's instance.

## Message template

Copy, fill in, send to szou@xm.xxxx.xxx or on the company chat:

```
Meeting minutes request
- Meeting title:
- Date / time:
- My case: S1 / S2 / S4 / S5 / S6 (pick one)
- People who should receive the email:
- Jira comment needed: yes / no (ticket: )
- Anything else:
```

For the exact config change Steve makes in each scenario, see the [ops manual (zh) · per-scenario actions](OPS.zh.md#11-按场景的配置动作s1s8).
