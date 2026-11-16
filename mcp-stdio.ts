import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCutCheckMcpServer } from './server/mcpServer.ts';

async function main(): Promise<void> {
  const port = Number(process.env.PORT || 3000);
  const baseUrl = process.env.APP_URL || `http://localhost:${port}`;
  const server = createCutCheckMcpServer({
    transport: 'stdio',
    getBaseUrl: () => baseUrl,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`CutCheck MCP stdio fatal error: ${String(err)}\n`);
  process.exit(1);
});
