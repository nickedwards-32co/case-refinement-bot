// Slack helpers. Uses the official @slack/web-api SDK so we don't have
// to hand-roll API calls. The bot token is read from env at construction
// time so this module stays test-friendly.

import { WebClient } from "@slack/web-api";

// `eyes` (👀) = claimed, `robot_face` (🤖) = posted by the bot.
// We use robot_face for done because the clinical team uses `white_check_mark`
// (✅) for their own resolution workflow and we don't want to step on it.
const PROCESSED_REACTIONS = ["eyes", "robot_face"];
// "Case Refinement Alert" is what the alert bot starts each message with.
// We match loosely (case-insensitive, allowing for emoji prefixes etc).
const ALERT_HEADER_REGEX = /case refinement alert/i;

export function makeSlackClient(token) {
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  return new WebClient(token);
}

/**
 * Pulls recent messages from the alert channel and returns those that:
 *   1. look like Case Refinement Alerts (text or attachment matches)
 *   2. don't already have a "processed" reaction (eyes or white_check_mark)
 *   3. were posted in the last lookbackMinutes minutes (default 90)
 *
 * Returns an array of { ts, channel, text, raw } objects.
 */
export async function findUnprocessedAlerts(client, channelId, lookbackMinutes = 90) {
  const oldest = (Date.now() / 1000) - (lookbackMinutes * 60);

  const history = await client.conversations.history({
    channel: channelId,
    oldest: String(oldest),
    limit: 100,
  });

  const messages = history.messages || [];
  const alerts = [];

  for (const msg of messages) {
    if (msg.subtype === "bot_message" || msg.bot_id || msg.app_id) {
      // Alert bot posts as a bot message. Skip if the text looks like an alert.
      const combinedText = collectMessageText(msg);
      if (!ALERT_HEADER_REGEX.test(combinedText)) continue;

      const reactions = (msg.reactions || []).map((r) => r.name);
      const alreadyProcessed = reactions.some((r) => PROCESSED_REACTIONS.includes(r));
      if (alreadyProcessed) continue;

      alerts.push({
        ts: msg.ts,
        channel: channelId,
        text: combinedText,
        raw: msg,
      });
    }
  }

  return alerts;
}
