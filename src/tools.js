// Defines the tools available to Claude during a triage run, and the
// dispatcher that routes a tool_use block to the right helper.
//
// Each tool here mirrors what the Cowork bot has via MCPs, but exposed
// via the Anthropic API's tool-use schema rather than through MCP.

export const TOOL_DEFS = [
  {
    name: "metabase_sql",
    description:
      "Run a read-only SQL query against 32Co's BigQuery warehouse via Metabase. " +
      "Supports SELECT and WITH only. Use this for the `co-7465a.mongoprod.*`, " +
      "`co-7465a.metabase_models.*`, and `co-7465a.hubspot.*` tables. " +
      "Returns an object with rowCount, columns, and rows.",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "The SQL query (SELECT / WITH only).",
        },
        database_id: {
          type: "integer",
          description: "Metabase database ID. Defaults to 2 (BigQuery).",
        },
        row_limit: {
          type: "integer",
          description: "Maximum rows to return. Defaults to 1000.",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "metabase_question",
    description:
      "Run a saved Metabase question by ID. Use for Mongo-backed queries " +
      "where ad-hoc SQL is not supported (e.g. the Submissions collection " +
      "via card 5196). Parameters use Metabase's template-tag shape: " +
      "[{ type: 'category', target: ['variable', ['template-tag', 'patient_id']], value: '...' }].",
    input_schema: {
      type: "object",
      properties: {
        card_id: { type: "integer", description: "Metabase card ID." },
        parameters: {
          type: "array",
          description: "Parameter array in Metabase's template-tag format.",
          items: { type: "object" },
        },
      },
      required: ["card_id"],
    },
  },
  {
    name: "slack_search_messages",
    description:
      "Search recent Slack messages in ONE channel at a time. Pass a " +
      "channel_id (Slack ID like C07GGGC5YNM) plus a `terms` string -- " +
      "every space-separated word in `terms` must appear in the message " +
      "(case-insensitive substring match). Returns up to 20 most recent " +
      "matches with constructed permalinks. Default lookback is 30 days; " +
      "override with `lookback_days`. Call multiple times to cover " +
      "multiple channels. Channel IDs are in the prompt's Slack section.",
    input_schema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Slack channel ID, e.g. C07GGGC5YNM.",
        },
        terms: {
          type: "string",
          description:
            "Space-separated terms. ALL must appear in the message text.",
        },
        lookback_days: {
          type: "integer",
          description: "Days of history to scan. Default 30.",
        },
      },
      required: ["channel_id", "terms"],
    },
  },
  {
    name: "slack_post_thread_reply",
    description:
      "Post the final triage summary as a reply in the alert thread. " +
      "Use this exactly once per triage, at the end of your analysis. " +
      "Text uses standard markdown -- the bot handles Slack conversion.",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Markdown body of the reply.",
        },
      },
      required: ["text"],
    },
  },
];

/**
 * Dispatches a single tool_use block to the right helper. Returns a
 * structured result that we'll feed back to Claude as the tool_result.
 *
 * @param {object} block      Anthropic tool_use content block
 * @param {object} ctx        { metabase, slack, channel, threadTs }
 * @returns {object}          { ok: boolean, output?: any, error?: string }
 */
export async function dispatchTool(block, ctx) {
  const { name, input } = block;

  try {
    if (name === "metabase_sql") {
      const result = await ctx.metabase.executeSql({
        sql: input.sql,
        databaseId: input.database_id,
        rowLimit: input.row_limit ?? 1000,
      });
      return { ok: true, output: truncateForClaude(result) };
    }

    if (name === "metabase_question") {
      const result = await ctx.metabase.executeQuestion({
        cardId: input.card_id,
        parameters: input.parameters || [],
      });
      return { ok: true, output: truncateForClaude(result) };
    }

    if (name === "slack_search_messages") {
      const { searchMessagesInChannel } = await import("./slack.js");
      const result = await searchMessagesInChannel(ctx.slack, {
        channelId: input.channel_id,
        terms: input.terms,
        lookbackDays: input.lookback_days || 30,
      });
      return { ok: true, output: result };
    }

    if (name === "slack_post_thread_reply") {
      const { postThreadReply } = await import("./slack.js");
      const posted = await postThreadReply(
        ctx.slack,
        ctx.channel,
        ctx.threadTs,
        input.text
      );
      ctx.summaryPosted = true;
      return {
        ok: true,
        output: {
          ts: posted.ts,
          permalink: `https://frontiercoworkspace.slack.com/archives/${ctx.channel}/p${String(posted.ts).replace(".", "")}`,
        },
      };
    }

    return { ok: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// Anthropic message-size limit + cost / clarity reasons: we shouldn't
// feed back enormous query results. Truncate verbosely so Claude knows
// we trimmed.
function truncateForClaude(result, maxRows = 50) {
  if (result?.rows && Array.isArray(result.rows) && result.rows.length > maxRows) {
    return {
      ...result,
      rows: result.rows.slice(0, maxRows),
      truncated: `Truncated to first ${maxRows} of ${result.rows.length} rows.`,
    };
  }
  return result;
}
