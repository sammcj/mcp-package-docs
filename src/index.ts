#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import axios, { AxiosError } from "axios";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const execAsync = promisify(exec);

interface DocResult {
  description?: string;
  usage?: string;
  example?: string;
  error?: string;
}

interface GoDocArgs {
  package: string;
  symbol?: string;
}

interface PythonDocArgs {
  package: string;
  symbol?: string;
}

interface NpmDocArgs {
  package: string;
  version?: string;
}

const isGoDocArgs = (args: unknown): args is GoDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as GoDocArgs).package === "string" &&
    (typeof (args as GoDocArgs).symbol === "string" ||
      (args as GoDocArgs).symbol === undefined)
  );
};

const isPythonDocArgs = (args: unknown): args is PythonDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as PythonDocArgs).package === "string" &&
    (typeof (args as PythonDocArgs).symbol === "string" ||
      (args as PythonDocArgs).symbol === undefined)
  );
};

const isNpmDocArgs = (args: unknown): args is NpmDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as NpmDocArgs).package === "string" &&
    (typeof (args as NpmDocArgs).version === "string" ||
      (args as NpmDocArgs).version === undefined)
  );
};

class PackageDocsServer {
  private server: Server;
  private cache: Map<string, DocResult>;

  constructor() {
    this.server = new Server(
      {
        name: "mcp-package-docs",
        version: packageJson.version,
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.cache = new Map();
    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "lookup_go_doc",
          description: "Look up Go package documentation",
          inputSchema: {
            type: "object",
            properties: {
              package: {
                type: "string",
                description: "Full package import path (e.g. encoding/json)",
              },
              symbol: {
                type: "string",
                description:
                  "Optional symbol name to look up specific documentation",
              },
            },
            required: ["package"],
          },
        },
        {
          name: "lookup_python_doc",
          description: "Look up Python package documentation",
          inputSchema: {
            type: "object",
            properties: {
              package: {
                type: "string",
                description: "Package name (e.g. requests)",
              },
              symbol: {
                type: "string",
                description:
                  "Optional symbol name to look up specific documentation",
              },
            },
            required: ["package"],
          },
        },
        {
          name: "lookup_npm_doc",
          description: "Look up NPM package documentation",
          inputSchema: {
            type: "object",
            properties: {
              package: {
                type: "string",
                description: "Package name (e.g. axios)",
              },
              version: {
                type: "string",
                description: "Optional package version",
              },
            },
            required: ["package"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params.arguments) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments are required");
      }

      const cacheKey = JSON.stringify(request.params);
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        return {
          content: [
            { type: "text", text: JSON.stringify(cachedResult, null, 2) },
          ],
        };
      }

      let result: DocResult;

      switch (request.params.name) {
        case "lookup_go_doc":
          if (!isGoDocArgs(request.params.arguments)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid arguments for Go documentation lookup",
            );
          }
          result = await this.lookupGoDoc(
            request.params.arguments.package,
            request.params.arguments.symbol,
          );
          break;
        case "lookup_python_doc":
          if (!isPythonDocArgs(request.params.arguments)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid arguments for Python documentation lookup",
            );
          }
          result = await this.lookupPythonDoc(
            request.params.arguments.package,
            request.params.arguments.symbol,
          );
          break;
        case "lookup_npm_doc":
          if (!isNpmDocArgs(request.params.arguments)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid arguments for NPM documentation lookup",
            );
          }
          result = await this.lookupNpmDoc(
            request.params.arguments.package,
            request.params.arguments.version,
          );
          break;
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`,
          );
      }

      this.cache.set(cacheKey, result);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    });
  }

  private async lookupGoDoc(
    packageName: string,
    symbol?: string,
  ): Promise<DocResult> {
    try {
      const cmd = symbol
        ? `go doc ${packageName}.${symbol}`
        : `go doc ${packageName}`;
      const { stdout } = await execAsync(cmd);

      // Parse the go doc output into a structured format
      const lines = stdout.split("\n");
      const result: DocResult = {};

      let section: "description" | "usage" | "example" = "description";
      let content: string[] = [];

      for (const line of lines) {
        if (line.startsWith("func") || line.startsWith("type")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim();
          }
          section = "usage";
          content = [line];
        } else if (line.includes("Example")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim();
          }
          section = "example";
          content = [];
        } else {
          content.push(line);
        }
      }

      if (content.length > 0) {
        result[section] = content.join("\n").trim();
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        error: `Failed to fetch Go documentation: ${errorMessage}`,
      };
    }
  }

  private async lookupPythonDoc(
    packageName: string,
    symbol?: string,
  ): Promise<DocResult> {
    try {
      const pythonCode = symbol
        ? `
import ${packageName}
help(${packageName}.${symbol})
`
        : `
import ${packageName}
help(${packageName})
`;

      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`);

      // Parse the Python help output into a structured format
      const lines = stdout.split("\n");
      const result: DocResult = {};

      let section: "description" | "usage" | "example" = "description";
      let content: string[] = [];

      for (const line of lines) {
        if (line.startsWith("class") || line.startsWith("def")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim();
          }
          section = "usage";
          content = [line];
        } else if (line.includes("Examples:") || line.includes("Example:")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim();
          }
          section = "example";
          content = [];
        } else {
          content.push(line);
        }
      }

      if (content.length > 0) {
        result[section] = content.join("\n").trim();
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        error: `Failed to fetch Python documentation: ${errorMessage}`,
      };
    }
  }

  private async lookupNpmDoc(
    packageName: string,
    version?: string,
  ): Promise<DocResult> {
    try {
      // Fetch package info from npm registry
      const response = await axios.get(
        `https://registry.npmjs.org/${packageName}${version ? `/${version}` : ""}`,
      );

      const { description, readme } = response.data;
      const result: DocResult = {
        description,
      };

      if (readme) {
        // Extract usage and examples from README
        const sections = readme.split(/#+\s/);
        for (const section of sections) {
          const lower = section.toLowerCase();
          if (
            lower.startsWith("usage") ||
            lower.startsWith("getting started")
          ) {
            result.usage = section.split("\n").slice(1).join("\n").trim();
          } else if (lower.startsWith("example")) {
            result.example = section.split("\n").slice(1).join("\n").trim();
          }
        }
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof AxiosError
          ? error.response?.data?.message || error.message
          : String(error);
      return {
        error: `Failed to fetch NPM documentation: ${errorMessage}`,
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(
      "Package Docs MCP server running on stdio, version:",
      packageJson.version,
    );
  }
}

const server = new PackageDocsServer();
server.run().catch(console.error);
