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
import { readFileSync, existsSync } from "fs";
import Fuse from "fuse.js";
import { homedir } from "os";
import { join as pathJoin } from "path";
import TypeScriptLspClient from "./lsp/typescript-lsp-client.js";

import { logger, McpLogger } from './logger.js';

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
  suggestInstall?: boolean; // Flag to indicate if we should suggest package installation
}

interface SearchResults {
  results: SearchResult[];
  totalResults: number;
  error?: string;
  suggestInstall?: boolean;
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
  projectPath?: string;
}

const isSearchDocArgs = (args: unknown): args is SearchDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as SearchDocArgs).package === "string" &&
    typeof (args as SearchDocArgs).query === "string" &&
    ["go", "python", "npm"].includes((args as SearchDocArgs).language) &&
    (typeof (args as SearchDocArgs).fuzzy === "boolean" ||
      (args as SearchDocArgs).fuzzy === undefined) &&
    (typeof (args as SearchDocArgs).projectPath === "string" ||
      (args as SearchDocArgs).projectPath === undefined)
  );
};

interface GoDocArgs {
  package: string;
  symbol?: string;
  projectPath?: string;
}

interface PythonDocArgs {
  package: string;
  symbol?: string;
  projectPath?: string;
}

interface NpmDocArgs {
  package: string;
  version?: string;
  projectPath?: string;
}

const isGoDocArgs = (args: unknown): args is GoDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as GoDocArgs).package === "string" &&
    (typeof (args as GoDocArgs).symbol === "string" ||
      (args as GoDocArgs).symbol === undefined) &&
    (typeof (args as GoDocArgs).projectPath === "string" ||
      (args as GoDocArgs).projectPath === undefined)
  );
};

const isPythonDocArgs = (args: unknown): args is PythonDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as PythonDocArgs).package === "string" &&
    (typeof (args as PythonDocArgs).symbol === "string" ||
      (args as PythonDocArgs).symbol === undefined) &&
    (typeof (args as PythonDocArgs).projectPath === "string" ||
      (args as PythonDocArgs).projectPath === undefined)
  );
};

const isNpmDocArgs = (args: unknown): args is NpmDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as NpmDocArgs).package === "string" &&
    (typeof (args as NpmDocArgs).version === "string" ||
      (args as NpmDocArgs).version === undefined) &&
    (typeof (args as NpmDocArgs).projectPath === "string" ||
      (args as NpmDocArgs).projectPath === undefined)
  );
};

interface NpmConfig {
  registry: string;
  token?: string;
}

class PackageDocsServer {
  private server: Server;
  private cache: Map<string, DocResult>;
  private registryMap: Map<string, NpmConfig>;
  private logger: McpLogger;
  private lspClient?: TypeScriptLspClient;
  private lspEnabled: boolean;

  constructor() {
    this.logger = logger.child('PackageDocs');
    this.registryMap = this.loadNpmConfig();
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

    // Check if LSP functionality is enabled via environment variable
    this.lspEnabled = process.env.ENABLE_LSP === "true";
    if (this.lspEnabled) {
      this.logger.info("Language Server Protocol support is enabled");
      try {
        this.lspClient = new TypeScriptLspClient();
        this.logger.info("TypeScript Language Server client initialized successfully");
      } catch (error) {
        this.logger.error("Failed to initialize TypeScript Language Server client:", error);
        this.lspEnabled = false;
      }
    } else {
      this.logger.info("Language Server Protocol support is disabled");
    }

    this.setupToolHandlers();

    this.server.onerror = (error) => this.logger.error("Server error:", error);
    process.on("SIGINT", async () => {
      if (this.lspClient) {
        this.lspClient.cleanup();
      }
      await this.server.close();
      process.exit(0);
    });
  }

  private parseNpmrcContent(
    content: string,
    scopeToRegistry: Map<string, string>,
    registryToToken: Map<string, string>,
    registryMap: Map<string, NpmConfig>
  ): void {
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) continue;

      // Handle registry configurations
      // Match patterns like:
      // @scope:registry=https://registry.example.com
      // registry=https://registry.example.com
      const registryMatch = trimmedLine.match(/^(?:@([^:]+):)?registry=(.+)$/);
      if (registryMatch) {
        const [, scope, registry] = registryMatch;
        const cleanRegistry = registry.replace(/\/$/, "");
        if (scope) {
          scopeToRegistry.set(`@${scope}`, cleanRegistry);
        } else {
          registryMap.set("default", { registry: cleanRegistry });
        }
        continue;
      }

      // Handle authentication tokens
      // Match patterns like:
      // //registry.example.com/:_authToken=token
      // @scope:_authToken=token
      // _authToken=token
      const tokenMatch = trimmedLine.match(/^(?:\/\/([^/]+)\/:|@([^:]+):)?_authToken=(.+)$/);
      if (tokenMatch) {
        const [, registry, scope, token] = tokenMatch;
        if (registry) {
          // Store token for specific registry
          // Handle both protocol and non-protocol URLs
          registryToToken.set(registry, token);
          if (!registry.includes("://")) {
            registryToToken.set(`https://${registry}`, token);
            registryToToken.set(`http://${registry}`, token);
          }
        } else if (scope) {
          // Store token for scope, we'll resolve the registry later
          const scopeRegistry = scopeToRegistry.get(`@${scope}`);
          if (scopeRegistry) {
            try {
              // Try parsing as URL first
              const url = new URL(scopeRegistry);
              registryToToken.set(url.host, token);
            } catch {
              // If not a URL, treat as hostname
              registryToToken.set(scopeRegistry, token);
              registryToToken.set(`https://${scopeRegistry}`, token);
              registryToToken.set(`http://${scopeRegistry}`, token);
            }
          }
        } else {
          // Default token
          const defaultRegistry = registryMap.get("default")?.registry;
          if (defaultRegistry) {
            try {
              // Try parsing as URL first
              const url = new URL(defaultRegistry);
              registryToToken.set(url.host, token);
            } catch {
              // If not a URL, treat as hostname
              registryToToken.set(defaultRegistry, token);
              registryToToken.set(`https://${defaultRegistry}`, token);
              registryToToken.set(`http://${defaultRegistry}`, token);
            }
          }
        }
      }
    }
  }

  private loadNpmConfig(projectPath?: string): Map<string, NpmConfig> {
    const registryMap = new Map<string, NpmConfig>();
    registryMap.set("default", { registry: "https://registry.npmjs.org" });

    const scopeToRegistry = new Map<string, string>();
    const registryToToken = new Map<string, string>();

    this.logger.info("Loading npm configuration...")
    this.logger.info("Project directory:", projectPath || "not specified");

    // First read global .npmrc as base configuration
    const globalNpmrcPath = pathJoin(homedir(), ".npmrc");
    this.logger.info("Checking global .npmrc at:", globalNpmrcPath);
    if (existsSync(globalNpmrcPath)) {
      this.logger.info("Found global .npmrc");
      try {
        const npmrcContent = readFileSync(globalNpmrcPath, "utf-8");
        this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
      } catch (error) {
        this.logger.error("Error reading global .npmrc:", error);
      }
    }

    // Then read from root to project directory, so local configs take precedence
    if (projectPath) {
      const paths: string[] = [];
      let currentDir = projectPath;
      const root = dirname(currentDir);

      // Collect all paths first
      while (currentDir !== root) {
        paths.push(currentDir);
        currentDir = dirname(currentDir);
      }
      paths.push(root);

      // Process paths in reverse order (root to local)
      for (const dir of paths.reverse()) {
        const localNpmrcPath = pathJoin(dir, ".npmrc");
        this.logger.info("Checking for .npmrc at:", localNpmrcPath);
        if (existsSync(localNpmrcPath)) {
          this.logger.info("Found .npmrc at:", localNpmrcPath);
          try {
            const npmrcContent = readFileSync(localNpmrcPath, "utf-8");
            this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
          } catch (error) {
            this.logger.error(`Error reading local .npmrc at ${localNpmrcPath}:`, error);
          }
        }
      }
    }

    try {
      // Associate tokens with registries
      for (const [scope, registry] of scopeToRegistry.entries()) {
        const hostname = new URL(registry).host;
        const token = registryToToken.get(hostname);
        this.logger.info(`Setting config for scope ${scope}:`, { registry, token: token ? "[REDACTED]" : undefined });
        registryMap.set(scope, { registry, token });
      }

      // Ensure default registry has its token if available
      const defaultConfig = registryMap.get("default");
      if (defaultConfig) {
        const hostname = new URL(defaultConfig.registry).host;
        const token = registryToToken.get(hostname);
        if (token) {
          this.logger.info("Setting token for default registry");
          registryMap.set("default", { ...defaultConfig, token });
        }
      }

      this.logger.info("Final registry configurations:",
        Object.fromEntries(Array.from(registryMap.entries()).map(([k, v]) => [
          k,
          { registry: v.registry, token: v.token ? "[REDACTED]" : undefined }
        ]))
      );
    } catch (error) {
      this.logger.error("Error processing .npmrc configurations:", error);
    }

    return registryMap;
  }

  private getRegistryConfigForPackage(packageName: string, projectPath?: string): NpmConfig {
    // Load fresh config if project path is provided
    if (projectPath) {
      this.registryMap = this.loadNpmConfig(projectPath);
    }

    if (packageName.startsWith("@")) {
      const scope = packageName.split("/")[0];
      return this.registryMap.get(scope) || this.registryMap.get("default") || { registry: "https://registry.npmjs.org" };
    }
    return this.registryMap.get("default") || { registry: "https://registry.npmjs.org" };
  }

  /**
   * Check if a Go package is installed locally
   */
  private async isGoPackageInstalledLocally(packageName: string, projectPath?: string): Promise<boolean> {
    try {
      // Check if the project has a go.mod file
      const goModPath = projectPath ? join(projectPath, "go.mod") : "go.mod"
      if (existsSync(goModPath)) {
        const goMod = readFileSync(goModPath, "utf-8")
        // Simple check if the package is mentioned in go.mod
        if (goMod.includes(packageName)) {
          return true
        }
      }

      // Try to find the package in GOPATH
      const { stdout } = await execAsync(`go list -f '{{.Dir}}' ${packageName}`)
      return !!stdout.trim()
    } catch (error) {
      // If the command fails, the package is likely not installed
      return false
    }
  }

  /**
   * Check if a Python package is installed locally
   */
  private async isPythonPackageInstalledLocally(packageName: string, projectPath?: string): Promise<boolean> {
    try {
      // Check if we can import the package
      const pythonCode = `
import importlib.util
import sys
spec = importlib.util.find_spec('${packageName}')
print(spec is not None)
`
      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`)
      return stdout.trim() === "True"
    } catch (error) {
      return false
    }
  }

  /**
   * Check if an NPM package is installed locally
   */
  private isNpmPackageInstalledLocally(packageName: string, projectPath?: string): boolean {
    try {
      // Check in the project's node_modules directory
      const basePath = projectPath || process.cwd()
      const packageJsonPath = join(basePath, "node_modules", packageName, "package.json")

      return existsSync(packageJsonPath)
    } catch (error) {
      return false
    }
  }

  /**
   * Get documentation from a locally installed Go package
   */
  private async getLocalGoDoc(packageName: string, symbol?: string, projectPath?: string): Promise<DocResult> {
    try {
      const cmd = symbol
        ? `go doc ${packageName}.${symbol}`
        : `go doc ${packageName}`
      const { stdout } = await execAsync(cmd)

      // Parse the go doc output into a structured format
      const lines = stdout.split("\n")
      const result: DocResult = {}

      let section: "description" | "usage" | "example" = "description"
      let content: string[] = []

      for (const line of lines) {
        if (line.startsWith("func") || line.startsWith("type")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim()
          }
          section = "usage"
          content = [line]
        } else if (line.includes("Example")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim()
          }
          section = "example"
          content = []
        } else {
          content.push(line)
        }
      }

      if (content.length > 0) {
        result[section] = content.join("\n").trim()
      }

      return result
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch local Go documentation: ${errorMessage}`,
      }
    }
  }

  /**
   * Get documentation from a locally installed Python package
   */
  private async getLocalPythonDoc(packageName: string, symbol?: string, projectPath?: string): Promise<DocResult> {
    try {
      const pythonCode = symbol
        ? `
import ${packageName}
help(${packageName}.${symbol})
`
        : `
import ${packageName}
help(${packageName})
`

      const { stdout } = await execAsync(`python3 -c "${pythonCode}"`)

      // Parse the Python help output into a structured format
      const lines = stdout.split("\n")
      const result: DocResult = {}

      let section: "description" | "usage" | "example" = "description"
      let content: string[] = []

      for (const line of lines) {
        if (line.startsWith("class") || line.startsWith("def")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim()
          }
          section = "usage"
          content = [line]
        } else if (line.includes("Examples:") || line.includes("Example:")) {
          if (content.length > 0) {
            result[section] = content.join("\n").trim()
          }
          section = "example"
          content = []
        } else {
          content.push(line)
        }
      }

      if (content.length > 0) {
        result[section] = content.join("\n").trim()
      }

      return result
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch local Python documentation: ${errorMessage}`,
      }
    }
  }

  /**
   * Get documentation from a locally installed NPM package
   */
  private getLocalNpmDoc(packageName: string, projectPath?: string): DocResult {
    try {
      const basePath = projectPath || process.cwd()
      const packagePath = join(basePath, "node_modules", packageName)
      const packageJsonPath = join(packagePath, "package.json")
      const readmePaths = [
        join(packagePath, "README.md"),
        join(packagePath, "readme.md"),
        join(packagePath, "Readme.md"),
        join(packagePath, "README.markdown"),
        join(packagePath, "README")
      ]

      // Read package.json for basic info
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"))
      const result: DocResult = {
        description: packageJson.description || "No description available"
      }

      // Try to find and read README
      for (const readmePath of readmePaths) {
        if (existsSync(readmePath)) {
          const readme = readFileSync(readmePath, "utf-8")

          // Extract usage and examples from README
          const sections = readme.split(/#+\s/)
          for (const section of sections) {
            const lower = section.toLowerCase()
            if (
              lower.startsWith("usage") ||
              lower.startsWith("getting started")
            ) {
              result.usage = section.split("\n").slice(1).join("\n").trim()
            } else if (lower.startsWith("example")) {
              result.example = section.split("\n").slice(1).join("\n").trim()
            }
          }

          break
        }
      }

      return result
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch local NPM documentation: ${errorMessage}`,
      }
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const baseTools = [
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
              },
              projectPath: {
                type: "string",
                description: "Optional path to project directory for local .npmrc files"
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
              projectPath: {
                type: "string",
                description: "Optional path to project directory for local .npmrc files"
              }
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
              projectPath: {
                type: "string",
                description: "Optional path to project directory for local .npmrc files"
              }
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
              projectPath: {
                type: "string",
                description: "Optional path to project directory for local .npmrc files"
              }
            },
            required: ["package"],
          },
        },
      ];

      // Add LSP tools if enabled
      if (this.lspEnabled && this.lspClient) {
        const lspTools = [
          {
            name: "get_hover",
            description: "Get hover information for a position in a document using Language Server Protocol",
            inputSchema: {
              type: "object",
              properties: {
                languageId: {
                  type: "string",
                  description: "The language identifier (e.g., 'typescript', 'javascript')"
                },
                filePath: {
                  type: "string",
                  description: "Absolute or relative path to the source file"
                },
                content: {
                  type: "string",
                  description: "The current content of the file"
                },
                line: {
                  type: "number",
                  description: "Zero-based line number for hover position"
                },
                character: {
                  type: "number",
                  description: "Zero-based character offset for hover position"
                },
                projectRoot: {
                  type: "string",
                  description: "Root directory of the project for resolving imports and node_modules"
                },
              },
              required: ["languageId", "filePath", "content", "line", "character"],
            },
          },
          {
            name: "get_completions",
            description: "Get completion suggestions for a position in a document using Language Server Protocol",
            inputSchema: {
              type: "object",
              properties: {
                languageId: {
                  type: "string",
                  description: "The language identifier (e.g., 'typescript', 'javascript')"
                },
                filePath: {
                  type: "string",
                  description: "Absolute or relative path to the source file"
                },
                content: {
                  type: "string",
                  description: "The current content of the file"
                },
                line: {
                  type: "number",
                  description: "Zero-based line number for completion position"
                },
                character: {
                  type: "number",
                  description: "Zero-based character offset for completion position"
                },
                projectRoot: {
                  type: "string",
                  description: "Root directory of the project for resolving imports and node_modules"
                },
              },
              required: ["languageId", "filePath", "content", "line", "character"],
            },
          },
          {
            name: "get_diagnostics",
            description: "Get diagnostic information for a document using Language Server Protocol",
            inputSchema: {
              type: "object",
              properties: {
                languageId: {
                  type: "string",
                  description: "The language identifier (e.g., 'typescript', 'javascript')"
                },
                filePath: {
                  type: "string",
                  description: "Absolute or relative path to the source file"
                },
                content: {
                  type: "string",
                  description: "The current content of the file"
                },
                projectRoot: {
                  type: "string",
                  description: "Root directory of the project for resolving imports and node_modules"
                },
              },
              required: ["languageId", "filePath", "content"],
            },
          },
        ];

        return { tools: [...baseTools, ...lspTools] };
      }

      return { tools: baseTools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params.arguments) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments are required");
      }

      // Handle LSP tools if enabled
      if (this.lspEnabled && this.lspClient) {
        if (request.params.name === "get_hover") {
          return await this.handleGetHover(request.params.arguments);
        } else if (request.params.name === "get_completions") {
          return await this.handleGetCompletions(request.params.arguments);
        } else if (request.params.name === "get_diagnostics") {
          return await this.handleGetDiagnostics(request.params.arguments);
        }
      }

      // Handle regular package documentation tools
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
              request.params.arguments.fuzzy,
              request.params.arguments.projectPath
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
            request.params.arguments.projectPath
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
            request.params.arguments.projectPath
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
            request.params.arguments.projectPath
          );
          break;
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`,
          );
      }

      // Check if we need to suggest package installation
      if (result.suggestInstall || (result.searchResults?.suggestInstall)) {
        const packageName =
          request.params.name === "search_package_docs" ?
            (request.params.arguments as SearchDocArgs).package :
            request.params.name === "lookup_go_doc" ?
              (request.params.arguments as GoDocArgs).package :
              request.params.name === "lookup_python_doc" ?
                (request.params.arguments as PythonDocArgs).package :
                request.params.name === "lookup_npm_doc" ?
                  (request.params.arguments as NpmDocArgs).package :
                  "unknown";

        const language =
          request.params.name === "search_package_docs" ?
            (request.params.arguments as SearchDocArgs).language :
            request.params.name === "lookup_go_doc" ?
              "go" :
              request.params.name === "lookup_python_doc" ?
                "python" :
                request.params.name === "lookup_npm_doc" ?
                  "npm" :
                  "unknown";

        // Add installation instructions to the error message
        const installCommand =
          language === "go" ? `go get ${packageName}` :
            language === "python" ? `pip install ${packageName}` :
              language === "npm" ? `npm install ${packageName}` :
                "unknown";

        const installMessage = `Package '${packageName}' is not installed. Would you like to install it using '${installCommand}'?`;

        // Return the result with the installation suggestion
        this.cache.set(cacheKey, result);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
            { type: "text", text: installMessage }
          ],
        };
      } else {
        // Normal response without installation suggestion
        this.cache.set(cacheKey, result);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
    });
  }

  private async lookupGoDoc(
    packageName: string,
    symbol?: string,
    projectPath?: string
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
      // Remote documentation fetch failed, check if package is installed locally
      this.logger.error(`Remote Go documentation fetch failed for ${packageName}: ${error}`);

      try {
        // Check if the package is installed locally
        const isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath);

        if (isInstalled) {
          this.logger.info(`Package ${packageName} is installed locally, fetching local documentation`);
          return await this.getLocalGoDoc(packageName, symbol, projectPath);
        } else {
          this.logger.error(`Package ${packageName} is not installed locally`);
          // Package is not installed locally, suggest installation
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            error: `Failed to fetch Go documentation: ${errorMessage}`,
            suggestInstall: true
          };
        }
      } catch (localError) {
        // Both remote and local attempts failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          error: `Failed to fetch Go documentation: ${errorMessage}`,
        };
      }
    }
  }

  private async lookupPythonDoc(
    packageName: string,
    symbol?: string,
    projectPath?: string
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
      // Remote documentation fetch failed, check if package is installed locally
      this.logger.error(`Remote Python documentation fetch failed for ${packageName}: ${error}`);

      try {
        // Check if the package is installed locally
        const isInstalled = await this.isPythonPackageInstalledLocally(packageName, projectPath);

        if (isInstalled) {
          this.logger.info(`Package ${packageName} is installed locally, fetching local documentation`);
          return await this.getLocalPythonDoc(packageName, symbol, projectPath);
        } else {
          this.logger.error(`Package ${packageName} is not installed locally`);
          // Package is not installed locally, suggest installation
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            error: `Failed to fetch Python documentation: ${errorMessage}`,
            suggestInstall: true
          };
        }
      } catch (localError) {
        // Both remote and local attempts failed
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          error: `Failed to fetch Python documentation: ${errorMessage}`,
        };
      }
    }
  }

  private async lookupNpmDoc(
    packageName: string,
    version?: string,
    projectPath?: string
  ): Promise<DocResult> {
    const config = this.getRegistryConfigForPackage(packageName, projectPath);
    try {
      const packagePath = encodeURIComponent(packageName);
      const url = `${config.registry}/${packagePath}${version ? `/${version}` : ""}`;

      const headers: Record<string, string> = {};
      if (config.token) {
        headers.Authorization = `Bearer ${config.token}`;
      }

      const response = await axios.get(url, { headers });

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
      // Remote documentation fetch failed, check if package is installed locally
      this.logger.error(`Remote NPM documentation fetch failed for ${packageName}: ${error}`);

      let errorMessage = "Unknown error occurred";
      let statusCode: number | undefined;

      if (error instanceof AxiosError) {
        statusCode = error.response?.status;
        const responseData = error.response?.data;

        if (statusCode === 404) {
          errorMessage = `Package '${packageName}' not found. Please check:\n` +
            `1. The package name is correct\n` +
            `2. You have access to the package\n` +
            `3. The registry URL is correct (current: ${config.registry})\n` +
            `4. Authentication is properly configured in .npmrc`;
        } else if (statusCode === 401 || statusCode === 403) {
          errorMessage = `Authentication failed for package '${packageName}'.\n` +
            `Please ensure your .npmrc contains valid authentication tokens for ${config.registry}`;
        } else {
          errorMessage = responseData?.message || error.message;
        }
      } else {
        errorMessage = String(error);
      }

      try {
        // Check if the package is installed locally
        const isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath);

        if (isInstalled) {
          this.logger.info(`Package ${packageName} is installed locally, fetching local documentation`);
          return this.getLocalNpmDoc(packageName, projectPath);
        } else {
          this.logger.error(`Package ${packageName} is not installed locally`);
          // Package is not installed locally, suggest installation
          return {
            error: `Failed to fetch NPM documentation (${statusCode || 'unknown status'}): ${errorMessage}`,
            suggestInstall: true
          };
        }
      } catch (localError) {
        // Both remote and local attempts failed
        return {
          error: `Failed to fetch NPM documentation (${statusCode || 'unknown status'}): ${errorMessage}`,
        };
      }
    }
  }

  private async searchPackageDocs(
    packageName: string,
    query: string,
    language: "go" | "python" | "npm",
    fuzzy: boolean = true,
    projectPath?: string
  ): Promise<SearchResults> {
    try {
      let docSections: Array<{ content: string; type: string }> = [];

      try {
        // First try to get documentation from remote sources
        switch (language) {
          case "go":
            const { stdout: goDoc } = await execAsync(`go doc -all ${packageName}`);
            docSections = this.parseGoDoc(goDoc);
            break;
          case "python":
            const pythonCode = `
import ${packageName}
help(${packageName})
`;
            const { stdout: pythonDoc } = await execAsync(`python3 -c "${pythonCode}"`);
            docSections = this.parsePythonDoc(pythonDoc);
            break;
          case "npm":
            const config = this.getRegistryConfigForPackage(packageName, projectPath);
            const packagePath = encodeURIComponent(packageName);
            const url = `${config.registry}/${packagePath}`;

            const headers: Record<string, string> = {};
            if (config.token) {
              headers.Authorization = `Bearer ${config.token}`;
            }

            const response = await axios.get(url, { headers });
            docSections = this.parseNpmDoc(response.data);
            break;
          default:
            throw new Error(`Unsupported language: ${language}`);
        }
      } catch (remoteError) {
        // Remote documentation fetch failed, check if package is installed locally
        this.logger.error(`Remote documentation fetch failed for ${packageName}: ${remoteError}`);

        let isInstalled = false;

        // Check if the package is installed locally
        switch (language) {
          case "go":
            isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath);
            break;
          case "python":
            isInstalled = await this.isPythonPackageInstalledLocally(packageName, projectPath);
            break;
          case "npm":
            isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath);
            break;
        }

        if (isInstalled) {
          this.logger.info(`Package ${packageName} is installed locally, fetching local documentation`);

          // Get documentation from locally installed package
          switch (language) {
            case "go":
              const { stdout: localGoDoc } = await execAsync(`go doc -all ${packageName}`);
              docSections = this.parseGoDoc(localGoDoc);
              break;
            case "python":
              const localPythonCode = `
import ${packageName}
help(${packageName})
`;
              const { stdout: localPythonDoc } = await execAsync(`python3 -c "${localPythonCode}"`);
              docSections = this.parsePythonDoc(localPythonDoc);
              break;
            case "npm":
              // For NPM, we need to manually parse the README from the local package
              try {
                const basePath = projectPath || process.cwd();
                const packagePath = join(basePath, "node_modules", packageName);
                const readmePaths = [
                  join(packagePath, "README.md"),
                  join(packagePath, "readme.md"),
                  join(packagePath, "Readme.md"),
                  join(packagePath, "README.markdown"),
                  join(packagePath, "README")
                ];

                // Find and read README
                for (const readmePath of readmePaths) {
                  if (existsSync(readmePath)) {
                    const readme = readFileSync(readmePath, "utf-8");

                    // Create a simple data structure similar to what we'd get from the registry
                    const packageJsonPath = join(packagePath, "package.json");
                    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

                    docSections = this.parseNpmDoc({
                      description: packageJson.description,
                      readme: readme
                    });
                    break;
                  }
                }
              } catch (localNpmError) {
                this.logger.error(`Failed to parse local NPM documentation: ${localNpmError}`);
              }
              break;
          }
        } else {
          // Package is not installed locally and remote fetch failed
          const result: SearchResults = {
            results: [],
            totalResults: 0
          };

          // Return empty results with a special error that will be handled by the caller
          throw new McpError(
            ErrorCode.InternalError,
            `Failed to search documentation for ${packageName}. Package is not installed locally and remote fetch failed: ${remoteError instanceof Error ? remoteError.message : String(remoteError)}`
          );
        }
      }

      if (docSections.length === 0) {
        return {
          results: [],
          totalResults: 0
        };
      }

      if (fuzzy) {
        // Use Fuse.js for fuzzy searching with more lenient threshold
        const fuse = new Fuse(docSections, {
          includeScore: true,
          threshold: 0.3, // Lower threshold to catch more matches
          minMatchCharLength: 2,
          keys: ['content'],
          ignoreLocation: true
        });

        const searchResults = fuse.search(query);

        return {
          results: searchResults.map(result => {
            const section = result.item;
            const matchStart = section.content.toLowerCase().indexOf(query.toLowerCase());
            let match = section.content;

            // Extract a window of text around the match
            if (matchStart !== -1) {
              const start = Math.max(0, matchStart - 50);
              const end = Math.min(section.content.length, matchStart + query.length + 100);
              match = (start > 0 ? '...' : '') +
                section.content.slice(start, end) +
                (end < section.content.length ? '...' : '');
            }

            return {
              match,
              context: section.content,
              score: 1 - (result.score || 0),
              symbol: this.extractSymbol(section.content, language),
              type: section.type
            };
          }),
          totalResults: searchResults.length
        };
      } else {
        // Use regular expression for exact matching with word boundaries
        const regex = new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "gi");
        const matches = docSections.filter(section => regex.test(section.content));

        return {
          results: matches.map(section => {
            const matchStart = section.content.toLowerCase().indexOf(query.toLowerCase());
            let match = section.content;

            if (matchStart !== -1) {
              const start = Math.max(0, matchStart - 50);
              const end = Math.min(section.content.length, matchStart + query.length + 100);
              match = (start > 0 ? '...' : '') +
                section.content.slice(start, end) +
                (end < section.content.length ? '...' : '');
            }

            return {
              match,
              context: section.content,
              score: 1,
              symbol: this.extractSymbol(section.content, language),
              type: section.type
            };
          }),
          totalResults: matches.length
        };
      }
    } catch (error) {
      // Check if the error message contains information about package not being installed
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("not installed locally")) {
        // Create a result with a special error message that indicates installation is needed
        return {
          results: [],
          totalResults: 0,
          error: errorMessage,
          suggestInstall: true
        };
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search documentation: ${errorMessage}`
      );
    }
  }

  private parseGoDoc(doc: string): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = [];
    let currentSection = '';
    let currentType = 'description';

    const lines = doc.split('\n');
    for (const line of lines) {
      if (line.startsWith('func ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'function';
      } else if (line.startsWith('type ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'type';
      } else if (line.startsWith('var ') || line.startsWith('const ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'variable';
      } else {
        currentSection += '\n' + line;
      }
    }

    if (currentSection) {
      sections.push({ content: currentSection.trim(), type: currentType });
    }

    return sections;
  }

  private parsePythonDoc(doc: string): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = [];
    let currentSection = '';
    let currentType = 'description';

    const lines = doc.split('\n');
    for (const line of lines) {
      if (line.startsWith('class ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'class';
      } else if (line.startsWith('def ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'function';
      } else if (line.match(/^[A-Z_]+\s*=/)) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType });
        }
        currentSection = line;
        currentType = 'constant';
      } else {
        currentSection += '\n' + line;
      }
    }

    if (currentSection) {
      sections.push({ content: currentSection.trim(), type: currentType });
    }

    return sections;
  }

  private parseNpmDoc(data: any): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = [];

    // Add package description
    if (data.description) {
      sections.push({
        content: data.description,
        type: 'description'
      });
    }

    // Parse README into sections
    if (data.readme) {
      const readmeSections = data.readme.split(/(?=^#+ )/m);
      for (const section of readmeSections) {
        const lines = section.split('\n');
        const heading = lines[0];
        const content = lines.slice(1).join('\n').trim();

        if (content) {
          let type = 'general';
          const lowerHeading = heading.toLowerCase();

          if (lowerHeading.includes('install')) type = 'installation';
          else if (lowerHeading.includes('usage') || lowerHeading.includes('api')) type = 'usage';
          else if (lowerHeading.includes('example')) type = 'example';
          else if (lowerHeading.includes('config')) type = 'configuration';

          sections.push({
            content: `${heading}\n${content}`,
            type
          });
        }
      }
    }

    return sections;
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
        // Extract symbol from markdown headings or code blocks
        const npmMatch = firstLine.match(/^#+\s*(?:`([^`]+)`|(\w+))/);
        return npmMatch?.[1] || npmMatch?.[2];
      default:
        return undefined;
    }
  }

  private async handleGetHover(args: any): Promise<any> {
    if (!this.lspClient) {
      throw new McpError(
        ErrorCode.InternalError,
        "LSP functionality is not enabled"
      );
    }

    const { languageId, filePath, content, line, character, projectRoot } = args;

    try {
      const hover = await this.lspClient.getHover(
        languageId,
        filePath,
        content,
        line,
        character,
        projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: hover?.contents
              ? JSON.stringify(hover.contents, null, 2)
              : "No hover information available",
          },
        ],
      };
    } catch (error) {
      console.error("[handleGetHover] Request failed:", error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to get hover information: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetCompletions(args: any): Promise<any> {
    if (!this.lspClient) {
      throw new McpError(
        ErrorCode.InternalError,
        "LSP functionality is not enabled"
      );
    }

    const { languageId, filePath, content, line, character, projectRoot } = args;

    try {
      const completions = await this.lspClient.getCompletions(
        languageId,
        filePath,
        content,
        line,
        character,
        projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: completions && completions.length > 0
              ? JSON.stringify(completions, null, 2)
              : "No completions available",
          },
        ],
      };
    } catch (error) {
      console.error("[handleGetCompletions] Request failed:", error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to get completions: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  private async handleGetDiagnostics(args: any): Promise<any> {
    if (!this.lspClient) {
      throw new McpError(
        ErrorCode.InternalError,
        "LSP functionality is not enabled"
      );
    }

    const { languageId, filePath, content, projectRoot } = args;

    try {
      const diagnostics = await this.lspClient.getDiagnostics(
        languageId,
        filePath,
        content,
        projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: diagnostics && diagnostics.length > 0
              ? JSON.stringify(diagnostics, null, 2)
              : "No diagnostics available",
          },
        ],
      };
    } catch (error) {
      console.error("[handleGetDiagnostics] Request failed:", error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  async run() {
    // Log server startup information
    this.logger.info(
      "Package Docs MCP server running on stdio, version:",
      packageJson.version,
      this.lspEnabled ? "(LSP enabled)" : "(LSP disabled)"
    );

    // Initialize and connect the transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}

const server = new PackageDocsServer();
server.run().catch(error => {
  logger.error('Error running MCP server:', error);
  process.exit(1);
});
