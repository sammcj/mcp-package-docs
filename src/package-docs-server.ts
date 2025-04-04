import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { getToolDefinitions } from "./tool-handlers.js"
import { exec } from "child_process"
import { promisify } from "util"
import axios from "axios"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { readFileSync, existsSync } from "fs"
import { logger, McpLogger } from './logger.js'
import { NpmDocsHandler, NpmDocArgs, isNpmDocArgs } from './npm-docs-integration.js'
import { SearchUtils, DocResult, SearchDocArgs, GoDocArgs, PythonDocArgs, SwiftDocArgs, isSearchDocArgs, isGoDocArgs, isPythonDocArgs, isSwiftDocArgs } from './search-utils.js'
import Fuse from "fuse.js"
import { RegistryUtils } from './registry-utils.js'
import TypeScriptLspClient from "./lsp/typescript-lsp-client.js"
import { RustDocsHandler } from "./rust-docs-integration.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
)

const execAsync = promisify(exec)


export class PackageDocsServer {
  private server: Server
  private cache: Map<string, DocResult>
  private logger: McpLogger
  private lspClient?: TypeScriptLspClient
  private lspEnabled: boolean
  private npmDocsHandler: NpmDocsHandler
  private rustDocsHandler: RustDocsHandler
  private searchUtils: SearchUtils
  private registryUtils: RegistryUtils

  /**
   * Connect the server to a transport
   */
  public async connect(transport: StdioServerTransport): Promise<void> {
    await this.server.connect(transport)
  }

  constructor() {
    this.logger = logger.child('PackageDocs')
    this.npmDocsHandler = new NpmDocsHandler()
    this.rustDocsHandler = new RustDocsHandler(logger)
    this.searchUtils = new SearchUtils(logger)
    this.registryUtils = new RegistryUtils(logger)

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
    )

    this.cache = new Map()

    // Check if LSP functionality is enabled via environment variable
    this.lspEnabled = process.env.ENABLE_LSP === "true"
    if (this.lspEnabled) {
      this.logger.debug("Language Server Protocol support is enabled")
      try {
        this.lspClient = new TypeScriptLspClient()
        this.logger.debug("TypeScript Language Server client initialized successfully")
      } catch {
        this.logger.error("Failed to initialize TypeScript Language Server client")
        this.lspEnabled = false
      }
    } else {
      this.logger.debug("Language Server Protocol support is disabled")
    }

    this.setupToolHandlers()
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return getToolDefinitions(this.lspEnabled, this.lspClient)
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!request.params.arguments) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments are required")
      }

      // Handle LSP tools if enabled
      if (this.lspEnabled && this.lspClient) {
        if (request.params.name === "get_hover") {
          return await this.handleGetHover(request.params.arguments as { languageId: string; filePath: string; content: string; line: number; character: number; projectRoot: string })
        } else if (request.params.name === "get_completions") {
          return await this.handleGetCompletions(request.params.arguments as { languageId: string; filePath: string; content: string; line: number; character: number; projectRoot: string })
        } else if (request.params.name === "get_diagnostics") {
          return await this.handleGetDiagnostics(request.params.arguments as { languageId: string; filePath: string; content: string; projectRoot: string })
        }
      }

      // Handle regular package documentation tools
      const cacheKey = JSON.stringify({
        name: request.params.name,
        args: request.params.arguments,
      })

      // Check cache first
      const cachedResult = this.cache.get(cacheKey)
      if (cachedResult) {
        this.logger.debug(`Cache hit for ${request.params.name}`)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cachedResult),
            },
          ],
        }
      }

      try {
        let result: DocResult

        switch (request.params.name) {
          case "search_package_docs":
            if (!isSearchDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid search_package_docs arguments"
              )
            }
            result = await this.searchPackageDocs(request.params.arguments)
            break;

          case "describe_rust_package":
            result = await this.describeRustPackage(request.params.arguments as { package: string, version?: string })
            break

          case "describe_go_package":
          case "lookup_go_doc":
            if (!isGoDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_go_package arguments"
              )
            }
            result = await this.describeGoPackage(request.params.arguments)
            break

          case "describe_python_package":
          case "lookup_python_doc":
            if (!isPythonDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_python_package arguments"
              )
            }
            result = await this.describePythonPackage(request.params.arguments)
            break

          case "describe_npm_package":
          case "lookup_npm_doc":
            if (!isNpmDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_npm_package arguments"
              )
            }
            result = await this.npmDocsHandler.describeNpmPackage(
              request.params.arguments,
              this.registryUtils.getRegistryConfigForPackage.bind(this.registryUtils),
              this.isNpmPackageInstalledLocally.bind(this),
              this.getLocalNpmDoc.bind(this)
            )
            break

          case "describe_swift_package":
            if (!isSwiftDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid describe_swift_package arguments"
              )
            }
            result = await this.describeSwiftPackage(request.params.arguments)
            break

          case "get_npm_package_doc":
            if (!isNpmDocArgs(request.params.arguments)) {
              throw new McpError(
                ErrorCode.InvalidParams,
                "Invalid get_npm_package_doc arguments"
              )
            }
            result = await this.getNpmPackageDoc(request.params.arguments)
            break

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            )
        }

        // Cache the result
        this.cache.set(cacheKey, result)

        // For get_npm_package_doc, return the markdown content directly
        if (request.params.name === "get_npm_package_doc") {
          // Combine description, usage, and example into a single markdown document
          let markdown = ""

          if (result.description) {
            markdown += `# ${request.params.arguments.package}\n\n${result.description}\n\n`
          }

          if (result.usage) {
            markdown += result.usage
          }

          // Only add examples if they're not already included in usage
          if (result.example && !result.usage?.includes(result.example)) {
            markdown += `\n\n## Additional Examples\n\n${result.example}`
          }

          return {
            content: [
              {
                type: "text",
                text: markdown,
              },
            ],
          }
        } else {
          // For other tools, return the result as JSON
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result),
              },
            ],
          }
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error
        }

        const errorMessage =
          error instanceof Error ? error.message : String(error)
        this.logger.error(`Error in ${request.params.name}:`, error)

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
        }
      }
    })

  }

    /**
   * Check if a Rust crate is installed locally
   */
    private async isRustCrateInstalledLocally(crateName: string, projectPath?: string): Promise<boolean> {
        try {
            // Check if the project has a Cargo.toml file
            const cargoTomlPath = projectPath ? join(projectPath, "Cargo.toml") : "Cargo.toml";
            if (existsSync(cargoTomlPath)) {
                const cargoToml = readFileSync(cargoTomlPath, "utf-8");
                // Simple check if the crate is mentioned in Cargo.toml
                if (cargoToml.includes(crateName)) {
                    return true;
                }
            }

            // TODO: More sophisticated checks, e.g., looking in target/debug or target/release

            return false; // Assume not installed if no Cargo.toml or not found
        } catch {
            // If any error occurs, assume the crate is not installed
            return false;
        }
    }

      /**
     * Get documentation from a locally installed Rust crate
     */
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private async getLocalRustDoc(crateName: string): Promise<DocResult> {
        try {
            // TODO: Implement getting documentation from local target/doc directory
            // This is a placeholder for now
            return {
                error: "Local Rust documentation retrieval not yet implemented",
            };
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            return {
                error: `Failed to fetch local Rust documentation: ${errorMessage}`,
            };
        }
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
    } catch {
      // If the command fails, the package is likely not installed
      return false
    }
  }

  /**
   * Check if a Python package is installed locally
   */
  private async isPythonPackageInstalledLocally(packageName: string): Promise<boolean> {
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
    } catch {
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
    } catch {
      return false
    }
  }

  /**
   * Check if a Swift package is installed locally
   */
  private async isSwiftPackageInstalledLocally(packageUrl: string, projectPath?: string): Promise<boolean> {
    try {
      // Check if the project has a Package.swift file
      const packageSwiftPath = projectPath ? join(projectPath, "Package.swift") : "Package.swift"
      if (existsSync(packageSwiftPath)) {
        const packageSwift = readFileSync(packageSwiftPath, "utf-8")

        // Extract the package name from the URL
        const packageName = this.extractSwiftPackageNameFromUrl(packageUrl)

        // Simple check if the package is mentioned in Package.swift
        if (packageName && (packageSwift.includes(packageUrl) || packageSwift.includes(packageName))) {
          return true
        }
      }

      return false
    } catch {
      return false
    }
  }

  /**
   * Get documentation from a locally installed Go package
   */
  private async getLocalGoDoc(packageName: string, symbol?: string): Promise<DocResult> {
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
  private async getLocalPythonDoc(packageName: string, symbol?: string): Promise<DocResult> {
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
   * Get documentation from a locally installed Swift package
   */
  private async getLocalSwiftDoc(packageUrl: string, symbol?: string, projectPath?: string): Promise<DocResult> {
    try {
      const packageName = this.extractSwiftPackageNameFromUrl(packageUrl)
      if (!packageName) {
        return {
          error: "Could not extract package name from URL"
        }
      }

      // Try to get documentation using swift-doc if available
      try {
        const cmd = symbol
          ? `swift doc generate ${packageName} --module-name ${packageName} --symbol ${symbol}`
          : `swift doc generate ${packageName} --module-name ${packageName}`

        const { stdout } = await execAsync(cmd)
        return {
          description: stdout.trim()
        }
      } catch {
        // If swift-doc fails, try to extract info from Package.swift
        const packageSwiftPath = projectPath ? join(projectPath, "Package.swift") : "Package.swift"
        if (existsSync(packageSwiftPath)) {
          const packageSwift = readFileSync(packageSwiftPath, "utf-8")

          // Try to find the package declaration
          const packageRegex = new RegExp(`\\b${packageName}\\b[\\s\\S]*?\\{[\\s\\S]*?\\}`, "i")
          const packageMatch = packageSwift.match(packageRegex)

          if (packageMatch) {
            return {
              description: `Swift package: ${packageName}`,
              usage: packageMatch[0]
            }
          }
        }

        // If we still don't have documentation, check for a README
        const readmePaths = [
          projectPath ? join(projectPath, "README.md") : "README.md",
          projectPath ? join(projectPath, "readme.md") : "readme.md"
        ]

        for (const readmePath of readmePaths) {
          if (existsSync(readmePath)) {
            const readme = readFileSync(readmePath, "utf-8")

            // Extract sections related to the package
            const sections = readme.split(/#+\s/)
            const relevantSections = sections.filter(section =>
              section.toLowerCase().includes(packageName.toLowerCase())
            )

            if (relevantSections.length > 0) {
              return {
                description: `Swift package: ${packageName}`,
                usage: relevantSections.join("\n\n")
              }
            } else {
              // If no specific sections mention the package, return a summary
              return {
                description: `Swift package: ${packageName}`,
                usage: "See README for usage details."
              }
            }
          }
        }
      }

      return {
        description: `Swift package: ${packageName}`,
        usage: "No detailed documentation available locally."
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return {
        error: `Failed to fetch local Swift documentation: ${errorMessage}`,
      }
    }
  }

  /**
   * Extract Swift package name from URL
   */
  private extractSwiftPackageNameFromUrl(url: string): string | null {
    try {
      // Extract the last part of the URL path
      const urlObj = new URL(url)
      const pathParts = urlObj.pathname.split('/')
      const lastPart = pathParts[pathParts.length - 1]

      // Remove .git extension if present
      return lastPart.replace(/\.git$/, '')
    } catch {
      // If the URL is invalid, try to extract the name from the string
      const parts = url.split('/')
      const lastPart = parts[parts.length - 1]
      return lastPart.replace(/\.git$/, '')
    }
  }

  /**
   * Search for content within package documentation
   * Enhanced to provide more comprehensive context in search results
   */
  private async searchPackageDocs(args: SearchDocArgs): Promise<DocResult> {
    const { package: packageName, query, language, fuzzy = true, projectPath } = args
    const packageUrl = packageName
    this.logger.debug(`Searching ${language} package ${packageName} for "${query}"`)

    try {
      let docContent: string | Array<{ content: string; type: string }> = ""
      let isInstalled = false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let packageInfo: any = null

      // Check if package is installed locally first
      switch (language) {
        case "rust":
          isInstalled = await this.isRustCrateInstalledLocally(packageName)
          if (isInstalled) {
            const localDoc = await this.getLocalRustDoc(packageName)
            if (!localDoc.error) {
              docContent = [
                { content: localDoc.description || "", type: "description" },
                { content: localDoc.usage || "", type: "usage" },
                { content: localDoc.example || "", type: "example" }
              ].filter(item => item.content)
            }
          } else {
            // If not installed, try to fetch from docs.rs and crates.io
            try {
              // Get crate details from crates.io
              const crateDetails = await this.rustDocsHandler.getCrateDetails(packageName)

              // Get documentation from docs.rs
              const documentation = await this.rustDocsHandler.getCrateDocumentation(packageName)

              // Parse the documentation into sections
              const sections = documentation.split(/#+\s+/m)

              docContent = []

              // Add description
              if (crateDetails.description) {
                docContent.push({
                  content: crateDetails.description,
                  type: "description"
                })
              }

              // Process each section
              for (const section of sections) {
                if (!section.trim()) continue

                const lines = section.split('\n')
                const heading = lines[0].toLowerCase()
                const content = lines.join('\n')

                let type = "general"
                if (heading.includes("example")) type = "example"
                else if (heading.includes("usage") || heading.includes("getting started")) type = "usage"
                else if (heading.includes("struct") || heading.includes("enum") || heading.includes("trait")) type = "type"
                else if (heading.includes("function") || heading.includes("method")) type = "function"

                docContent.push({ content, type })
              }

              // Add package metadata
              packageInfo = crateDetails
            } catch (error) {
              this.logger.error(`Error fetching Rust documentation: ${error}`)
            }
          }
          break

        case "go":
          isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath)
          if (isInstalled) {
            const localDoc = await this.getLocalGoDoc(packageName, undefined)
            if (!localDoc.error) {
              docContent = this.searchUtils.parseGoDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              )
            }
          } else {
            // Fetch from pkg.go.dev using multiple methods
            let docFetched = false

            // First try using go doc command (works for standard library and cached modules)
            try {
              const { stdout } = await execAsync(`go doc ${packageName}`)
              docContent = this.searchUtils.parseGoDoc(stdout)
              docFetched = true
            } catch (cmdError) {
              this.logger.debug(`go doc command failed for ${packageName}: ${cmdError}`)
            }

            // If go doc command fails, try to get package info from pkg.go.dev API
            if (!docFetched) {
              try {
                const url = `https://pkg.go.dev/api/packages/${encodeURIComponent(packageName)}`
                this.logger.debug(`Fetching from pkg.go.dev API: ${url}`)

                const response = await axios.get(url)

                if (response.data) {
                  packageInfo = response.data
                  if (packageInfo.Documentation || packageInfo.Synopsis) {
                    docContent = [
                      { content: packageInfo.Synopsis || `Go package: ${packageName}`, type: "description" },
                      { content: packageInfo.Documentation || "", type: "documentation" }
                    ]
                    docFetched = true
                  }
                }
              } catch (apiError) {
                this.logger.debug(`Error fetching from pkg.go.dev API: ${apiError}`)
              }
            }

            // If API fails, try to fetch from GitHub if it's a GitHub URL
            if (!docFetched && packageName.includes('github.com')) {
              try {
                // Extract GitHub owner and repo from the package name
                const githubMatch = packageName.match(/github\.com\/([^\/]+)\/([^\/]+)/)
                if (githubMatch) {
                  const owner = githubMatch[1]
                  const repo = githubMatch[2]

                  // Try to fetch README.md from the main branch
                  const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`
                  this.logger.debug(`Attempting to fetch README from GitHub for search: ${readmeUrl}`)

                  const readmeResponse = await axios.get(readmeUrl)
                  if (readmeResponse.data) {
                    const readme = readmeResponse.data

                    // Parse the README content into sections
                    const sections = readme.split(/#+\s/)

                    // Create structured content from README sections
                    docContent = []

                    // Add a general description section
                    if (sections.length > 0) {
                      docContent.push({
                        content: sections[0],
                        type: "description"
                      })
                    }

                    // Process each section
                    for (let i = 1; i < sections.length; i++) {
                      const section = sections[i]
                      if (!section.trim()) continue

                      const lines = section.split('\n')
                      const heading = lines[0].toLowerCase()

                      // Determine section type
                      let type = "general"
                      if (heading.includes("example") || heading.includes("usage example")) {
                        type = "example"
                      } else if (heading.includes("usage") || heading.includes("getting started") ||
                                heading.includes("quickstart") || heading.includes("installation")) {
                        type = "usage"
                      } else if (heading.includes("api") || heading.includes("reference") ||
                                heading.includes("function") || heading.includes("method")) {
                        type = "api"
                      } else if (heading.includes("config") || heading.includes("configuration")) {
                        type = "configuration"
                      }

                      docContent.push({
                        content: section,
                        type: type
                      })
                    }

                    // Add import example
                    docContent.push({
                      content: `// Import the package\nimport "${packageName}"\n\n// For more details, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`,
                      type: "example"
                    })

                    docFetched = true
                  }
                }
              } catch (githubError) {
                this.logger.debug(`Error fetching from GitHub for search: ${githubError}`)
              }
            }

            // If GitHub fetch fails or it's not a GitHub URL, try web scraping approach
            if (!docFetched) {
              try {
                const url = `https://pkg.go.dev/${encodeURIComponent(packageName)}`
                this.logger.debug(`Attempting to fetch documentation from: ${url}`)

                const response = await axios.get(url)

                if (response.data) {
                  // Extract basic package information from HTML
                  const html = response.data

                  // Simple extraction of package description
                  const descriptionMatch = html.match(/<meta name="description" content="([^"]+)"/)
                  const description = descriptionMatch ? descriptionMatch[1] : `Go package: ${packageName}`

                  // Try to extract documentation content
                  const docMatch = html.match(/<div class="Documentation-content">[\s\S]*?<\/div>/)
                  let documentation = docMatch ? docMatch[0] : ""

                  // Try to extract package overview
                  const overviewMatch = html.match(/<section id="pkg-overview"[\s\S]*?<\/section>/)
                  const overview = overviewMatch ? overviewMatch[0] : ""

                  // Try to extract constants
                  const constantsMatch = html.match(/<section id="pkg-constants"[\s\S]*?<\/section>/)
                  const constants = constantsMatch ? constantsMatch[0] : ""

                  // Try to extract variables
                  const variablesMatch = html.match(/<section id="pkg-variables"[\s\S]*?<\/section>/)
                  const variables = variablesMatch ? variablesMatch[0] : ""

                  // Try to extract functions
                  const functionsMatch = html.match(/<section id="pkg-functions"[\s\S]*?<\/section>/)
                  const functions = functionsMatch ? functionsMatch[0] : ""

                  // Try to extract types
                  const typesMatch = html.match(/<section id="pkg-types"[\s\S]*?<\/section>/)
                  const types = typesMatch ? typesMatch[0] : ""

                  // Extract code examples if available
                  const examplesMatch = html.match(/<pre class="Documentation-exampleCode">[\s\S]*?<\/pre>/g)
                  const examples = examplesMatch ? examplesMatch.join("\n\n") : ""

                  // Extract API documentation - look for function and type definitions
                  const apiDocsMatch = html.match(/<h3 id="[^"]*">[\s\S]*?<pre[\s\S]*?<\/pre>/g) || []
                  const apiDocs = apiDocsMatch.join("\n\n")

                  // Extract function signatures
                  const funcSignatures: string[] = []
                  const funcSignatureMatches = html.matchAll(/<h3 id="([^"]*)">func\s+([^<]+)<\/h3>/g)
                  for (const match of funcSignatureMatches) {
                    funcSignatures.push(`func ${match[2]}`)
                  }

                  // Extract type definitions
                  const typeDefinitions: string[] = []
                  const typeDefMatches = html.matchAll(/<h3 id="([^"]*)">type\s+([^<]+)<\/h3>/g)
                  for (const match of typeDefMatches) {
                    typeDefinitions.push(`type ${match[2]}`)
                  }

                  // Clean up HTML tags from the extracted content
                  const cleanHtml = (html: string): string => {
                    return html
                      .replace(/<[^>]*>/g, '') // Remove HTML tags
                      .replace(/&lt;/g, '<')   // Replace HTML entities
                      .replace(/&gt;/g, '>')
                      .replace(/&amp;/g, '&')
                      .replace(/&quot;/g, '"')
                      .replace(/&#39;/g, "'")
                      .replace(/\s+/g, ' ')    // Normalize whitespace
                      .trim();
                  };

                  // Combine all the extracted content
                  documentation = [
                    overview ? cleanHtml(overview) : "",
                    constants ? cleanHtml(constants) : "",
                    variables ? cleanHtml(variables) : "",
                    functions ? cleanHtml(functions) : "",
                    types ? cleanHtml(types) : "",
                    documentation ? cleanHtml(documentation) : "",
                    apiDocs ? cleanHtml(apiDocs) : "",
                    funcSignatures.length > 0 ? "Function Signatures:\n" + funcSignatures.join("\n") : "",
                    typeDefinitions.length > 0 ? "Type Definitions:\n" + typeDefinitions.join("\n") : ""
                  ].filter(Boolean).join("\n\n");

                  // Create content sections
                  docContent = [
                    { content: description, type: "description" },
                    { content: documentation, type: "documentation" }
                  ];

                  // Add examples if available
                  if (examples) {
                    docContent.push({
                      content: examples,
                      type: "example"
                    });
                  } else {
                    // Add default example
                    docContent.push({
                      content: `// Import the package\nimport "${packageName}"\n\n// For more details, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`,
                      type: "example"
                    });
                  }
                  docFetched = true
                }
              } catch (webError) {
                this.logger.debug(`Error fetching from pkg.go.dev website: ${webError}`)
              }
            }

            // If all methods fail, create minimal content to avoid returning an error
            if (!docFetched) {
              docContent = [
                {
                  content: `Go package: ${packageName}\n\nThis package is available on pkg.go.dev but detailed documentation could not be retrieved.`,
                  type: "description"
                },
                {
                  content: `// Import the package\nimport "${packageName}"\n\n// For more details, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`,
                  type: "example"
                }
              ]
            }
          }
          break

        case "python":
          isInstalled = await this.isPythonPackageInstalledLocally(packageName)
          if (isInstalled) {
            const localDoc = await this.getLocalPythonDoc(packageName, undefined)
            if (!localDoc.error) {
              docContent = this.searchUtils.parsePythonDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              )
            }
          } else {
            // Try to fetch from PyPI
            const url = `https://pypi.org/pypi/${packageName}/json`
            const response = await axios.get(url)
            if (response.data && response.data.info) {
              packageInfo = response.data.info

              // Extract more comprehensive information
              const description = packageInfo.summary || ""
              const longDescription = packageInfo.description || ""

              // Try to parse the long description as markdown/rst
              docContent = [
                { content: description, type: "description" },
                { content: longDescription, type: "documentation" }
              ]

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
          break

        case "npm":
          isInstalled = this.isNpmPackageInstalledLocally(packageName, projectPath)
          if (isInstalled) {
            const localDoc = this.getLocalNpmDoc(packageName, projectPath)
            if (!localDoc.error) {
              docContent = [
                { content: localDoc.description || "", type: "description" },
                { content: localDoc.usage || "", type: "usage" },
                { content: localDoc.example || "", type: "example" }
              ].filter(item => item.content)
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
            const config = this.registryUtils.getRegistryConfigForPackage(packageName, projectPath)
            const headers: Record<string, string> = {}
            if (config.token) {
              headers.Authorization = `Bearer ${config.token}`
            }

            const url = `${config.registry}/${packageName}`
            const response = await axios.get(url, { headers })
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
              if ((packageInfo.types || packageInfo.typings) && Array.isArray(docContent)) {
                docContent.push({
                  content: `### TypeScript Support\n\nThis package includes TypeScript type definitions (${packageInfo.types || packageInfo.typings}).`,
                  type: "typescript"
                })
              }
            }
          }
          break

        case "swift":
          isInstalled = await this.isSwiftPackageInstalledLocally(packageName, projectPath)
          if (isInstalled) {
            const localDoc = await this.getLocalSwiftDoc(packageName, undefined, projectPath)
            if (!localDoc.error) {
              docContent = this.searchUtils.parseSwiftDoc(
                [localDoc.description, localDoc.usage, localDoc.example]
                  .filter(Boolean)
                  .join("\n\n")
              )
            }
          } else {
            // Try to fetch from GitHub if it's a GitHub URL
            if (packageName.includes('github.com')) {
              try {
                // Convert github.com URL to raw.githubusercontent.com URL for the README
                const githubParts = packageName.replace(/\.git$/, '').split('github.com/')
                if (githubParts.length === 2) {
                  const repoPath = githubParts[1]
                  const readmeUrl = `https://raw.githubusercontent.com/${repoPath}/main/README.md`

                  const response = await axios.get(readmeUrl)
                  if (response.data) {
                    // Parse the README content
                    const readme = response.data

                    // Extract sections
                    const sections = readme.split(/#+\s/)
                    let description = ""
                    let usage = ""
                    let example = ""

                    for (const section of sections) {
                      const lower = section.toLowerCase()
                      if (lower.startsWith("introduction") || lower.startsWith("about") || lower.startsWith("overview")) {
                        description = section
                      } else if (lower.startsWith("usage") || lower.startsWith("getting started")) {
                        usage = section
                      } else if (lower.startsWith("example")) {
                        example = section
                      }
                    }

                    docContent = [
                      { content: description || "Swift package", type: "description" },
                      { content: usage || "", type: "usage" },
                      { content: example || "", type: "example" }
                    ].filter(item => item.content)
                  }
                }
              } catch (githubError) {
                this.logger.error(`Error fetching GitHub README: ${githubError}`)
              }
            }
          }
          break
      }

      // If no content was found, return an error
      if (!docContent || (Array.isArray(docContent) && docContent.length === 0)) {
        return {
          error: `No documentation found for ${packageName}`,
          suggestInstall: !isInstalled
        }
      }

      // Perform search on the documentation content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchResults: any[] = []

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
          }

          const fuse = new Fuse(docContent, fuseOptions)
          const results = fuse.search(query)

          for (const result of results) {
            const section = result.item
            const symbol = this.searchUtils.extractSymbol(section.content, language)

            // Extract more context around the match
            const lines = section.content.split('\n')
            const firstLine = lines[0]

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
            })
          }
        } else {
          // Use exact search with improved context
          for (const section of docContent) {
            if (section.content.toLowerCase().includes(query.toLowerCase())) {
              const symbol = this.searchUtils.extractSymbol(section.content, language)
              const lines = section.content.split('\n')
              const firstLine = lines[0]

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
              })
            }
          }
        }
      } else {
        // For plain text content
        const lines = docContent.split('\n')

        // Find all matching lines
        const matchingLineIndices: number[] = []
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
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
          const context = lines.slice(contextStart, contextEnd).join('\n')

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
      searchResults.sort((a, b) => a.score - b.score)

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
          if (packageInfo.license) packageMetadata += `Licence: ${packageInfo.license}\n`
        } else if (language === "python") {
          if (packageInfo.version) packageMetadata += `Version: ${packageInfo.version}\n`
          if (packageInfo.summary) packageMetadata += `Description: ${packageInfo.summary}\n`
          if (packageInfo.home_page) packageMetadata += `Homepage: ${packageInfo.home_page}\n`
          if (packageInfo.license) packageMetadata += `Licence: ${packageInfo.license}\n`
        } else if (language === "swift") {
          const packageName = this.extractSwiftPackageNameFromUrl(packageUrl)
          if (!packageName) {
            return {
              error: "Could not extract package name from URL",
              suggestInstall: true
            }
          }
          if (packageUrl) packageMetadata += `Package: ${packageUrl}\n`
        }
      }

      return {
        description: packageMetadata || undefined,
        searchResults: {
          results: limitedResults,
          totalResults: searchResults.length,
          suggestInstall: !isInstalled && searchResults.length === 0
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Error searching ${language} package ${packageName}:`, error)
      return {
        error: `Failed to search documentation: ${errorMessage}`,
        searchResults: {
          results: [],
          totalResults: 0,
          error: errorMessage
        }
      }
    }
  }

  /**
   * Handle LSP hover requests
   */
  private async handleGetHover(args: { languageId: string; filePath: string; content: string; line: number; character: number; projectRoot: string }) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized")
    }

    try {
      const result = await this.lspClient.getHover(
        args.languageId,
        args.filePath,
        args.content,
        args.line,
        args.character,
        args.projectRoot
      )

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error("Error in handleGetHover:", error)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP hover error: ${errorMessage}` }),
          },
        ],
        isError: true,
      }
    }
  }

  /**
   * Handle LSP completions requests
   */
  private async handleGetCompletions(args: { languageId: string; filePath: string; content: string; line: number; character: number; projectRoot: string }) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized")
    }

    try {
      const result = await this.lspClient.getCompletions(
        args.languageId,
        args.filePath,
        args.content,
        args.line,
        args.character,
        args.projectRoot
      )

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error("Error in handleGetCompletions:", error)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP completions error: ${errorMessage}` }),
          },
        ],
        isError: true,
      }
    }
  }

  /**
   * Handle LSP diagnostics requests
   */
  private async handleGetDiagnostics(args: { languageId: string; filePath: string; content: string; projectRoot: string }) {
    if (!this.lspClient) {
      throw new McpError(ErrorCode.InternalError, "LSP client not initialized")
    }

    try {
      const result = await this.lspClient.getDiagnostics(
        args.languageId,
        args.filePath,
        args.content,
        args.projectRoot
      )

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error("Error in handleGetDiagnostics:", error)
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: `LSP diagnostics error: ${errorMessage}` }),
          },
        ],
        isError: true,
      }
    }
  }

  /**
   * Get documentation for a Go package
   * Optimized to return concise results to save LLM context
   */
  private async describeGoPackage(args: GoDocArgs): Promise<DocResult> {
    const { package: packageName, symbol, projectPath } = args
    this.logger.debug(`Getting Go documentation for ${packageName}${symbol ? `.${symbol}` : ""}`)

    try {
      // Check if package is installed locally first
      const isInstalled = await this.isGoPackageInstalledLocally(packageName, projectPath)

      if (isInstalled) {
        this.logger.debug(`Using local documentation for ${packageName}`)
        return await this.getLocalGoDoc(packageName, symbol)
      }

      // If not installed, try to fetch from pkg.go.dev
      this.logger.debug(`Fetching Go documentation for ${packageName} from pkg.go.dev`)

      try {
        // First try using go doc command (works for standard library and cached modules)
        const cmd = symbol
          ? `go doc ${packageName}.${symbol}`
          : `go doc ${packageName}`
        const { stdout } = await execAsync(cmd)

        // Parse the output into a structured format
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
      } catch {
        // If go doc command fails, try to fetch from pkg.go.dev API
        try {
          const url = `https://pkg.go.dev/api/packages/${encodeURIComponent(packageName)}`
          this.logger.debug(`Fetching from pkg.go.dev API: ${url}`)

          const response = await axios.get(url)

          if (response.data) {
            const pkgInfo = response.data

            // Create a structured result from the API response
            const result: DocResult = {
              description: pkgInfo.Synopsis || `Go package: ${packageName}`
            }

            // Add documentation if available
            if (pkgInfo.Documentation) {
              result.usage = pkgInfo.Documentation
            }

            // Add import example
            result.example = `// Import the package
import "${packageName}"

// See full documentation at: https://pkg.go.dev/${encodeURIComponent(packageName)}`

            return result
          }
        } catch (apiError) {
          this.logger.error(`Error fetching from pkg.go.dev API: ${apiError}`)
        }

        // If both methods fail, try to fetch from GitHub if it's a GitHub URL
        if (packageName.includes('github.com')) {
          try {
            // Extract GitHub owner and repo from the package name
            const githubMatch = packageName.match(/github\.com\/([^\/]+)\/([^\/]+)/)
            if (githubMatch) {
              const owner = githubMatch[1]
              const repo = githubMatch[2]

              // Try to fetch README.md from the main branch
              const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`
              this.logger.debug(`Attempting to fetch README from GitHub: ${readmeUrl}`)

              const readmeResponse = await axios.get(readmeUrl)
              if (readmeResponse.data) {
                const readme = readmeResponse.data

                // Parse the README content
                const sections = readme.split(/#+\s/)
                let description = ""
                let usage = ""
                let example = ""

                // Extract relevant sections
                for (const section of sections) {
                  const lower = section.toLowerCase()
                  if (lower.startsWith("introduction") || lower.startsWith("about") ||
                      lower.startsWith("overview") || lower.startsWith("description")) {
                    description = section
                  } else if (lower.startsWith("usage") || lower.startsWith("getting started") ||
                            lower.startsWith("quickstart") || lower.startsWith("installation")) {
                    usage = section
                  } else if (lower.startsWith("example")) {
                    example = section
                  }
                }

                // If we couldn't find a description section, use the first section
                if (!description && sections.length > 1) {
                  description = sections[1]
                }

                // Format the description
                const formattedDescription = description ?
                  description.split("\n").slice(0, 3).join("\n").trim() :
                  `Go package: ${packageName}`

                // Format the usage
                const formattedUsage = usage ?
                  usage :
                  `For detailed documentation, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`

                // Format the example
                const formattedExample = example ?
                  example :
                  `// Import the package\nimport "${packageName}"\n\n// For more details, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`

                return {
                  description: formattedDescription,
                  usage: formattedUsage,
                  example: formattedExample
                }
              }
            }
          } catch (githubError) {
            this.logger.error(`Error fetching from GitHub: ${githubError}`)
          }
        }

        // If GitHub fetch fails or it's not a GitHub URL, try web scraping approach
        try {
          const url = `https://pkg.go.dev/${encodeURIComponent(packageName)}`
          this.logger.debug(`Attempting to fetch documentation from: ${url}`)

          const response = await axios.get(url)

          if (response.data) {
            // Extract basic package information from HTML
            const html = response.data

            // Simple extraction of package description
            const descriptionMatch = html.match(/<meta name="description" content="([^"]+)"/)
            const description = descriptionMatch ? descriptionMatch[1] : `Go package: ${packageName}`

            // Try to extract documentation content
            const docMatch = html.match(/<div class="Documentation-content">[\s\S]*?<\/div>/)
            const documentation = docMatch ? docMatch[0] : ""

            // Try to extract package overview
            const overviewMatch = html.match(/<section id="pkg-overview"[\s\S]*?<\/section>/)
            const overview = overviewMatch ? overviewMatch[0] : ""

            // Extract function signatures
            const funcSignatures: string[] = []
            const funcSignatureMatches = html.matchAll(/<h3 id="([^"]*)">func\s+([^<]+)<\/h3>/g)
            for (const match of funcSignatureMatches) {
              funcSignatures.push(`func ${match[2]}`)
            }

            // Extract type definitions
            const typeDefinitions: string[] = []
            const typeDefMatches = html.matchAll(/<h3 id="([^"]*)">type\s+([^<]+)<\/h3>/g)
            for (const match of typeDefMatches) {
              typeDefinitions.push(`type ${match[2]}`)
            }

            // Extract code examples if available
            const examplesMatch = html.match(/<pre class="Documentation-exampleCode">[\s\S]*?<\/pre>/g)
            const examples = examplesMatch ? examplesMatch.join("\n\n") : ""

            // Clean up HTML tags from the extracted content
            const cleanHtml = (html: string): string => {
              return html
                .replace(/<[^>]*>/g, '') // Remove HTML tags
                .replace(/&lt;/g, '<')   // Replace HTML entities
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')    // Normalize whitespace
                .trim();
            };

            // Combine all the extracted content for usage
            const usage = [
              overview ? cleanHtml(overview) : "",
              documentation ? cleanHtml(documentation) : "",
              funcSignatures.length > 0 ? "## Function Signatures\n" + funcSignatures.join("\n") : "",
              typeDefinitions.length > 0 ? "## Type Definitions\n" + typeDefinitions.join("\n") : ""
            ].filter(Boolean).join("\n\n");

            // Create example content
            const example = examples || `// Import the package
import "${packageName}"

// For more details, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`

            return {
              description,
              usage: usage || `For detailed documentation, visit: https://pkg.go.dev/${encodeURIComponent(packageName)}`,
              example
            }
          }
        } catch (webError) {
          this.logger.error(`Error fetching from pkg.go.dev website: ${webError}`)
        }

        // If all methods fail, return a more helpful error
        return {
          description: `Go package: ${packageName}`,
          error: `Could not fetch detailed documentation for ${packageName}. You can view it online at https://pkg.go.dev/${encodeURIComponent(packageName)}`,
          suggestInstall: false
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Error getting Go documentation for ${packageName}:`, error)
      return {
        error: `Failed to fetch Go documentation: ${errorMessage}`
      }
    }
  }

  /**
   * Get documentation for a Python package
   * Optimized to return concise results to save LLM context
   */
  private async describePythonPackage(args: PythonDocArgs): Promise<DocResult> {
    const { package: packageName, symbol } = args
    this.logger.debug(`Getting Python documentation for ${packageName}${symbol ? `.${symbol}` : ""}`)

    try {
      // Check if package is installed locally first
      const isInstalled = await this.isPythonPackageInstalledLocally(packageName)

      if (isInstalled) {
        this.logger.debug(`Using local documentation for ${packageName}`)
        return await this.getLocalPythonDoc(packageName, symbol)
      }

      // If not installed, try to fetch from PyPI
      this.logger.debug(`Fetching Python documentation for ${packageName} from PyPI`)

      try {
        const url = `https://pypi.org/pypi/${packageName}/json`
        const response = await axios.get(url)

        if (response.data && response.data.info) {
          const result: DocResult = {
            description: response.data.info.summary || "No description available"
          }

          // Add more detailed description if available, but limit size
          if (response.data.info.description) {
            // Truncate description to a reasonable length
            const description = response.data.info.description
            result.usage = description.length > 1000
              ? description.substring(0, 1000) + "... (truncated)"
              : description
          }

          return result
        } else {
          return {
            error: `No documentation found for ${packageName} on PyPI`,
            suggestInstall: true
          }
        }
      } catch {
        // If PyPI request fails, suggest installation
        return {
          error: `Package ${packageName} not found. Try installing it with 'pip install ${packageName}'`,
          suggestInstall: true
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Error getting Python documentation for ${packageName}:`, error)
      return {
        error: `Failed to fetch Python documentation: ${errorMessage}`
      }
    }
  }

  /**
   * Get documentation for a Rust package
   */
  private async describeRustPackage(args: { package: string, version?: string }): Promise<DocResult> {
    const { package: crateName, version } = args
    this.logger.debug(`Getting Rust documentation for ${crateName}${version ? ` version ${version}` : ""}`)

    try {
      // Check if crate is installed locally first
      const isInstalled = await this.isRustCrateInstalledLocally(crateName)

      if (isInstalled) {
        this.logger.debug(`Using local documentation for ${crateName}`)
        return await this.getLocalRustDoc(crateName)
      }

      // If not installed, try to fetch from docs.rs
      this.logger.debug(`Fetching Rust documentation for ${crateName} from docs.rs`)

      try {
        // Get crate details from crates.io
        const crateDetails = await this.rustDocsHandler.getCrateDetails(crateName)

        // Get documentation from docs.rs
        const documentation = await this.rustDocsHandler.getCrateDocumentation(crateName, version)

        // Extract a brief description from the documentation
        const briefDescription = documentation.split('\n\n')[0] || crateDetails.description || `Rust crate: ${crateName}`

        return {
          description: briefDescription,
          usage: `## ${crateName} ${crateDetails.versions[0]?.version || ''}

${crateDetails.description || ''}

### Installation

Add this to your Cargo.toml:

\`\`\`toml
[dependencies]
${crateName} = "${version || crateDetails.versions[0]?.version || '*'}"
\`\`\`

### Links

${crateDetails.documentation ? `- [Documentation](${crateDetails.documentation})` : ''}
${crateDetails.repository ? `- [Repository](${crateDetails.repository})` : ''}
${crateDetails.homepage ? `- [Homepage](${crateDetails.homepage})` : ''}
`,
          example: documentation.includes('# Examples')
            ? documentation.split('# Examples')[1]?.split('#')[0]?.trim()
            : undefined
        }
      } catch {
        // If fetching fails, suggest installation
        return {
          error: `Crate ${crateName} not found. Try adding it to your Cargo.toml.`,
          suggestInstall: true
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger.error(`Error getting Rust documentation for ${crateName}:`, error)
      return {
        error: `Failed to fetch Rust documentation: ${errorMessage}`
      }
    }
  }

  /**
   * Get documentation for a Swift package
   */
  private async describeSwiftPackage(args: SwiftDocArgs): Promise<DocResult> {
    const { package: packageUrl, symbol, projectPath } = args
    this.logger.debug(`Getting Swift documentation for ${packageUrl}${symbol ? `.${symbol}` : ""}`)

    try {
      // Check if package is installed locally first
      const isInstalled = await this.isSwiftPackageInstalledLocally(packageUrl, projectPath)

      if (isInstalled) {
        this.logger.debug(`Using local documentation for ${packageUrl}`)
        return await this.getLocalSwiftDoc(packageUrl, symbol, projectPath)
      }

      // If not installed, try to fetch from GitHub or other sources
      this.logger.debug(`Fetching Swift documentation for ${packageUrl} from remote sources`)

      try {
        // Extract package name from URL
        const packageName = this.extractSwiftPackageNameFromUrl(packageUrl)
        if (!packageName) {
          return {
            error: "Could not extract package name from URL",
            suggestInstall: true
          }
        }

        // Try to fetch README from GitHub if it's a GitHub URL
        if (packageUrl.includes('github.com')) {
          try {
            // Convert github.com URL to raw.githubusercontent.com URL for the README
            const githubParts = packageUrl.replace(/\.git$/, '').split('github.com/')
            if (githubParts.length === 2) {
              const repoPath = githubParts[1]
              const readmeUrl = `https://raw.githubusercontent.com/${repoPath}/main/README.md`

              const response = await axios.get(readmeUrl)
              if (response.data) {
                // Parse the README content
                const readme = response.data

                // Extract relevant sections
                const sections = readme.split(/#+\s/)
                let description = ""
                let usage = ""
                let example = ""

                for (const section of sections) {
                  const lower = section.toLowerCase()
                  if (lower.startsWith("introduction") || lower.startsWith("about") || lower.startsWith("overview")) {
                    description = section.split("\n").slice(1).join("\n").trim()
                  } else if (lower.startsWith("usage") || lower.startsWith("getting started")) {
                    usage = section.split("\n").slice(1).join("\n").trim()
                  } else if (lower.startsWith("example")) {
                    example = section.split("\n").slice(1).join("\n").trim()
                  }
                }

                return {
                  description: description || `Swift package: ${packageName}`,
                  usage: usage || undefined,
                  example: example || undefined
                }
              }
            }
          } catch (githubError) {
            this.logger.error(`Error fetching GitHub README: ${githubError}`)
          }
        }

        // If we couldn't get documentation from GitHub, return a basic result
        return {
          description: `Swift package: ${packageName}`,
          usage: `To use this package, add it to your Package.swift:\n\n` +
            `\`\`\`swift\n` +
            `dependencies: [\n` +
            `    .package(url: "${packageUrl}", from: "1.0.0"),\n` +
            `],\n` +
            `\`\`\`\n\n` +
            `Then import it in your Swift files:\n\n` +
            `\`\`\`swift\n` +
            `import ${packageName}\n` +
            `\`\`\``,
          suggestInstall: true
        }
      } catch {
        // If fetching fails, suggest installation
        return {
          error: `Package ${packageUrl} not found. Try adding it to your Package.swift.`,
          suggestInstall: true
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.logger
        .error(`Error getting Swift documentation for ${packageUrl}:`, error)
      return {
        error: `Failed to fetch Swift documentation: ${errorMessage}`
      }
    }
  }


  /**
   * Get full documentation for an NPM package
   * Enhanced to provide comprehensive information for LLMs
   */
  private async getNpmPackageDoc(args: NpmDocArgs): Promise<DocResult> {
    // Set default values for includeTypes and includeExamples
    const enhancedArgs: NpmDocArgs = {
      ...args,
      includeTypes: args.includeTypes !== undefined ? args.includeTypes : true,
      includeExamples: args.includeExamples !== undefined ? args.includeExamples : true
    }

    // Use the NpmDocsHandler to get the documentation
    const result = await this.npmDocsHandler.getNpmPackageDoc(
      enhancedArgs,
      this.registryUtils.getRegistryConfigForPackage.bind(this.registryUtils),
      this.isNpmPackageInstalledLocally.bind(this),
      this.getLocalNpmDoc.bind(this)
    )

    // If there's API documentation, ensure it's only included as formatted markdown
    // and remove the structured object to avoid cluttering the JSON response
    if (result.apiDocumentation) {
      // The API documentation should already be formatted in the usage field,
      // so we can safely remove the structured object
      delete result.apiDocumentation
    }

    return result
  }
}
