// Wraps Anthropic's API in an agentic tool-use loop. Pass in a system
// prompt, an initial user message, and a tool dispatcher; the loop runs
// until Claude returns an end_turn with no further tool_use, or until
// MAX_ITERATIONS is hit (safety net).

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFS, dispatchTool } from "./tools.js";

const MAX_ITERATIONS = 40;
const DEFAULT_MODEL = "claude-sonnet-4-6";

export function makeAnthropicClient(apiKey) {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  return new Anthropic({ apiKey });
}

export async function runAgent({
  client,
  systemPrompt,
  userMessage,
  ctx,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  log = console.log,
}) {
  const messages = [{ role: "user", content: userMessage }];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    log(`[agent] iteration ${iter + 1}: calling Claude...`);

    const response = await client.messages.create({
      model,
      // Generous room for the final summary message. A long triage with
      // 3+ refinements + full Notes / Triage / Suggested actions can run
      // ~6-8k output tokens. Allow well over that so the model never has
      // to split.
      max_tokens: 16000,
      system: systemPrompt,
      tools: TOOL_DEFS,
      messages,
    });

    const stopReason = response.stop_reason;
    const assistantBlocks = response.content;

    // Persist Claude's response in the conversation history.
    messages.push({ role: "assistant", content: assistantBlocks });

    // Collect any tool_use blocks Claude emitted this turn.
    const toolUses = assistantBlocks.filter((b) => b.type === "tool_use");

    if (toolUses.length === 0) {
      // No tool calls => Claude is done. Bail.
      log(`[agent] done after ${iter + 1} iterations (stop_reason=${stopReason})`);
      return {
        messages,
        finalText: collectText(assistantBlocks),
        summaryPosted: ctx.summaryPosted === true,
      };
    }

    // Run each tool, queue results in a single user message.
    const toolResultBlocks = [];
    for (const block of toolUses) {
      log(`[agent] tool_use: ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
      const result = await dispatchTool(block, ctx);
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.ok
          ? JSON.stringify(result.output ?? null)
          : `ERROR: ${result.error}`,
        is_error: result.ok ? undefined : true,
      });
    }
    messages.push({ role: "user", content: toolResultBlocks });
  }

  throw new Error(`Agent did not finish within ${MAX_ITERATIONS} iterations.`);
}

function collectText(blocks) {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
