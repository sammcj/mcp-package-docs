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
  context?: string; // Make context optional to save space
  score: number;
  type?: string; // Type of the section (function, class, etc.)
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
  section?: string;
  maxLength?: number;
  query?: string;
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
      (args as NpmDocArgs).projectPath === undefined) &&
    (typeof (args as NpmDocArgs).section === "string" ||
      (args as NpmDocArgs).section === undefined) &&
    (typeof (args as NpmDocArgs).maxLength === "number" ||
      (args as NpmDocArgs).maxLength === undefined) &&
    (typeof (args as NpmDocArgs).query === "string" ||
      (args as NpmDocArgs).query === undefined)
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

  /**
   * Connect the server to a transport
   */
  public async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }

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

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define the main tools
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
          name: "describe_go_package",
          description: "Get a brief description of a Go package",
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
          name: "describe_python_package",
          description: "Get a brief description of a Python package",
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
          name: "describe_npm_package",
          description: "Get a brief description of an NPM package",
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
        {
          name: "get_npm_package_doc",
          description: "Get full documentation for an NPM package",
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
              },
              section: {
                type: "string",
                description: "Optional section to retrieve (e.g. 'installation', 'api', 'examples')"
              },
              maxLength: {
                type: "number",
                description: "Optional maximum length of the returned documentation"
              },
              query: {
                type: "string",
                description: "Optional search query to filter documentation content"
              }
            },
            required: ["package"],
          },
        },
      ];

      // Add legacy tools for backward compatibility
      const legacyTools = [
        {
          name: "lookup_go_doc",
          description: "[DEPRECATED] Use describe_go_package instead. Get a brief description of a Go package",
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
          description: "[DEPRECATED] Use describe_python_package instead. Get a brief description of a Python package",
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
          description: "[DEPRECATED] Use describe_npm_package instead. Get a brief description of an NPM package",
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

      // Combine main tools with legacy tools
      const allTools = [...baseTools, ...legacyTools];

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

        return { tools: [...allTools, ...lspTools] };
      }

      return { tools: allTools };
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
      const cacheKey = JSON.stringify({
        name: request.params.name,
        args: request.params.arguments,
      });

      // Check cache first
      const cachedResult = this.cache.get(cacheKey);
      if (cachedResult) {
        this.logger.info(`Cache hit for ${request.params.name}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cachedResult),
            },
          ],
        };
      }

      try {
        let result: DocResult | undefined;

        switch (request.params.name) {
          case "search_package_docs":
            if (!isSearchDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid search_package_docs arguments"
              );
            }
            result = await this.searchPackageDocs(request.params.arguments);
            break;

          case "describe_go_package":
          case "lookup_go_doc":
            if (!isGoDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_go_package arguments"
              );
            }
            result = await this.describeGoPackage(request.params.arguments);
            break;

          case "describe_python_package":
          case "lookup_python_doc":
            if (!isPythonDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_python_package arguments"
              );
            }
            result = await this.describePythonPackage(request.params.arguments);
            break;

          case "describe_npm_package":
          case "lookup_npm_doc":
            if (!isNpmDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_npm_package arguments"
              );
            }
            result = await this.describeNpmPackage(request.params.arguments);
            break;

          case "get_npm_package_doc":
            if (!isNpmDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid get_npm_package_doc arguments"
              );
            }
            result = await this.getNpmPackageDoc(request.params.arguments);
            break;

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        // Cache the result
        this.cache.set(cacheKey, result);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(`Error in ${request.params.name}:`, error);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Error in ${request.params.name}: ${errorMessage}`,
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle LSP hover requests
   */
  private async handleGetHover(args: any) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized");
    }

    try {
      const result = await this.lspClient.getHover(
        args.languageId,
        args.filePath,
        args.content,
        args.line,
        args.character,
        args.projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Error in handleGetHover:", error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP hover error: ${errorMessage}` }),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Handle LSP completions requests
   */
  private async handleGetCompletions(args: any) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized");
    }

    try {
      const result = await this.lspClient.getCompletions(
        args.languageId,
        args.filePath,
        args.content,
        args.line,
        args.character,
        args.projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Error in handleGetCompletions:", error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP completions error: ${errorMessage}` }),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Handle LSP diagnostics requests
   */
  private async handleGetDiagnostics(args: any) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized");
    }

    try {
      const result = await this.lspClient.getDiagnostics(
        args.languageId,
        args.filePath,
        args.content,
        args.projectRoot
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("Error in handleGetDiagnostics:", error);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP diagnostics error: ${errorMessage}` }),
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Search for content within package documentation
   * Optimized to return concise results to save LLM context
   */
  private async searchPackageDocs(args: SearchDocArgs): Promise<DocResult> {
    const { package: packageName, query, language, fuzzy = true, projectPath } = args;
    this.logger.info(`Searching ${language} package ${packageName} for "${query}"`);

    try {
      let docContent: string | Array<{ content: string; type: string }> = "";
      let isInstalled = false;

      // Check if package is installed locally first
      switch (language) {
        case "go":
          isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath);
          if (isInstalled) {
            const localDoc = await this.getLocalGoDoc(packageName, undefined, projectPath);
            if (!localDoc.error) {
              docContent = this.parseGoDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              );
            }
          } else {
            // Fetch from pkg.go.dev
            const { stdout } = await execAsync(`go doc ${packageName}`);
            docContent = this.parseGoDoc(stdout);
          }
          break;

        case "python":
          isInstalled = await this.isPythonPackageInstalledLocally(packageName, projectPath);
          if (isInstalled) {
            const localDoc = await this.getLocalPythonDoc(packageName, undefined, projectPath);
            if (!localDoc.error) {
              docContent = this.parsePythonDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              );
            }
          } else {
            // Try to fetch from PyPI
            const url = `https://pypi.org/pypi/${packageName}/json`;
            const response = await axios.get(url);
            if (response.data && response.data.info) {
              docContent = [
                { content: response.data.info.summary || "", type: "description" },
                { content: response.data.info.description || "", type: "documentation" }
              ];
            }
          }
          break;

        case "npm":
          isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath);
          if (isInstalled) {
            const localDoc = this.getLocalNpmDoc(packageName, projectPath);
            if (!localDoc.error) {
              docContent = [
                { content: localDoc.description || "", type: "description" },
                { content: localDoc.usage || "", type: "usage" },
                { content: localDoc.example || "", type: "example" }
              ].filter(item => item.content);
            }
          } else {
            // Fetch from npm registry
            const config = this.getRegistryConfigForPackage(packageName, projectPath);
            const headers: Record<string, string> = {};
            if (config.token) {
              headers.Authorization = `Bearer ${config.token}`;
            }

            const url = `${config.registry}/${packageName}`;
            const response = await axios.get(url, { headers });
            if (response.data) {
              docContent = this.parseNpmDoc(response.data);
            }
          }
          break;
      }

      // If no content was found, return an error
      if (!docContent || (Array.isArray(docContent) && docContent.length === 0)) {
        return {
          error: `No documentation found for ${packageName}`,
          suggestInstall: !isInstalled
        };
      }

      // Perform search on the documentation content
      const searchResults: SearchResult[] = [];

      if (Array.isArray(docContent)) {
        // For structured content (array of sections)
        if (fuzzy) {
          // Use fuzzy search
          const fuseOptions = {
            includeScore: true,
            threshold: 0.4,
            keys: ['content']
          };

          const fuse = new Fuse(docContent, fuseOptions);
          const results = fuse.search(query);

          for (const result of results) {
            const section = result.item;
            const symbol = this.extractSymbol(section.content, language);

            // Limit context to save space
            const lines = section.content.split('\n');
            const firstLine = lines[0];
            const contextLines = lines.slice(1, Math.min(lines.length, 6)).join('\n');

            searchResults.push({
              symbol,
              match: firstLine,
              context: contextLines.length > 0 ? contextLines : undefined,
              score: result.score || 0,
              type: section.type
            });
          }
        } else {
          // Use exact search
          for (const section of docContent) {
            if (section.content.toLowerCase().includes(query.toLowerCase())) {
              const symbol = this.extractSymbol(section.content, language);

              // Limit context to save space
              const lines = section.content.split('\n');
              const firstLine = lines[0];
              const contextLines = lines.slice(1, Math.min(lines.length, 6)).join('\n');

              searchResults.push({
                symbol,
                match: firstLine,
                context: contextLines.length > 0 ? contextLines : undefined,
                score: 0,
                type: section.type
              });
            }
          }
        }
      } else {
        // For plain text content
        const lines = docContent.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (fuzzy) {
            // Simple fuzzy matching for plain text
            if (this.fuzzyMatch(line, query)) {
              const contextStart = Math.max(0, i - 2);
              const contextEnd = Math.min(lines.length, i + 3);
              const context = lines.slice(contextStart, contextEnd).join('\n');

              searchResults.push({
                match: line,
                context,
                score: 0
              });
            }
          } else if (line.toLowerCase().includes(query.toLowerCase())) {
            const contextStart = Math.max(0, i - 2);
            const contextEnd = Math.min(lines.length, i + 3);
            const context = lines.slice(contextStart, contextEnd).join('\n');

            searchResults.push({
              match: line,
              context,
              score: 0
            });
          }
        }
      }

      // Sort results by score (lower is better)
      searchResults.sort((a, b) => a.score - b.score);

      // Limit number of results to save space
      const limitedResults = searchResults.slice(0, 10);

      return {
        searchResults: {
          results: limitedResults,
          totalResults: searchResults.length,
          suggestInstall: !isInstalled && searchResults.length === 0
        }
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error searching ${language} package ${packageName}:`, error);
      return {
        error: `Failed to search documentation: ${errorMessage}`,
        searchResults: {
          results: [],
          totalResults: 0,
          error: errorMessage
        }
      };
    }
  }

  /**
   * Simple fuzzy matching algorithm
   */
  private fuzzyMatch(text: string, pattern: string): boolean {
    const textLower = text.toLowerCase();
    const patternLower = pattern.toLowerCase();

    let textIndex = 0;
    let patternIndex = 0;

    while (textIndex < text.length && patternIndex < pattern.length) {
      if (textLower[textIndex] === patternLower[patternIndex]) {
        patternIndex++;
      }
      textIndex++;
    }

    return patternIndex === pattern.length;
  }

  /**
   * Get documentation for a Go package
   * Optimized to return concise results to save LLM context
   */
  private async describeGoPackage(args: GoDocArgs): Promise<DocResult> {
    const { package: packageName, symbol, projectPath } = args;
    this.logger.info(`Getting Go documentation for ${packageName}${symbol ? `.${symbol}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath);

      if (isInstalled) {
        this.logger.info(`Using local documentation for ${packageName}`);
        return await this.getLocalGoDoc(packageName, symbol, projectPath);
      }

      // If not installed, try to fetch from pkg.go.dev
      this.logger.info(`Fetching Go documentation for ${packageName} from pkg.go.dev`);

      try {
        const cmd = symbol
          ? `go doc ${packageName}.${symbol}`
          : `go doc ${packageName}`;
        const { stdout } = await execAsync(cmd);

        // Parse the output into a structured format
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
        // If go doc command fails, suggest installation
        return {
          error: `Package ${packageName} not found. Try installing it with 'go get ${packageName}'`,
          suggestInstall: true
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting Go documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch Go documentation: ${errorMessage}`
      };
    }
  }

  /**
   * Get documentation for a Python package
   * Optimized to return concise results to save LLM context
   */
  private async describePythonPackage(args: PythonDocArgs): Promise<DocResult> {
    const { package: packageName, symbol, projectPath } = args;
    this.logger.info(`Getting Python documentation for ${packageName}${symbol ? `.${symbol}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = await this.isPythonPackageInstalledLocally(packageName, projectPath);

      if (isInstalled) {
        this.logger.info(`Using local documentation for ${packageName}`);
        return await this.getLocalPythonDoc(packageName, symbol, projectPath);
      }

      // If not installed, try to fetch from PyPI
      this.logger.info(`Fetching Python documentation for ${packageName} from PyPI`);

      try {
        const url = `https://pypi.org/pypi/${packageName}/json`;
        const response = await axios.get(url);

        if (response.data && response.data.info) {
          const result: DocResult = {
            description: response.data.info.summary || "No description available"
          };

          // Add more detailed description if available, but limit size
          if (response.data.info.description) {
            // Truncate description to a reasonable length
            const description = response.data.info.description;
            result.usage = description.length > 1000
              ? description.substring(0, 1000) + "... (truncated)"
              : description;
          }

          return result;
        } else {
          return {
            error: `No documentation found for ${packageName} on PyPI`,
            suggestInstall: true
          };
        }
      } catch (error) {
        // If PyPI request fails, suggest installation
        return {
          error: `Package ${packageName} not found. Try installing it with 'pip install ${packageName}'`,
          suggestInstall: true
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting Python documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch Python documentation: ${errorMessage}`
      };
    }
  }

  /**
   * Get documentation for an NPM package
   * Optimized to return concise results to save LLM context
   */
  private async describeNpmPackage(args: NpmDocArgs): Promise<DocResult> {
    const { package: packageName, version, projectPath } = args;
    this.logger.info(`Getting NPM documentation for ${packageName}${version ? `@${version}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath);

      if (isInstalled) {
        this.logger.info(`Using local documentation for ${packageName}`);
        return this.getLocalNpmDoc(packageName, projectPath);
      }

      // If not installed, fetch from npm registry
      this.logger.info(`Fetching NPM documentation for ${packageName} from registry`);

      try {
        const config = this.getRegistryConfigForPackage(packageName, projectPath);
        const headers: Record<string, string> = {};
        if (config.token) {
          headers.Authorization = `Bearer ${config.token}`;
        }

        const versionSuffix = version ? `/${version}` : "";
        const url = `${config.registry}/${packageName}${versionSuffix}`;

        const response = await axios.get(url, { headers });

        if (response.data) {
          const result: DocResult = {
            description: response.data.description || "No description available"
          };

          // Extract usage and examples from README if available, but limit size
          if (response.data.readme) {
            const readme = response.data.readme;
            const sections = readme.split(/#+\s/);

            for (const section of sections) {
              const lower = section.toLowerCase();
              if (lower.startsWith("usage") || lower.startsWith("getting started")) {
                // Truncate usage section to a reasonable length
                const usage = section.split("\n").slice(1).join("\n").trim();
                result.usage = usage.length > 1000
                  ? usage.substring(0, 1000) + "... (truncated)"
                  : usage;
              } else if (lower.startsWith("example")) {
                // Truncate example section to a reasonable length
                const example = section.split("\n").slice(1).join("\n").trim();
                result.example = example.length > 1000
                  ? example.substring(0, 1000) + "... (truncated)"
                  : example;
              }
            }
          }

          return result;
        } else {
          return {
            error: `No documentation found for ${packageName} in npm registry`,
            suggestInstall: true
          };
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          return {
            error: `Package ${packageName} not found. Try installing it with 'npm install ${packageName}'`,
            suggestInstall: true
          };
        }
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting NPM documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch NPM documentation: ${errorMessage}`
      };
    }
  }

  /**
   * Get full documentation for an NPM package
   * Optimized to return concise results to save LLM context
   */
  private async getNpmPackageDoc(args: NpmDocArgs): Promise<DocResult> {
    const { package: packageName, version, projectPath, section, maxLength = 10000, query } = args;
    this.logger.info(`Getting full NPM documentation for ${packageName}${version ? `@${version}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath);
      let readme: string | undefined;
      let packageInfo: any;

      if (isInstalled) {
        this.logger.info(`Using local documentation for ${packageName}`);
        const basePath = projectPath || process.cwd();
        const packagePath = join(basePath, "node_modules", packageName);
        const packageJsonPath = join(packagePath, "package.json");

        // Read package.json
        packageInfo = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

        // Try to find README
        const readmePaths = [
          join(packagePath, "README.md"),
          join(packagePath, "readme.md"),
          join(packagePath, "Readme.md"),
          join(packagePath, "README.markdown"),
          join(packagePath, "README")
        ];

        for (const readmePath of readmePaths) {
          if (existsSync(readmePath)) {
            readme = readFileSync(readmePath, "utf-8");
            break;
          }
        }
      } else {
        // If not installed, fetch from npm registry
        this.logger.info(`Fetching NPM documentation for ${packageName} from registry`);

        const config = this.getRegistryConfigForPackage(packageName, projectPath);
        const headers: Record<string, string> = {};
        if (config.token) {
          headers.Authorization = `Bearer ${config.token}`;
        }

        const versionSuffix = version ? `/${version}` : "";
        const url = `${config.registry}/${packageName}${versionSuffix}`;

        const response = await axios.get(url, { headers });
        packageInfo = response.data;
        readme = packageInfo.readme;
      }

      if (!packageInfo) {
        return {
          error: `No documentation found for ${packageName}`,
          suggestInstall: !isInstalled
        };
      }

      // Build the result
      const result: DocResult = {
        description: packageInfo.description || "No description available"
      };

      // Process README content
      if (readme) {
        // If a specific section is requested
        if (section) {
          const sectionRegex = new RegExp(`#+\\s+${section}`, "i");
          const sections = readme.split(/#+\s/);
          let sectionContent = "";

          for (let i = 0; i < sections.length; i++) {
            const sectionText = sections[i];
            if (sectionRegex.test(sectionText) || sectionText.toLowerCase().startsWith(section.toLowerCase())) {
              // Found the requested section
              sectionContent = sectionText;
              break;
            }
          }

          if (sectionContent) {
            result.usage = sectionContent.length > maxLength
              ? sectionContent.substring(0, maxLength) + "... (truncated)"
              : sectionContent;
          } else {
            result.error = `Section '${section}' not found in documentation`;
          }
        } else if (query) {
          // If a search query is provided
          const lines = readme.split('\n');
          const matchingLines: string[] = [];

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              const contextStart = Math.max(0, i - 2);
              const contextEnd = Math.min(lines.length, i + 3);
              matchingLines.push(...lines.slice(contextStart, contextEnd), "");
            }
          }

          if (matchingLines.length > 0) {
            const content = matchingLines.join('\n');
            result.usage = content.length > maxLength
              ? content.substring(0, maxLength) + "... (truncated)"
              : content;
          } else {
            result.error = `No matches found for '${query}' in documentation`;
          }
        } else {
          // Return the full README, but truncated if necessary
          result.usage = readme.length > maxLength
            ? readme.substring(0, maxLength) + "... (truncated)"
            : readme;
        }
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error getting full NPM documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch NPM documentation: ${errorMessage}`
      };
    }
  }
}

// Initialize and run the server
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
