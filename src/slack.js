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

/**
 * Joins all the text in a Slack message: top-level `text` field plus the
 * text/fallback of any attachments and blocks. The alert bot posts most
 * of its detail inside attachments rather than the message body.
 */
export function collectMessageText(msg) {
  const parts = [];

  if (msg.text) parts.push(msg.text);

  for (const att of msg.attachments || []) {
    if (att.fallback) parts.push(att.fallback);
    if (att.pretext) parts.push(att.pretext);
    if (att.text) parts.push(att.text);
    if (att.title) parts.push(att.title);
    for (const field of att.fields || []) {
      parts.push(`${field.title || ""}: ${field.value || ""}`);
    }
  }

  for (const block of msg.blocks || []) {
    parts.push(extractBlockText(block));
  }

  return parts.filter(Boolean).join("\n");
}

function extractBlockText(block) {
  if (!block) return "";
  if (block.type === "section" && block.text) return block.text.text || "";
  if (block.type === "header" && block.text) return block.text.text || "";
  if (block.type === "context") {
    return (block.elements || []).map((e) => e.text || "").join(" ");
  }
  if (block.type === "rich_text") {
    return JSON.stringify(block.elements || []);
  }
  return "";
}

export async function addReaction(client, channel, ts, name) {
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
  } catch (err) {
    // If the reaction already exists, ignore.
    if (err?.data?.error !== "already_reacted") throw err;
  }
}

export async function removeReaction(client, channel, ts, name) {
  try {
    await client.reactions.remove({ channel, timestamp: ts, name });
  } catch (err) {
    if (err?.data?.error !== "no_reaction") throw err;
  }
}

export async function postThreadReply(client, channel, threadTs, text) {
  return await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: markdownToSlackMrkdwn(text),
    mrkdwn: true,
  });
}

/**
 * Convert standard markdown (what Claude was instructed to produce) into
 * Slack's native mrkdwn. Slack's mrkdwn is NOT the same as CommonMark:
 *   - bold:    `*text*`           (Slack)   vs  `**text**`        (md)
 *   - link:    `<URL|text>`       (Slack)   vs  `[text](URL)`     (md)
 *   - italic:  `_text_`           (Slack)   vs  `*text*` / `_text_` (md)
 * Bullets (`- `), inline code (`` ` ``), and code blocks (``` ```) are the
 * same in both, so we leave them alone.
 *
 * Special handling: anything already wrapped in `<...>` is a Slack token
 * (subteam mention, user mention, channel ref) and must pass through
 * untouched -- our regexes are written to avoid matching them.
 */
export function markdownToSlackMrkdwn(text) {
  let out = text;

  // 1. Links: [text](url) -> <url|text>. Do this BEFORE bold so the
  //    inner contents don't get mangled.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "<$2|$1>");

  // 2. Bold: **text** -> *text*. Use a non-greedy match. Avoid eating
  //    `**` that's adjacent to another asterisk (rare in practice).
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // 3. Horizontal rule lines (`---` on their own line) are not native
  //    Slack syntax. Replace with an em-dash divider so they render as
  //    a visible separator.
  out = out.replace(/^---\s*$/gm, "———");

  return out;
}

/**
 * Search messages across channels via Slack's search.messages API.
 * Used by Claude when it wants prior context on a dentist or patient.
 */
export async function searchMessages(client, query) {
  const result = await client.search.messages({ query, count: 20, sort: "timestamp" });
  return (result.messages?.matches || []).map((m) => ({
    channel: m.channel?.name || m.channel?.id,
    user: m.username || m.user,
    ts: m.ts,
    text: m.text,
    permalink: m.permalink,
  }));
}
