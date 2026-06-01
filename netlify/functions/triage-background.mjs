// Background function. Filename ending in `-background` is what tells
// Netlify to run this with the 15-minute timeout (vs the default 26s).
//
// Invoked by poll-alerts.mjs with a JSON body:
//   { channel, alertTs, alertText }
//
// Responsibilities:
//   1. Run the Claude agentic loop to produce a triage summary.
//   2. Claude itself calls slack_post_thread_reply when ready.
//   3. On success, swap the 👀 reaction for ✅. On failure, leave the
//      👀 so we can spot it and either retry or investigate.

import { makeSlackClient, addReaction, removeReaction, postThreadReply } from "../../src/slack.js";
import { MetabaseClient } from "../../src/metabase.js";
import { makeAnthropicClient, runAgent } from "../../src/anthropic.js";
import { SYSTEM_PROMPT, buildUserMessage } from "../../src/prompt.js";

export default async (req) => {
  // Only accept POST.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Shared-secret check.
  const expected = process.env.INTERNAL_SECRET || "";
  if (expected && req.headers.get("x-internal-secret") !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = await req.json();
  } catch (err) {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { channel, alertTs, alertText } = payload;
  if (!channel || !alertTs || !alertText) {
    return new Response("Missing channel / alertTs / alertText", { status: 400 });
  }

  console.log(`[triage-bg] start ts=${alertTs} channel=${channel}`);

  let slack, metabase, anthropic;
  try {
    slack = makeSlackClient(process.env.SLACK_BOT_TOKEN);
    metabase = new MetabaseClient({
      apiKey: process.env.METABASE_API_KEY,
      base: process.env.METABASE_BASE || "https://metabase.32co.com",
      defaultDbId: Number(process.env.METABASE_BIGQUERY_DB_ID || 2),
    });
    anthropic = makeAnthropicClient(process.env.ANTHROPIC_API_KEY);
  } catch (err) {
    console.error("[triage-bg] init failed:", err.message);
    await notifyFailure(slack, channel, alertTs, `Bot init failed: ${err.message}`);
    return new Response("init failed", { status: 500 });
  }

  const ctx = {
    metabase,
    slack,
    channel,
    threadTs: alertTs,
    summaryPosted: false,
  };

  try {
    const result = await runAgent({
      client: anthropic,
      systemPrompt: SYSTEM_PROMPT,
      userMessage: buildUserMessage({ alertText, channelId: channel, alertTs }),
      ctx,
      log: (msg) => console.log(msg),
    });

    if (!result.summaryPosted) {
      // Claude finished without posting. Surface its final text as a fallback.
      console.warn("[triage-bg] Claude ended turn without posting; using fallback.");
      const fallback = result.finalText || "Triage bot finished without producing a summary.";
      await postThreadReply(slack, channel, alertTs, fallback);
    }

    // Swap reactions. 🤖 = bot has posted (the clinical team uses ✅ for
    // their own resolution workflow, so we use a different emoji to avoid
    // interfering with it).
    try {
      await removeReaction(slack, channel, alertTs, "eyes");
      await addReaction(slack, channel, alertTs, "robot_face");
    } catch (err) {
      console.warn("[triage-bg] reaction swap failed:", err.message);
    }

    console.log(`[triage-bg] success ts=${alertTs}`);
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[triage-bg] agent failed:", err);
    await notifyFailure(slack, channel, alertTs, err?.message || String(err));
    return new Response("agent failed", { status: 500 });
  }
};

async function notifyFailure(slack, channel, alertTs, reason) {
  if (!slack) return;
  try {
    await postThreadReply(
      slack,
      channel,
      alertTs,
      `:warning: Triage bot failed to produce a summary. Reason: ${reason}\n` +
        `Please triage this alert manually. The 👀 reaction is left in place to flag it.`
    );
  } catch (err) {
    console.error("[triage-bg] notifyFailure post failed:", err.message);
  }
}

// Tell Netlify this is a background function (also signalled by filename).
export const config = { type: "background" };
