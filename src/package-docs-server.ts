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
import { NodeHtmlMarkdown } from 'node-html-markdown';

import { logger, McpLogger } from './logger.js';
import { NpmDocsHandler, NpmDocArgs, isNpmDocArgs } from './npm-docs-integration.js';
import { SearchUtils, DocResult, SearchDocArgs, GoDocArgs, PythonDocArgs, isSearchDocArgs, isGoDocArgs, isPythonDocArgs, SearchResults } from './search-utils.js';
import Fuse from "fuse.js";
import { RegistryUtils } from './registry-utils.js';
import TypeScriptLspClient from "./lsp/typescript-lsp-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
);

const execAsync = promisify(exec);

// Initialize HTML to Markdown converter with custom options
const nhm = new NodeHtmlMarkdown({
  // Configuration options for better Markdown output
  useInlineLinks: true,
  maxConsecutiveNewlines: 2,
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  keepDataImages: false
});

export class PackageDocsServer {
  private server: Server;
  private cache: Map<string, DocResult>;
  private logger: McpLogger;
  private lspClient?: TypeScriptLspClient;
  private lspEnabled: boolean;
  private npmDocsHandler: NpmDocsHandler;
  private searchUtils: SearchUtils;
  private registryUtils: RegistryUtils;

  /**
   * Connect the server to a transport
   */
  public async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport);
  }

  constructor() {
    this.logger = logger.child('PackageDocs');
    this.npmDocsHandler = new NpmDocsHandler();
    this.searchUtils = new SearchUtils(logger);
    this.registryUtils = new RegistryUtils(logger);

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
  }

  private setupToolHandlers(): void {
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
            result = await this.npmDocsHandler.describeNpmPackage(
              request.params.arguments,
              this.registryUtils.getRegistryConfigForPackage.bind(this.registryUtils),
              this.isNpmPackageInstalledLocally.bind(this),
              this.getLocalNpmDoc.bind(this)
            );
            break;

          case "get_npm_package_doc":
            if (!isNpmDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid get_npm_package_doc arguments"
              );
            }
            result = await this.npmDocsHandler.getNpmPackageDoc(
              request.params.arguments,
              this.registryUtils.getRegistryConfigForPackage.bind(this.registryUtils),
              this.isNpmPackageInstalledLocally.bind(this),
              this.getLocalNpmDoc.bind(this)
            );
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

  /**
   * Search for content within package documentation
   * Enhanced to provide more comprehensive context in search results
   */
  private async searchPackageDocs(args: SearchDocArgs): Promise<DocResult> {
    const { package: packageName, query, language, fuzzy = true, projectPath } = args;
    this.logger.info(`Searching ${language} package ${packageName} for "${query}"`);

    try {
      let docContent: string | Array<{ content: string; type: string }> = "";
      let isInstalled = false;
      let packageInfo: any = null;

      // Check if package is installed locally first
      switch (language) {
        case "go":
          isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath);
          if (isInstalled) {
            const localDoc = await this.getLocalGoDoc(packageName, undefined, projectPath);
            if (!localDoc.error) {
              docContent = this.searchUtils.parseGoDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              );
            }
          } else {
            // Fetch from pkg.go.dev
            try {
              const { stdout } = await execAsync(`go doc ${packageName}`)
              docContent = this.searchUtils.parseGoDoc(stdout);
            } catch (error) {
              // Try to get package info from go.dev API if available
              try {
                const url = `https://pkg.go.dev/api/packages/${encodeURIComponent(packageName)}`
                const response = await axios.get(url).catch(() => null)
                if (response && response.data) {
                  packageInfo = response.data
                  if (packageInfo.Documentation) {
                    docContent = [
                      { content: packageInfo.Synopsis || "", type: "description" },
                      { content: packageInfo.Documentation || "", type: "documentation" }
                    ]
                  }
                }
              } catch (apiError) {
                this.logger.error(`Error fetching Go package info: ${apiError}`)
              }
            }
          }
          break;

        case "python":
          isInstalled = await this.isPythonPackageInstalledLocally(packageName, projectPath);
          if (isInstalled) {
            const localDoc = await this.getLocalPythonDoc(packageName, undefined, projectPath);
            if (!localDoc.error) {
              docContent = this.searchUtils.parsePythonDoc(
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
              packageInfo = response.data.info

              // Extract more comprehensive information
              const description = packageInfo.summary || ""
              const longDescription = packageInfo.description || ""

              // Try to parse the long description as markdown/rst
              docContent = [
                { content: description, type: "description" },
                { content: longDescription, type: "documentation" }
              ];

              // Convert docContent to array if it's a string
              if (typeof docContent === "string") {
                docContent = [
                  { content: description, type: "description" },
                  { content: longDescription, type: "documentation" }
                ]
              }

              // Add project URLs if available
              if (packageInfo.project_urls) {
                let urlsContent = "### Project URLs\n\n"
                for (const [name, url] of Object.entries(packageInfo.project_urls)) {
                  urlsContent += `- ${name}: ${url}\n`
                }
                if (Array.isArray(docContent)) {
                  docContent.push({ content: urlsContent, type: "links" })
                }
              }

              // Add classifiers if available
              if (packageInfo.classifiers && packageInfo.classifiers.length > 0) {
                const classifiersContent = "### Classifiers\n\n- " +
                  packageInfo.classifiers.join("\n- ")
                if (Array.isArray(docContent)) {
                  docContent.push({ content: classifiersContent, type: "metadata" })
                }
              }
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

            // Try to get additional information from package.json
            try {
              const basePath = projectPath || process.cwd()
              const packagePath = join(basePath, "node_modules", packageName)
              const packageJsonPath = join(packagePath, "package.json")

              if (existsSync(packageJsonPath)) {
                packageInfo = JSON.parse(readFileSync(packageJsonPath, "utf-8"))

                // Add dependencies information
                if (packageInfo.dependencies || packageInfo.devDependencies) {
                  let depsContent = "### Dependencies\n\n"

                  if (packageInfo.dependencies) {
                    depsContent += "#### Runtime Dependencies\n\n"
                    for (const [dep, version] of Object.entries(packageInfo.dependencies)) {
                      depsContent += `- ${dep}: ${version}\n`
                    }
                    depsContent += "\n"
                  }

                  if (packageInfo.devDependencies) {
                    depsContent += "#### Development Dependencies\n\n"
                    for (const [dep, version] of Object.entries(packageInfo.devDependencies)) {
                      depsContent += `- ${dep}: ${version}\n`
                    }
                  }

                  if (Array.isArray(docContent)) {
                    docContent.push({ content: depsContent, type: "dependencies" })
                  }
                }
              }
            } catch (error) {
              this.logger.error(`Error reading package.json: ${error}`)
            }
          } else {
            // Fetch from npm registry
            const config = this.registryUtils.getRegistryConfigForPackage(packageName, projectPath);
            const headers: Record<string, string> = {};
            if (config.token) {
              headers.Authorization = `Bearer ${config.token}`;
            }

            const url = `${config.registry}/${packageName}`;
            const response = await axios.get(url, { headers });
            if (response.data) {
              packageInfo = response.data

              // Parse README and other metadata
              docContent = this.searchUtils.parseNpmDoc(packageInfo)

              // Add additional sections with more comprehensive information

              // Add dependencies information
              if (packageInfo.dependencies || packageInfo.devDependencies) {
                let depsContent = "### Dependencies\n\n"

                if (packageInfo.dependencies) {
                  depsContent += "#### Runtime Dependencies\n\n"
                  for (const [dep, version] of Object.entries(packageInfo.dependencies)) {
                    depsContent += `- ${dep}: ${version}\n`
                  }
                  depsContent += "\n"
                }

                if (packageInfo.devDependencies) {
                  depsContent += "#### Development Dependencies\n\n"
                  for (const [dep, version] of Object.entries(packageInfo.devDependencies)) {
                    depsContent += `- ${dep}: ${version}\n`
                  }
                }

                docContent.push({ content: depsContent, type: "dependencies" })
              }

              // Add TypeScript information if available
              if (packageInfo.types || packageInfo.typings && Array.isArray(docContent)) {
                docContent.push({
                  content: `### TypeScript Support\n\nThis package includes TypeScript type definitions (${packageInfo.types || packageInfo.typings}).`,
                  type: "typescript"
                })
              }
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
      const searchResults: any[] = [];

      if (Array.isArray(docContent)) {
        // For structured content (array of sections)
        if (fuzzy) {
          // Use fuzzy search with improved options
          const fuseOptions = {
            includeScore: true,
            threshold: 0.4,
            keys: ['content'],
            // Improved options for better matching
            ignoreLocation: true,
            findAllMatches: true
          };

          const fuse = new Fuse(docContent, fuseOptions);
          const results = fuse.search(query);

          for (const result of results) {
            const section = result.item;
            const symbol = this.searchUtils.extractSymbol(section.content, language);

            // Extract more context around the match
            const lines = section.content.split('\n');
            const firstLine = lines[0];

            // Find the specific line that contains the match
            let matchLineIndex = -1
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matchLineIndex = i
                break
              }
            }

            // Extract more context around the match
            let contextLines: string[]
            if (matchLineIndex >= 0) {
              // Get more context around the specific match
              const contextStart = Math.max(0, matchLineIndex - 5)
              const contextEnd = Math.min(lines.length, matchLineIndex + 10)
              contextLines = lines.slice(contextStart, contextEnd)
            } else {
              // If no specific match found, take the first several lines
              contextLines = lines.slice(1, Math.min(lines.length, 15))
            }

            // Include code examples in the context if present
            const codeExampleMatch = section.content.match(/```[\s\S]*?```/)
            if (codeExampleMatch && !contextLines.some(line => line.includes("```"))) {
              contextLines.push("") // Add a blank line
              contextLines.push("Code example:")
              contextLines.push(codeExampleMatch[0])
            }

            searchResults.push({
              symbol,
              match: firstLine,
              context: contextLines.join('\n'),
              score: result.score || 0,
              type: section.type
            });
          }
        } else {
          // Use exact search with improved context
          for (const section of docContent) {
            if (section.content.toLowerCase().includes(query.toLowerCase())) {
              const symbol = this.searchUtils.extractSymbol(section.content, language);
              const lines = section.content.split('\n');
              const firstLine = lines[0];

              // Find the specific line that contains the match
              let matchLineIndex = -1
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                  matchLineIndex = i
                  break
                }
              }

              // Extract more context around the match
              let contextLines: string[]
              if (matchLineIndex >= 0) {
                // Get more context around the specific match
                const contextStart = Math.max(0, matchLineIndex - 5)
                const contextEnd = Math.min(lines.length, matchLineIndex + 10)
                contextLines = lines.slice(contextStart, contextEnd)
              } else {
                // If no specific match found, take the first several lines
                contextLines = lines.slice(1, Math.min(lines.length, 15))
              }

              // Include code examples in the context if present
              const codeExampleMatch = section.content.match(/```[\s\S]*?```/)
              if (codeExampleMatch && !contextLines.some(line => line.includes("```"))) {
                contextLines.push("") // Add a blank line
                contextLines.push("Code example:")
                contextLines.push(codeExampleMatch[0])
              }

              searchResults.push({
                symbol,
                match: firstLine,
                context: contextLines.join('\n'),
                score: 0,
                type: section.type
              });
            }
          }
        }
      } else {
        // For plain text content
        const lines = docContent.split('\n');

        // Find all matching lines
        const matchingLineIndices: number[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (fuzzy) {
            if (this.searchUtils.fuzzyMatch(line, query)) {
              matchingLineIndices.push(i)
            }
          } else if (line.toLowerCase().includes(query.toLowerCase())) {
            matchingLineIndices.push(i)
          }
        }

        // Group nearby matches to avoid duplicate context
        const groupedMatches: number[][] = []
        let currentGroup: number[] = []

        for (let i = 0; i < matchingLineIndices.length; i++) {
          if (i === 0 || matchingLineIndices[i] > matchingLineIndices[i - 1] + 10) {
            if (currentGroup.length > 0) {
              groupedMatches.push(currentGroup)
            }
            currentGroup = [matchingLineIndices[i]]
          } else {
            currentGroup.push(matchingLineIndices[i])
          }
        }

        if (currentGroup.length > 0) {
          groupedMatches.push(currentGroup)
        }

        // Process each group of matches
        for (const group of groupedMatches) {
          const firstMatchIndex = group[0]
          const lastMatchIndex = group[group.length - 1]

          // Get context around the group
          const contextStart = Math.max(0, firstMatchIndex - 5)
          const contextEnd = Math.min(lines.length, lastMatchIndex + 10)
          const context = lines.slice(contextStart, contextEnd).join('\n');

          // Find a suitable heading for this match
          let heading = "Match"
          for (let i = firstMatchIndex; i >= 0; i--) {
            if (lines[i].startsWith('#')) {
              heading = lines[i]
              break
            }
          }

          searchResults.push({
            match: heading,
            context,
            score: 0
          })
        }
      }

      // Sort results by score (lower is better)
      searchResults.sort((a, b) => a.score - b.score);

      // Limit number of results but ensure we have enough context
      const limitedResults = searchResults.slice(0, 5)

      // Add package metadata to provide context
      let packageMetadata = ""
      if (packageInfo) {
        packageMetadata = `Package: ${packageName}\n`

        if (language === "npm") {
          if (packageInfo.version) packageMetadata += `Version: ${packageInfo.version}\n`
          if (packageInfo.description) packageMetadata += `Description: ${packageInfo.description}\n`
          if (packageInfo.homepage) packageMetadata += `Homepage: ${packageInfo.homepage}\n`
          if (packageInfo.license) packageMetadata += `License: ${packageInfo.license}\n`
        } else if (language === "python") {
          if (packageInfo.version) packageMetadata += `Version: ${packageInfo.version}\n`
          if (packageInfo.summary) packageMetadata += `Description: ${packageInfo.summary}\n`
          if (packageInfo.home_page) packageMetadata += `Homepage: ${packageInfo.home_page}\n`
          if (packageInfo.license) packageMetadata += `License: ${packageInfo.license}\n`
        }
      }

      return {
        description: packageMetadata || undefined,
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
}
