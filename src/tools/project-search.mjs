/**
 * search_project builtin: semantic retrieval over the local project index.
 */

import { DEFAULT_EMBEDDING_MODEL, searchProjectIndex } from "../project-index.mjs";

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {{embed: Function}} options.client
 * @param {string} [options.embeddingModel]
 */
export function registerProjectSearchTool(
  registry,
  { workspaceRoot, client, embeddingModel = DEFAULT_EMBEDDING_MODEL },
) {
  registry.register({
    name: "search_project",
    description:
      "Search indexed project documentation (README, ROADMAP, package.json, markdown) by meaning. Returns the most relevant passages. Use for questions about how this project works when the overview is not enough.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for in project docs." },
        top_k: {
          type: "integer",
          description: "How many passages to return (default 5).",
        },
      },
      required: ["query"],
    },
    async execute({ query, top_k }) {
      const results = await searchProjectIndex({
        workspaceRoot,
        query,
        client,
        embeddingModel,
        topK: top_k ?? 5,
      });
      if (!results) {
        return { error: "search_project requires an embedding client; index may be unavailable." };
      }
      if (results.length === 0) {
        return "No indexed project passages matched. Try read_file on README.md or rebuild by restarting Bitfield Ollama Agent.";
      }
      return results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.path} (chunk ${r.index}, score ${r.score.toFixed(3)})\n${r.text}`,
        )
        .join("\n\n---\n\n");
    },
  });
}
