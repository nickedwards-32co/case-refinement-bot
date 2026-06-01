// Admin utility. Removes the bot's reactions (👀 and 🤖) from a specific
// alert message. Handy for:
//   - Cleaning up test runs
//   - Forcing the bot to re-process an alert
//   - Clearing an orphaned 👀 left on an alert whose triage failed
//
// Does NOT touch ✅ (white_check_mark) -- the clinical team uses that
// for their own resolution workflow.
//
// Usage:
//   https://YOUR-SITE.netlify.app/.netlify/functions/clear-reactions
//     ?ts=1780230186.062159
//     &secret=YOUR_INTERNAL_SECRET
//
// Finding the ts: in Slack, hover the alert message, click the three-dot
// menu, choose "Copy link". The URL ends in /pXXXXXXXXXXXXXXXX. Take that
// string, drop the leading "p", and the endpoint will auto-add the
// decimal point Slack's API expects. Or pass it pre-formatted.

import { makeSlackClient, removeReaction } from "../../src/slack.js";

const DEFAULT_CHANNEL_ID = process.env.SLACK_ALERT_CHANNEL_ID || "C07GGGC5YNM";

export default async (req) => {
  const url = new URL(req.url);
  const tsRaw = url.searchParams.get("ts");
  const secret = url.searchParams.get("secret");
  const channel = url.searchParams.get("channel") || DEFAULT_CHANNEL_ID;

  // Auth: same INTERNAL_SECRET the bot-to-bot dispatch uses. Passed as a
  // URL param here because it's a manual-only admin endpoint.
  const expected = process.env.INTERNAL_SECRET || "";
  if (!expected) {
    return new Response("Server has no INTERNAL_SECRET set; refusing.", { status: 500 });
  }
  if (secret !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  if (!tsRaw) {
    return new Response(
      "Usage: /.netlify/functions/clear-reactions?ts=<message_ts>&secret=<INTERNAL_SECRET>\n" +
        "Optional: &channel=<channel_id> (defaults to the alert channel)\n",
      { status: 400 }
    );
  }

  const ts = normalizeTs(tsRaw);

  let slack;
  try {
    slack = makeSlackClient(process.env.SLACK_BOT_TOKEN);
  } catch (err) {
    return new Response(err.message, { status: 500 });
  }

  const log = [];
  // Only touch the emojis the BOT adds. ✅ is the team's, leave it alone.
  for (const name of ["eyes", "robot_face"]) {
    try {
      await removeReaction(slack, channel, ts, name);
      log.push(`Removed :${name}: from ${ts}`);
    } catch (err) {
      log.push(`Could not remove :${name}: -- ${err.message}`);
    }
  }

  return new Response(log.join("\n") + "\n", { status: 200 });
};

/**
 * Accepts either the API-shaped ts ("1780230186.062159") or the
 * permalink-shaped string ("p1780230186062159" or "1780230186062159"),
 * returns the API-shaped ts.
 */
function normalizeTs(raw) {
  let ts = raw.trim().replace(/^p/i, "");
  if (!ts.includes(".") && ts.length > 6) {
    ts = ts.slice(0, -6) + "." + ts.slice(-6);
  }
  return ts;
}
