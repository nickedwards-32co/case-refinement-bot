# 32Co Case Refinement Triage Bot

Auto-triages "Case Refinement Alert" messages in
`#unhappy-dentist-proactive`. Runs on Netlify scheduled functions.
Every 15 minutes it checks the channel for new alerts, claims each with
a 👀 reaction, gathers context from Metabase + Slack, asks Claude to
write a triage summary, and posts it in the alert thread. Successful
alerts get a ✅ reaction so the bot never double-processes anything.

The prompt logic lives in `src/prompt.js` and mirrors
`case_refinement_alert_auto_summary_prompt.md` in the parent Claude
project. Update both together when iterating on the bot's behaviour.

## How it works (architecture)

Two Netlify functions:

- `poll-alerts.mjs` (scheduled, runs every 15 min)
  Pulls recent messages from the alert channel, filters to unprocessed
  Case Refinement Alerts, claims each with 👀, then dispatches each one
  to the background function. Returns in a couple of seconds.

- `triage-background.mjs` (background, up to 15 min runtime)
  Receives one alert via POST. Runs the Claude agentic loop with four
  tools (`metabase_sql`, `metabase_question`, `slack_search_messages`,
  `slack_post_thread_reply`). Claude orchestrates data gathering and
  writes the summary; the function posts it and swaps 👀 for ✅.

Why two functions? Netlify's normal/scheduled functions cap at 26
seconds. Triage easily takes longer because of the many tool calls.
Background functions have a 15-minute cap, but can't be put on a cron
directly, so we use the scheduled poller to dispatch them.

## What you need before deploying

Three credentials (all already set up):

| Name                | Where                              |
| ------------------- | ---------------------------------- |
| Anthropic API key   | console.anthropic.com / API Keys   |
| Slack bot token     | api.slack.com / Your Apps          |
| Metabase API key    | metabase.32co.com / Account / API  |

A 32Co GitHub account that can create repos under your name or under
the company org. And a Netlify account with permission to connect a new
site (you already have one).

## Deploy guide (no command line required)

### 1. Put this folder on GitHub

The easiest path if you don't want to use Git on the command line:

1. Go to https://github.com/new
2. Create a repo named `case-refinement-bot`. Leave it private. Do
   **not** initialise it with a README, .gitignore, or licence (we
   already have those).
3. On the next screen, GitHub offers an "Uploading an existing file"
   link. Click that.
4. Drag and drop the entire contents of this folder (the files, not the
   folder itself) into the upload box. Commit straight to `main`.

### 2. Connect to Netlify

1. Go to https://app.netlify.com → **Add new site** → **Import from
   Git**.
2. Choose **GitHub** and authorise if you haven't yet. Pick the new
   `case-refinement-bot` repo.
3. On the "Site settings for case-refinement-bot" page, **leave the
   build settings as defaults**. Netlify reads `netlify.toml` so it
   knows what to do.
4. Click **Deploy site**.

The first deploy will fail to do anything useful because the
environment variables aren't set yet. That's expected.

### 3. Add environment variables

In Netlify: **Site settings → Environment variables → Add a variable**.
Add each of these (mark them all as secret):

| Variable                              | Value                                          |
| ------------------------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`                   | your `sk-ant-...` key                          |
| `METABASE_API_KEY`                    | your `mb_...` key                              |
| `METABASE_BASE`                       | `https://metabase.32co.com`                    |
| `METABASE_BIGQUERY_DB_ID`             | `2`                                            |
| `SLACK_BOT_TOKEN`                     | your `xoxb-...` bot token                      |
| `SLACK_ALERT_CHANNEL_ID`              | `C07GGGC5YNM`                                  |
| `SLACK_CLINICAL_SUPPORT_SUBTEAM_ID`   | `S06JU8HCJ4A`                                  |
| `INTERNAL_SECRET`                     | any random string -- pick one, save it         |
| `ANTHROPIC_MODEL`                     | `claude-sonnet-4-6` (optional)                 |

After saving, click **Deploys** in the left nav, then **Trigger
deploy → Deploy site** to redeploy with the new variables.

### 4. Confirm the schedule is wired up

In Netlify: **Functions → poll-alerts**. You should see a "Scheduled"
badge and the cron expression `*/15 * * * *`. If not, redeploy.

### 5. Test it

Easiest test:

1. Have someone (or your test bot) post a fake Case Refinement Alert in
   the channel, OR pick a recent real one that's already been triaged
   and remove its existing reactions so the bot picks it up.
2. Wait up to 15 minutes for the next scheduled run.
3. The bot should add 👀 to the alert within seconds of the schedule
   tick, then post a triage reply 30-120 seconds later, then swap 👀
   for ✅.

If something looks wrong:

- **Functions tab → poll-alerts → View logs** shows every tick.
- **Functions tab → triage-background → View logs** shows every triage
  run.

### 6. Turn off the Cowork scheduled tasks

Once the Netlify bot has run cleanly for a few alerts, disable the two
Cowork scheduled tasks (the "business hours" one and the "overnight"
one) so the same alerts don't get triaged twice.

## Iterating on the prompt

The prompt lives in `src/prompt.js`. To update the bot's behaviour:

1. Edit `src/prompt.js`.
2. Commit and push to GitHub. Netlify auto-deploys on push, normally
   within 60 seconds.

There's also `case_refinement_alert_auto_summary_prompt.md` in the
parent project folder. That's the human-readable spec the prompt is
derived from. Keep them in sync.

## Cost expectations

- Netlify free tier: 125,000 function invocations / month. We run about
  2,900 schedule ticks / month plus one background invocation per
  alert (let's say 300). Well under the limit.
- Anthropic API: each triage uses Sonnet for the full agentic loop.
  Rough cost per alert: 5-20 cents. At 5-15 alerts/day that's roughly
  $20-80/month total.
- Slack and Metabase: free.

## Local development

Optional. If you have Node 20+ installed:

```bash
npm install
npm install -g netlify-cli
netlify dev
```

This runs the functions locally so you can hit them with `curl` to
test. The cron schedule won't fire locally; use `netlify functions:invoke
poll-alerts` to trigger a manual poll.

## Troubleshooting

**Bot doesn't react to a new alert.** Check the poll-alerts logs. If
the function isn't running on schedule, redeploy. If it runs but
doesn't see the alert, verify the bot has been invited to
`#unhappy-dentist-proactive` (`/invite @Case Refinement Triage Bot`).

**Bot reacts with 👀 but never posts a summary.** Check
triage-background logs. Most common failures: Metabase auth (rotate
the key), Anthropic auth, or a model-side timeout. The failure handler
will post a `:warning:` reply in the thread with the reason.

**Bot posts but formatting is off.** The Slack MCP rules don't apply
here: this bot posts via the Web API directly. Markdown conversion is
slightly different (mostly the same, but worth knowing). Most issues
boil down to the prompt instructions. Edit `src/prompt.js`.
