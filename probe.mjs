import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await client.beta.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  betas: ["mcp-client-2025-11-20"],
  mcp_servers: [
    {
      type: "url",
      url: process.env.SILLAGE_MCP_URL,
      name: "sillage",
      authorization_token: process.env.SILLAGE_MCP_TOKEN,
    },
  ],
  tools: [{ type: "mcp_toolset", mcp_server_name: "sillage" }],
  messages: [
    {
      role: "user",
      content: "List your available tools.",
    },
  ],
});

console.dir(response.content, { depth: null });
