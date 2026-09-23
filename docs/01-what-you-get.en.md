# 01 · What you get

**English** · [简体中文](01-what-you-get.zh.md)

> Five minutes to decide whether this is for you.

After a Google Meet that left text behind (Gemini meeting notes or a Meet transcript) ends, usually within 15–45 minutes, the following shows up.

## Start with the part for your role

| You are | Read first | What it solves |
|---|---|---|
| Product manager | [Decision tags](#decision-tags-four-states) | See at a glance what was settled and what is still open |
| TPM or project lead | [Monday digest](#every-monday-open-action-items) · [Backend sheet](#one-backend-spreadsheet) | Action items tracked across meetings, not from memory |
| Ticket owner | [Jira comment](#a-jira-comment-when-the-title-has-a-ticket-key) | Minutes linked on the ticket without pasting anything |
| Just want to see the output | [One email](#one-email) | Three screenshots |

## One email

Subject: `[会议纪要] 2026-09-03 PROJ-1234 Fulfillment Handling`

Top to bottom:

1. Header: meeting name, date, and where the text came from (Meet transcript / Drive doc / audio)
2. **Chinese section**: summary → decisions (each tagged Aligned / To discuss / Disputed / Parked) → action items table (task · owner · due) → topic details → glossary
3. **English section**: same structure
4. Two buttons at the bottom: "中文纪要 Doc" and "English Minutes Doc", followed by one line saying who can open them
5. Disclaimer: extracted by AI, the recording is the source of truth

![top of the email: header + Chinese summary + decisions with coloured tags](images/01-mail-top.png)
![middle: action items table + start of the English section](images/01-mail-actions.png)
![bottom: the two Doc buttons + visibility note](images/01-mail-footer.png)

### Decision tags: four states

Gemini tags every decision based on how the discussion went. When it can't tell, the tag is "To discuss"; it never rounds up to "Aligned".

| Tag | Meaning | What you can do with it |
|---|---|---|
| Aligned | Clearly agreed in the meeting | Quote it as a conclusion in a PRD or status update |
| To discuss | Raised, no conclusion | Put it on the next agenda |
| Disputed | Someone objected, or views still differ | Follow up with the people involved |
| Parked | Deliberately deferred | Nothing to chase unless things change |

**Who receives it?** By default only the person who deployed the script. Anyone else has to be configured explicitly; see [03 · Configuration](03-config-reference.en.md#who-gets-the-email) or [04 · Use Steve's instance](04-use-steve-instance.en.md).

## Two Google Docs

Saved in a Drive folder called `会议纪要（中文·私人）/` (rename it if you like):

```
2026-09-03 PROJ-1234 Fulfillment Handling — 中文纪要
2026-09-03 PROJ-1234 Fulfillment Handling — English Minutes
```

- The **Chinese** doc is only ever visible to the deployer. The system never shares it.
- The **English** doc is also deployer-only by default; it can be opened up per project, per person or per domain (rules in 03).

Same structure as the email plus a title block (date, attendees, source). Edit it, comment on it, forward it. It is an ordinary Google Doc.

![first screen of the English doc](images/01-doc-en.png)
![the two docs side by side in the Drive folder](images/01-drive-folder.png)

## A Jira comment (when the title has a ticket key)

If the meeting title contains something like `PROJ-1234`, that ticket gets one comment once the minutes are done:

```
Meeting minutes — 2026-09-03 · PROJ-1234 Fulfillment Handling
📄 English Minutes (Google Doc)
3 decisions · 3 action items · 4 topics
```

English only, no body text, no Chinese; posted under the deployer's Atlassian account. Re-running the same meeting updates the comment in place instead of adding another.

![the comment under a Jira ticket](images/01-jira-comment.png)

## Every Monday: open action items

Early Monday morning, if the tracking sheet still has open items, you get a digest:

| Task | Owner | Due | Meeting | |
|---|---|---|---|---|
| Draft a design doc specifying the API endpoints for UAT automation | Steve Zou | — | PROJ-1234 Fulfillment Handling | minutes |

Overdue dates are red. Set that row's `status` to `DONE` or `DROPPED` in the sheet and it disappears next week. No open items, no email.

![the Monday digest](images/01-weekly-digest.png)

## One backend spreadsheet

Drive gains a Google Sheet named `会议双语纪要系统 — 后台数据表` with three tabs:

| Tab | Contents | Do you touch it? |
|---|---|---|
| `Tasks` | Processing state, errors and Doc links per meeting | Read when debugging, never edit |
| `Actions` | Every action item; the `status` column is yours | **Yes** — set DONE when finished |
| `Usage` | Gemini minutes used per month | Glance occasionally |

![the `Actions` tab with the status column highlighted](images/01-sheet-actions.png)

## What it will not do

- No live captions, no buttons inside the Meet UI
- No minutes for meetings that left no text. Switch on "Use Gemini to take meeting notes" when creating the event, or have someone in the call start Gemini notes or a transcript
- No video understanding; plain audio files work but must be ≤ 50 MB
- No "send to everyone" list; recipients only ever come from that meeting's attendees

Next: [set it up yourself](02-self-setup.en.md) or [use Steve's instance](04-use-steve-instance.en.md).
