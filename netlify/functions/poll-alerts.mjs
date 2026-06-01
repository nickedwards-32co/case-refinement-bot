// Scheduled function. Runs every 15 minutes (cron set in netlify.toml).
//
// Job:
//   1. Pull recent messages from #unhappy-dentist-proactive
//   2. Filter to Case Refinement Alerts that haven't been processed yet
//   3. For each, claim with a 👀 reaction and dispatch to the background
//      function which does the actual triage.
//
// We do the dispatch by calling the background function's HTTPS URL,
// which returns immediately (Netlify queues the background job).
// That keeps THIS function's runtime to a few seconds.

import { makeSlackClient, findUnprocessedAlerts, addReaction } from "../../src/slack.js";

const ALERT_CHANNEL_ID = process.env.SLACK_ALERT_CHANNEL_ID || "C07GGGC5YNM";

// How far back to scan Slack each tick. 360 min (6h) is plenty for
// normal operation -- the bot polls every 15 min and the reaction-based
// skip stops anything from being re-processed. Override LOOKBACK_MINUTES
// for one-off testing if you want to reach back further.
const LOOKBACK_MINUTES = Number(process.env.LOOKBACK_MINUTES || 360);

export default async (req) => {
  console.log("[poll-alerts] tick", new Date().toISOString());

  let slack;
  try {
    slack = makeSlackClient(process.env.SLACK_BOT_TOKEN);
  } catch (err) {
    console.error("[poll-alerts] Slack client init failed:", err.message);
    return new Response(err.message, { status: 500 });
  }

  let alerts;
  try {
    alerts = await findUnprocessedAlerts(slack, ALERT_CHANNEL_ID, LOOKBACK_MINUTES);
  } catch (err) {
    console.error("[poll-alerts] Slack history fetch failed:", err.message);
    return new Response(err.message, { status: 500 });
  }

  console.log(`[poll-alerts] found ${alerts.length} unprocessed alerts`);

  if (alerts.length === 0) {
    return new Response("no new alerts", { status: 200 });
  }

  // Resolve the background function's URL from Netlify's standard env vars.
  const selfUrl =
    process.env.SELF_URL ||
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    "";
  if (!selfUrl) {
    console.error("[poll-alerts] No SELF_URL / URL env var set; cannot dispatch background.");
    return new Response("missing SELF_URL", { status: 500 });
  }

  for (const alert of alerts) {
    // Claim the alert immediately so the next tick doesn't pick it up
    // again if this dispatch races.
    try {
      await addReaction(slack, alert.channel, alert.ts, "eyes");
    } catch (err) {
      console.error(`[poll-alerts] add reaction failed for ts=${alert.ts}:`, err.message);
      continue;
    }

    const url = `${selfUrl.replace(/\/$/, "")}/.netlify/functions/triage-background`;
    console.log(`[poll-alerts] dispatching to ${url} for ts=${alert.ts}`);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": process.env.INTERNAL_SECRET || "",
        },
        body: JSON.stringify({
          channel: alert.channel,
          alertTs: alert.ts,
          alertText: alert.text,
        }),
      });

      // Background functions return 202 Accepted immediately.
      if (!res.ok && res.status !== 202) {
        console.error(`[poll-alerts] dispatch returned ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[poll-alerts] dispatch failed for ts=${alert.ts}:`, err.message);
    }
  }

  return new Response(`dispatched ${alerts.length}`, { status: 200 });
};

// Schedule is also declared here so it travels with the function code.
// netlify.toml has the same schedule -- they should match.
export const config = {
  schedule: "*/15 * * * *",
};
