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
import Fuse from "fuse.js";

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
  searchResults?: SearchResults;
}

interface SearchResults {
  results: SearchResult[];
  totalResults: number;
}

interface SearchResult {
  symbol?: string;
  match: string;
  context: string;
  score: number;
}

interface SearchDocArgs {
  package: string;
  query: string;
  language: "go" | "python" | "npm";
  fuzzy?: boolean;
}

const isSearchDocArgs = (args: unknown): args is SearchDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as SearchDocArgs).package === "string" &&
    typeof (args as SearchDocArgs).query === "string" &&
    ["go", "python", "npm"].includes((args as SearchDocArgs).language) &&
    (typeof (args as SearchDocArgs).fuzzy === "boolean" ||
      (args as SearchDocArgs).fuzzy === undefined)
  );
};

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
          name: "search_package_docs",
          description: "Search for symbols or content within package documentation",
          inputSchema: {
            type: "object",
            properties: {
              package: {
                type: "string",
                description: "Package name to search within"
              },
              query: {
                type: "string",
                description: "Search query"
              },
              language: {
                type: "string",
                enum: ["go", "python", "npm"],
                description: "Package language/ecosystem"
              },
              fuzzy: {
                type: "boolean",
                description: "Enable fuzzy matching",
                default: true
              }
            },
            required: ["package", "query", "language"]
          }
        },
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
        case "search_package_docs":
          if (!isSearchDocArgs(request.params.arguments)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Invalid arguments for package documentation search"
            );
          }
          result = {
            searchResults: await this.searchPackageDocs(
              request.params.arguments.package,
              request.params.arguments.query,
              request.params.arguments.language,
              request.params.arguments.fuzzy
            )
          };
          break;
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

  private async searchPackageDocs(
    packageName: string,
    query: string,
    language: "go" | "python" | "npm",
    fuzzy: boolean = true
  ): Promise<{ results: SearchResult[]; totalResults: number }> {
    try {
      let fullDoc: string;

      // Get full documentation based on language
      switch (language) {
        case "go":
          const { stdout: goDoc } = await execAsync(`go doc -all ${packageName}`);
          fullDoc = goDoc;
          break;
        case "python":
          const pythonCode = `
import ${packageName}
help(${packageName})
`;
          const { stdout: pythonDoc } = await execAsync(`python3 -c "${pythonCode}"`);
          fullDoc = pythonDoc;
          break;
        case "npm":
          const response = await axios.get(
            `https://registry.npmjs.org/${packageName}`
          );
          fullDoc = response.data.readme || "";
          break;
        default:
          throw new Error(`Unsupported language: ${language}`);
      }

      // Split documentation into sections for better context
      const sections = fullDoc.split(/\n\n+/);

      if (fuzzy) {
        // Use Fuse.js for fuzzy searching
        const fuse = new Fuse(sections, {
          includeScore: true,
          threshold: 0.4,
          minMatchCharLength: 3
        });

        const searchResults = fuse.search(query);

        return {
          results: searchResults.map(result => ({
            match: result.item.substring(0, 150),
            context: result.item,
            score: 1 - (result.score || 0),
            symbol: this.extractSymbol(result.item, language)
          })),
          totalResults: searchResults.length
        };
      } else {
        // Use regular expression for exact matching
        const regex = new RegExp(query, "gi");
        const matches = sections.filter(section => regex.test(section));

        return {
          results: matches.map(match => ({
            match: match.substring(0, 150),
            context: match,
            score: 1,
            symbol: this.extractSymbol(match, language)
          })),
          totalResults: matches.length
        };
      }
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search documentation: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private extractSymbol(text: string, language: string): string | undefined {
    const firstLine = text.split('\n')[0];
    switch (language) {
      case "go":
        const goMatch = firstLine.match(/^(func|type|var|const)\s+(\w+)/);
        return goMatch?.[2];
      case "python":
        const pyMatch = firstLine.match(/^(class|def)\s+(\w+)/);
        return pyMatch?.[2];
      case "npm":
        const npmMatch = firstLine.match(/^#+\s*(`.*`|\w+)/);
        return npmMatch?.[1]?.replace(/`/g, '');
      default:
        return undefined;
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
