#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from './logger.js'
import { PackageDocsServer } from './package-docs-server.js';

// Initialise and run the server
async function main() {
  try {
    const server = new PackageDocsServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Package docs MCP server running on stdio");
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error("Unhandled error:", error);
  process.exit(1);
});
