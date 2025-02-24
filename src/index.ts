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

  constructor() {
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
    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
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

    console.error("Loading npm configuration...");
    console.error("Project directory:", projectPath || "not specified");

    // First read global .npmrc as base configuration
    const globalNpmrcPath = pathJoin(homedir(), ".npmrc");
    console.error("Checking global .npmrc at:", globalNpmrcPath);
    if (existsSync(globalNpmrcPath)) {
      try {
        console.error("Found global .npmrc");
        const npmrcContent = readFileSync(globalNpmrcPath, "utf-8");
        console.error("Global .npmrc content:", npmrcContent);
        this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
      } catch (error) {
        console.error("Error reading global .npmrc:", error);
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
        console.error("Checking for .npmrc at:", localNpmrcPath);
        if (existsSync(localNpmrcPath)) {
          try {
            console.error("Found .npmrc at:", localNpmrcPath);
            const npmrcContent = readFileSync(localNpmrcPath, "utf-8");
            console.error("Content:", npmrcContent);
            this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
          } catch (error) {
            console.error(`Error reading local .npmrc at ${localNpmrcPath}:`, error);
          }
        }
      }
    }

    try {
      // Associate tokens with registries
      console.error("Scope to Registry mappings:", Object.fromEntries(scopeToRegistry));
      console.error("Registry to Token mappings:", Object.fromEntries(registryToToken));

      for (const [scope, registry] of scopeToRegistry.entries()) {
        const hostname = new URL(registry).host;
        const token = registryToToken.get(hostname);
        console.error(`Setting config for scope ${scope}:`, { registry, token: token ? "[REDACTED]" : undefined });
        registryMap.set(scope, { registry, token });
      }

      // Ensure default registry has its token if available
      const defaultConfig = registryMap.get("default");
      if (defaultConfig) {
        const hostname = new URL(defaultConfig.registry).host;
        const token = registryToToken.get(hostname);
        if (token) {
          console.error("Setting token for default registry");
          registryMap.set("default", { ...defaultConfig, token });
        }
      }

      console.error("Final registry configurations:",
        Object.fromEntries(Array.from(registryMap.entries()).map(([k, v]) => [
          k,
          { registry: v.registry, token: v.token ? "[REDACTED]" : undefined }
        ]))
      );
    } catch (error) {
      console.error("Error processing .npmrc configurations:", error);
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

      this.cache.set(cacheKey, result);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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

      return {
        error: `Failed to fetch NPM documentation (${statusCode || 'unknown status'}): ${errorMessage}`,
      };
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

      // Get and parse documentation based on language
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
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search documentation: ${error instanceof Error ? error.message : String(error)}`
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
