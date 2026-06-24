# Blueprint: Slack alert → LLM triage bot

This document is for someone looking to build a similar bot for their own
"Slack alert needs an LLM-written triage summary" workflow. It's the
architecture and design decisions behind 32Co's Case Refinement Triage
Bot, written so you can adapt the pattern to a different domain.

The reference implementation lives in the same repo as this file. About
500 lines of JavaScript total. Read it alongside this doc.

---

## What this bot does (in one paragraph)

A Slack alert fires in a channel ("Case Refinement Alert" - a clinical
case has hit its second refinement). A bot picks it up within 15 minutes,
gathers context from the company's data warehouse and from Slack history,
asks Claude to write a triage summary using a long prompt that encodes
all the rules a senior clinical associate would apply, and posts the
summary in the alert thread. The clinical lead then reads the summary
and decides what to do next. The bot saves about 30 minutes of manual
lookup per alert.

The pattern is generalisable to any "alert needs context-gathering + a
written summary" workflow: bug triage, customer-success escalation, on-
call paging, fraud review, support ticket queues, etc.

---

## High-level architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                          Slack channel                           │
│                                                                  │
│  ┌──────────┐                       ┌────────────────────────┐  │
│  │  Alert   │  poll every 15 min    │ Bot reads, summarises, │  │
│  │ from bot │──────────────────────▶│ posts reply in thread  │  │
│  └──────────┘                       └────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
       │                                            ▲
       │ conversations.history                      │ chat.postMessage
       ▼                                            │
┌──────────────────────┐    POST    ┌──────────────────────────────┐
│ Netlify scheduled    │───────────▶│ Netlify background function  │
│ function (15-min     │            │ (15-min runtime cap)         │
│  cron)               │            │                              │
│                      │            │  ┌────────────────────────┐  │
│  Pulls history,      │            │  │ Claude tool-use loop   │  │
│  filters new alerts, │            │  │                        │  │
│  claims with 👀,     │            │  │  - SQL via Metabase    │  │
│  dispatches one POST │            │  │  - Mongo via Metabase  │  │
│  per alert.          │            │  │    saved question      │  │
│                      │            │  │  - Slack history scan  │  │
└──────────────────────┘            │  │  - Post final summary  │  │
                                    │  └────────────────────────┘  │
                                    └──────────────────────────────┘
                                              │
                                              ▼
                                    ┌──────────────────────────────┐
                                    │  Anthropic API (Claude)      │
                                    │  + Metabase HTTP API         │
                                    └──────────────────────────────┘
```

Two Netlify functions:

- **`poll-alerts`** - runs on a 15-minute cron. Fast (1-3s). Queries Slack
  for recent messages in the alert channel, filters to ones that look
  like alerts and don't already have a "processed" reaction, claims each
  with a 👀 reaction, and dispatches each one to the background function
  via HTTP. Returns immediately.

- **`triage-background`** - background function (Netlify's name for a
  fire-and-forget function with a 15-minute runtime cap). Receives one
  alert payload, runs the Claude tool-use loop, posts the summary in
  the alert thread, and swaps 👀 for 🤖 once posted.

---

## Key design decisions (and why)

### 1. Serverless, not a long-running server

Netlify's free tier gives 125k function invocations / month. Polling
every 15 minutes is ~2,900 invocations / month, so we're using ~2% of
the budget. No server to patch, no uptime to monitor, no DevOps overhead.

If you don't already use Netlify, the same pattern works on Vercel,
Cloudflare Workers (with caveats around long-running functions), AWS
Lambda + EventBridge, or Google Cloud Functions + Scheduler. Pick the
one closest to whatever your team already uses.

### 2. Two functions, not one

Netlify's standard and scheduled functions cap at 26 seconds. Our triage
runs take 30 to 120 seconds because of all the Claude tool calls
(typically 10-20 round trips). So we split:

- The cron-triggered function does only fast work (~3 seconds).
- It dispatches to a background function (up to 15 minutes runtime).

You only need this split if your triage takes longer than your platform's
default function timeout. If your work fits in 26 seconds, do it all in
one function.

### 3. State in Slack reactions, not a database

Two emoji reactions track state:

- 👀 = "claimed for processing". Added the moment the bot picks up an alert.
- 🤖 = "summary posted". Added once the bot has posted in the thread.

The poll function skips any alert that already has either reaction. This
gives us:

- **Idempotency for free.** If the bot crashes mid-triage, the alert
  still has 👀 but no 🤖, so a human knows to investigate or re-trigger.
- **Observable state from Slack itself.** No "look in the database" step
  to find stuck alerts.
- **No persistence layer.** No database, no Redis, no key-value store.
- **Survives bot restarts.** State lives in Slack.

If your alerts are very high volume (>1000/day), reactions might be too
coarse. For 5-50 alerts/day this works perfectly.

A small admin endpoint (`/clear-reactions?ts=...`) lets you wipe the
bot's reactions to re-trigger a specific alert. Useful for testing or
for retrying after a code change.

### 4. All triage logic lives in the prompt, not in code

The Node.js code is plumbing: open HTTP connections, dispatch tool calls,
post messages. It knows nothing about the clinical domain. All the
"how to triage" logic - which queries to run, in which order, how to
weight different signals, when to flag for clinical oversight - lives
in one big prompt string in `src/prompt.js`.

Why this matters:

- **Domain owners can iterate.** Editing the prompt is editing one
  string. No JavaScript knowledge needed. A non-engineer can ship a
  prompt change in under a minute.
- **The prompt is also the spec.** When the team disagrees about how
  the bot should behave, the prompt is the source of truth.
- **No code review for prompt changes.** Push and see what happens. For
  a single-team internal tool this is fast and safe.

The trade-off: the bot's behaviour is non-deterministic in places where
the prompt is ambiguous. Iterate on the prompt as you discover edge
cases.

### 5. Tool use via the Claude API, not Cowork or MCPs

The agent loop is just the Anthropic SDK's `messages.create` with a
`tools` parameter, plus a small dispatcher. The dispatcher maps each
tool call Claude emits to a function (e.g. "run this SQL", "post this
to Slack") and feeds the result back into the conversation.

Pattern in pseudocode:

```javascript
let messages = [{ role: "user", content: initialUserMessage }];

while (iter++ < MAX_ITERATIONS) {
  const response = await anthropic.messages.create({
    model, system: SYSTEM_PROMPT, tools: TOOL_DEFS, messages,
  });
  messages.push({ role: "assistant", content: response.content });

  const toolUses = response.content.filter(b => b.type === "tool_use");
  if (toolUses.length === 0) break;  // Claude is done

  const toolResults = [];
  for (const toolUse of toolUses) {
    const result = await dispatch(toolUse, ctx);
    toolResults.push({
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify(result),
    });
  }
  messages.push({ role: "user", content: toolResults });
}
```

That's the whole agent loop. About 50 lines of code in `src/anthropic.js`.

### 6. One data router instead of many APIs

The bot needs data from 32Co's PostgreSQL/BigQuery warehouse, from
HubSpot, and from MongoDB. Instead of authenticating to each separately
and writing three different clients, we route everything through
Metabase's HTTP API. Metabase already has read-only access to all three
sources; we just give the bot a Metabase API key.

This cut our auth complexity from "three different OAuth flows or
service accounts" to "one Bearer token". Strongly recommend the
equivalent pattern in your stack - if you have any BI tool that already
has access to your data sources, use its API instead of going direct.

### 7. Slack bot token, not user OAuth

We use a single Slack bot token (`xoxb-...`) with these scopes:

- `channels:history`, `groups:history` - read recent messages
- `chat:write` - post messages
- `reactions:read`, `reactions:write` - manage reactions
- `users:read` - resolve display names

No OAuth flow, no user token, no token refresh logic. The bot is just
another user in the workspace; you invite it to channels with `/invite`.

Gotcha: bot tokens **cannot** use Slack's `search.messages` API. That
requires a user token. We work around it with `conversations.history`
plus client-side filtering, which the bot token can use.

### 8. Secrets in env vars, code in public-safe repo

Every secret (API keys, bot tokens, shared secret between functions)
lives in Netlify's environment variables, marked secret. The Git repo
contains zero credentials and is safe to make public if you want.

The `.env.example` file in the repo lists every variable name needed,
with placeholder values. New deployments fill those into Netlify's UI.

### 9. Iteration via direct push to main

Two-person team, internal tool, no production users outside the company.
We push directly to `main`. Netlify auto-deploys on every push, takes
~60 seconds. No PRs, no CI, no staging environment.

This works because:

- The bot can't damage anything irreversible. Worst case it posts a bad
  Slack message; we read it and fix the prompt.
- We can roll back instantly by reverting the commit. Netlify redeploys
  the previous version in 60 seconds.
- The team using the bot's output is the team writing the prompt. Fast
  feedback loop.

For a higher-stakes deployment (customer-facing, regulated, etc) you'd
add PR review, a staging environment, and integration tests.

### 10. Costs

| Item                     | Cost                                  |
| ------------------------ | ------------------------------------- |
| Netlify hosting          | Free (tier covers ~125k runs/month)   |
| Slack API                | Free                                  |
| Anthropic API (Sonnet)   | ~$0.05-0.15 per triage run            |
| Metabase                 | Existing 32Co subscription            |
| **Total at 10/day**      | **~$15-45/month, all Anthropic**      |

---

## Lessons learned

These are non-obvious things we hit while building. Save your colleague
a few hours.

**Slack mrkdwn is not standard Markdown.** Slack's Web API expects
`*bold*` (single asterisks) and `<URL|text>` for links. Standard
Markdown's `**bold**` and `[text](URL)` come out wrong. If you're used
to working with the Slack MCP (which auto-converts), you'll get burned
the first time you call the Web API directly. Build a markdown-to-mrkdwn
converter into your post path and write the prompt in standard Markdown.

**Slack mrkdwn doesn't render `-` as a bullet.** Use a Unicode `•`
character instead. Wrapped lines still don't get hanging indent in plain
mrkdwn; if you need real lists, use Block Kit's `rich_text_list`.

**Bot tokens have surprising limits.** `search.messages` requires a user
token. Removing other users' reactions requires workspace admin
permissions. Test these paths early.

**Claude will sometimes split long tool outputs into multiple calls.**
If you have a "post the final summary" tool, an LLM may call it twice
or three times for a very long output. Hard-guard against it in your
dispatcher: refuse any 2nd+ call to terminal tools within a single run,
and tell the LLM in the response.

**LLMs are too inclusive about context by default.** Our first version
of "surface prior alerts on this dentist" pulled in operational alerts
(replacement orders, data-hygiene flags) alongside clinical ones. We
had to explicitly list both "include these" and "skip these" categories
in the prompt. If you find your bot is producing technically-correct
but unhelpful context, write it down explicitly.

**Background functions can't be triggered by cron directly.** On
Netlify, scheduled functions get the standard timeout (26s); background
functions get the longer timeout (15min) but aren't directly schedulable.
The dispatch pattern (poll → background) is the workaround.

**Test your function endpoints by visiting the URL in a browser.** No
need for curl or Postman for a first sanity check. If your function
returns plain text, browsing to it works. Save the URL as a bookmark
for repeated tests.

---

## Adapting to a different use case

If you're building this for, say, support ticket triage rather than
clinical refinement:

1. **Pick your trigger.** Some bot posts in a Slack channel? A Linear
   ticket gets a specific label? A row appears in a DB table? The poll
   function adapts.

2. **Decide your context sources.** What does a human triager check?
   - Database / warehouse queries
   - Ticket history in your tracker
   - Slack conversations
   - Customer / account data
   - Prior similar tickets
   
   Each of these becomes a tool the LLM can call.

3. **Write the prompt.** This is where most of the work goes. Start by
   writing the instructions you'd give a new hire doing this triage
   manually. Then refactor into:
   - What input the LLM gets
   - What tools are available
   - What data to gather (in what order)
   - What output format to produce
   - Rules of thumb / "when to flag X"
   - Tone and style

4. **Wire up the tool dispatcher.** One function per tool. Keep these
   small and dumb - the LLM does the reasoning, not the tool functions.

5. **Pick a "claimed" and "done" marker.** Slack reactions if your
   trigger is Slack. A status field if it's a ticketing system. A
   processed-at column if it's a DB row. The principle is the same:
   make state observable in the source system, not in a side database.

6. **Deploy and iterate on the prompt.** First runs will be wrong in
   specific ways. Add explicit rules to the prompt for each thing the
   team flags. After ~5-10 iterations the bot should be reliably useful.

---

## File map of the reference implementation

| File                                       | What it does                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `netlify/functions/poll-alerts.mjs`        | Scheduled function. Polls Slack, dispatches to background per alert.         |
| `netlify/functions/triage-background.mjs`  | Background function. Runs the Claude agent loop, posts the summary.          |
| `netlify/functions/clear-reactions.mjs`    | Admin endpoint to wipe bot reactions from a specific message.                |
| `src/anthropic.js`                         | The agent loop. Calls Claude, dispatches tools, loops until done.            |
| `src/tools.js`                             | Tool definitions (JSON schemas) and the dispatcher.                          |
| `src/prompt.js`                            | The system prompt. This is where the triage logic lives.                     |
| `src/slack.js`                             | Slack helpers: fetch messages, post, manage reactions, search by history.    |
| `src/metabase.js`                          | Metabase HTTP client. Read-only SQL and saved-question calls.                |
| `netlify.toml`                             | Netlify config: schedule, functions dir, secret scan exclusions.             |
| `package.json`                             | Dependencies. Just three: `@anthropic-ai/sdk`, `@netlify/functions`, `@slack/web-api`. |
| `.env.example`                             | Template for env vars. Copy to `.env` for local dev, or paste into Netlify UI. |
| `README.md`                                | Deployment guide for the specific 32Co instance.                             |
| `BLUEPRINT.md`                             | This file.                                                                   |

---

## Stack summary

- **Runtime**: Node.js 20
- **Hosting**: Netlify (free tier)
- **Source**: GitHub (private repo)
- **LLM**: Claude Sonnet 4.6 via Anthropic API
- **Data**: Metabase HTTP API (which fronts BigQuery, MongoDB, HubSpot)
- **Comms**: Slack Web API via `@slack/web-api`
- **Deps**: 3 npm packages

Total code: ~500 lines of JavaScript + ~600 lines of prompt.
