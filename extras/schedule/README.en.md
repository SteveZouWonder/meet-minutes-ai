# Agenda mailer (bundled extra)

> Every morning your agenda for today, every Monday your agenda for the week, as a tidy email to yourself, with a quote at the bottom. [中文](README.zh.md)

File: [`schedule.js`](../../schedule.js) in the repo root, which uses `escapeHtml_` from [`MM_util.js`](../../MM_util.js). Zero configuration, no keys.

![a daily agenda email](../../docs/images/extras-schedule-mail.png)

## Setup (5 minutes)

1. In your Apps Script project create a file `schedule` and paste `schedule.js`; create `MM_util` and paste `MM_util.js` (already there if you installed the meeting-minutes system).
2. Function dropdown → `sendDailySchedule` → Run → complete authorisation (read-only calendar + send mail).
3. "Triggers" → add two:

   | Function | Type | When |
   |---|---|---|
   | `sendDailySchedule` | Day timer | 7–8 am |
   | `sendWeeklySchedule` | Week timer | Monday, 7–8 am |

![the trigger list with both entries](../../docs/images/extras-schedule-trigger.png)

## Notes

- Reads your **default calendar**; all-day events show as "All day"
- Mails only you; there is no recipient setting
- Quotes come from dummyjson.com's random endpoint, with 5 built-in fallbacks
- Colours, quote list and wording all live in `CONFIG` at the top of the file
