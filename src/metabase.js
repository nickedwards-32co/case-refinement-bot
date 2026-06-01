// Thin Metabase HTTP client. Talks to the same endpoints the
// metabase-mcp server hits: /api/dataset for SQL, /api/card/{id}/query
// for saved questions.
//
// All requests need Cloudflare-friendly headers (the default Node fetch
// User-Agent gets blocked by Cloudflare with error 1010), so we set a
// Chrome UA on every request. Identical workaround to the MCP.

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const READ_ONLY_REGEX = /^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(select|with)\b/i;
const FORBIDDEN_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|replace)\b/i;

export class MetabaseClient {
  constructor({ apiKey, base, defaultDbId }) {
    if (!apiKey) throw new Error("METABASE_API_KEY is not set");
    if (!base) throw new Error("METABASE_BASE is not set");
    this.apiKey = apiKey;
    this.base = base.replace(/\/$/, "");
    this.defaultDbId = defaultDbId || 2;
  }

  headers() {
    return {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
      "User-Agent": CHROME_UA,
      Accept: "application/json",
    };
  }

  /**
   * Run a read-only SQL query against the warehouse.
   *
   * Guardrail: only SELECT / WITH statements are allowed, and we reject
   * obvious mutating keywords. The Metabase user the API key belongs to
   * should ALSO be read-only -- defence in depth.
   */
  async executeSql({ sql, databaseId, rowLimit = 1000 }) {
    if (!READ_ONLY_REGEX.test(sql)) {
      throw new Error("Only SELECT / WITH queries are allowed.");
    }
    if (FORBIDDEN_KEYWORDS.test(sql)) {
      throw new Error("Query rejected: contains a mutating keyword.");
    }

    const dbId = databaseId || this.defaultDbId;
    const url = `${this.base}/api/dataset`;
    const body = {
      database: dbId,
      type: "native",
      native: { query: sql },
      constraints: { "max-results": rowLimit, "max-results-bare-rows": rowLimit },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase /api/dataset returned ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    return shapeDatasetResponse(data);
  }

  /**
   * Run a saved Metabase question by ID. Mongo queries go through
   * this path because the Mongo connector doesn't accept ad-hoc SQL.
   *
   * parameters is the same shape Metabase's UI sends, e.g.:
   *   [{ type: "category", target: ["variable", ["template-tag", "patient_id"]], value: "abc" }]
   */
  async executeQuestion({ cardId, parameters = [] }) {
    const url = `${this.base}/api/card/${cardId}/query/json`;
    const body = { parameters };
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase /api/card/${cardId}/query returned ${res.status}: ${text.slice(0, 500)}`);
    }
    return await res.json();
  }
}

function shapeDatasetResponse(raw) {
  const dataBlock = raw?.data || {};
  const cols = (dataBlock.cols || []).map((c) => c.name);
  const rawRows = dataBlock.rows || [];
  const rows = rawRows.map((r) => {
    const obj = {};
    cols.forEach((c, i) => {
      obj[c] = r[i];
    });
    return obj;
  });
  return {
    rowCount: rows.length,
    columns: cols,
    rows,
  };
}
