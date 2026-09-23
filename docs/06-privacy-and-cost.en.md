# 06 · Privacy & cost

**English** · [简体中文](06-privacy-and-cost.zh.md)

> Meeting content is sensitive. Read this page before using the system.

## Where the data goes

| Data | Where | How long |
|---|---|---|
| Meeting transcript text | Read from your Drive → sent to the **Google Gemini API** (`generativelanguage.googleapis.com`) → minutes come back | Gemini side: per Google's API data policy; system side: the compressed transcript sits in the backend sheet and is cleared 30 days after the task completes |
| Audio files | Uploaded to the Gemini File API → processed → **deleted as soon as the task finishes** | Does not rely on Google's auto-expiry |
| Minutes JSON | `result_json` column of the `Tasks` sheet (or Drive `MM_data/` when long) | Cleared after 30 days |
| Generated Docs | Your Drive | Until you delete them |
| Action items | `Actions` sheet | Permanent |
| Email | Sent from your mailbox; recipients per 03 | Up to the recipients |
| Jira comment | Your Atlassian site | Permanent |

**The important bit**: transcripts leave your company's Google Workspace and enter the Gemini API. **Confirm that company policy allows sending meeting content to a third-party AI service before using this.** With a personal AI Studio key, Google's data-use terms differ between the free tier and paid usage (free-tier data may be used to improve models) — read the current [Gemini API terms](https://ai.google.dev/terms) yourself.

The Gemini key lives only in script properties and travels in a request header — never in URLs, logs or code. The repo contains no keys.

## Who can see what

| Thing | Default visibility | Can be opened to |
|---|---|---|
| Chinese Doc | **Deployer only**, always | Nobody. The system never shares it; share manually if you want |
| English Doc | Deployer only | Project members / subscribers / attendees / organisation domain / anyone (see 03) |
| Minutes email | Deployer only | Subscribers (when present) / organiser / all attendees |
| Jira comment | Anyone who can see the ticket | The comment has title + English Doc link + counts, no body text; if the link is not shared it is just a link |
| Backend sheet | Deployer only | Share manually with people who need to edit action items. Note `Tasks` contains compressed transcripts and minutes JSON |
| Monday digest | Deployer only | Nobody |

**Design rule**: recipients and share targets come **only from the meeting itself** (attendees, organiser, project matched by title). There is no global "send to everyone" list. `MM_MAIL_POLICY=attendees` and `MM_DOC_SHARE=anyone` exist but are not recommended.

**Sharing is silent**: Drive shares send no notification, and Docs do not appear in other people's search (domain shares are non-discoverable). People reach them only through the link in the email or in Jira.

## What the deployer must protect

| Thing | Why | How |
|---|---|---|
| Gemini API key | Leak = someone else burns your quota | Script properties only; never in screenshots |
| Jira API token | Equals your Jira identity | Same |
| Edit access to the Apps Script project | Editors can read every script property, keys included | Give nobody edit access; share this repo instead |
| Backend sheet | Contains transcript text | Share only with people who genuinely need to edit action items |
| `~/.clasprc.json` (clasp users) | Equals your Google login | `clasp logout` before changing machines |

## Cost

### Gemini

- Model is `gemini-3.6-flash`, Google's cheapest tier.
- **Free tier** (AI Studio default): plenty for one person. A one-hour transcript is roughly 15–20k input tokens + 6–8k output tokens. The free tier has per-minute / per-day request limits; the system calls Gemini at most once or twice per 15 minutes, so one person's use stays well under.
- **Paid key**: per-token billing, well under USD 0.02 per one-hour meeting. Whether to pay depends on your view of the data policy above.
- **Built-in circuit breaker**: 1200 "minutes" per month (≈ 20 h of meetings); over that, processing pauses with an alert and resumes next month. Adjust via `MM_MAX_MONTHLY_MINUTES`.

### Audio costs about 7× text

Gemini listens at ≈ 32 tokens/second; one hour of audio ≈ 115k tokens. Use transcription whenever possible; audio is the fallback.

### Google Workspace side

Apps Script, Drive, Sheets and mail all run inside your Workspace quota at no extra charge. Limits:

| Quota | Ceiling | System usage |
|---|---|---|
| Total timer runtime | 6 h / day | Every 15 min × ≤ 60 s ≈ 1.6 h / day |
| Email | 1500 / day (Workspace) | One per meeting + occasional alerts |
| URL Fetch | 100 MB / day | Transcripts are tiny; audio files ≤ 50 MB each, two a day hits the ceiling |

### NewsAPI (bundled market digest only)

Free tier: 100 requests/day, news delayed 24 h. The digest makes one request per day.

## Disclaimer

Minutes are extracted automatically by AI and may omit, misread or invent. **The recording is the source of truth.** Verify decisions, amounts, deadlines and ownership against the transcript before acting on them. Every email carries this line at the bottom.
