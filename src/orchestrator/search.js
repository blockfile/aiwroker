// Web search via the Brave Search API. Runs on the orchestrator so the API key
// stays server-side — workers ask the orchestrator to search, never hold the key.

// The tool definition handed to the model. When it needs current info it emits a
// tool call with a { query } argument.
export const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current, real-time information. Use this for recent events, ' +
      'news, prices, people, or anything that may have changed after your training cutoff.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
      },
      required: ['query'],
    },
  },
};

export async function braveSearch(query, apiKey, { count = 5, signal } = {}) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal,
  });
  if (!res.ok) throw new Error(`Brave Search ${res.status}`);
  const data = await res.json();
  return (data.web?.results || []).slice(0, count).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));
}

// Turn results into a compact text block for the model to read.
export function formatResults(results, query) {
  if (!results || results.length === 0) return `No web results found for "${query}".`;
  return (
    `Web search results for "${query}":\n\n` +
    results
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${stripTags(r.description || '')}`)
      .join('\n\n')
  );
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, '');
}
