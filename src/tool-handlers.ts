import TypeScriptLspClient from './lsp/typescript-lsp-client.js'

/**
 * Get tool definitions for the package docs server
 */
export function getToolDefinitions(lspEnabled: boolean, lspClient: TypeScriptLspClient | undefined) {
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
            enum: ["go", "python", "npm", "swift", "rust"],
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
      name: "describe_rust_package",
      description: "Get a brief description of a Rust package",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Crate name (e.g. serde)",
          },
          version: {
            type: "string",
            description:
              "Optional crate version",
          },
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
      name: "describe_swift_package",
      description: "Get a brief description of a Swift package",
      inputSchema: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package URL (e.g. https://github.com/apple/swift-argument-parser)",
          },
          symbol: {
            type: "string",
            description: "Optional symbol name to look up specific documentation",
          },
          projectPath: {
            type: "string",
            description: "Optional path to project directory for Package.swift file"
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
  ]

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
  ]

  // Combine main tools with legacy tools
  const allTools = [...baseTools, ...legacyTools]

  // Add LSP tools if enabled
  if (lspEnabled && lspClient) {
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
    ]

    return { tools: [...allTools, ...lspTools] }
  }

  return { tools: allTools }
}
