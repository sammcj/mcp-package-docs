# Package Documentation MCP Server

An MCP (Model Context Protocol) server that provides LLMs with efficient access to package documentation across multiple programming languages and language server protocol (LSP) capabilities.

[![smithery badge](https://smithery.ai/badge/mcp-package-docs)](https://smithery.ai/server/mcp-package-docs)

<a href="https://glama.ai/mcp/servers/mrk7ul7nz7"><img width="380" height="200" src="https://glama.ai/mcp/servers/mrk7ul7nz7/badge" alt="Package Docs Server MCP server" /></a>

## Features

- **Multi-Language Support**:
  - Go packages via `go doc`
  - Python libraries via built-in `help()`
  - NPM packages via registry documentation (including private registries)
  - Rust crates via crates.io and docs.rs

- **Smart Documentation Parsing**:
  - Structured output with description, usage, and examples
  - Focused information to avoid context overload
  - Support for specific symbol/function lookups
  - Fuzzy and exact search capabilities across documentation

- **Advanced Search Features**:
  - Search within package documentation
  - Fuzzy matching for flexible queries
  - Context-aware results with relevance scoring
  - Symbol extraction from search results

- **Language Server Protocol (LSP) Support**:
  - Hover information for code symbols
  - Code completions
  - Diagnostics (errors and warnings)
  - Currently supports TypeScript/JavaScript
  - Extensible for other languages

- **Performance Optimised**:
  - Built-in caching
  - Efficient parsing
  - Minimal memory footprint

## Installation

```bash
npx -y mcp-package-docs
```

### Installing via Smithery

To install Package Docs for Claude Desktop automatically via [Smithery](https://smithery.ai/server/mcp-package-docs):

```bash
npx -y @smithery/cli install mcp-package-docs --client claude
```

## Usage

### As an MCP Server

1. Add to your MCP settings configuration:

```json
{
  "mcpServers": {
    "package-docs": {
      "command": "npx",
      "args": ["-y", "mcp-package-docs"],
      "env": {
        "ENABLE_LSP": "true" // Optional: Enable Language Server Protocol support
      }
    }
  }
}
```

2. The LSP functionality includes default configurations for common language servers:

- TypeScript/JavaScript: `typescript-language-server --stdio`
- HTML: `vscode-html-language-server --stdio`
- CSS: `vscode-css-language-server --stdio`
- JSON: `vscode-json-language-server --stdio`

You can override these defaults if needed:

```json
{
  "mcpServers": {
    "package-docs": {
      "command": "npx",
      "args": ["-y", "mcp-package-docs"],
      "env": {
        "ENABLE_LSP": "true",
        "TYPESCRIPT_SERVER": "{\"command\":\"/custom/path/typescript-language-server\",\"args\":[\"--stdio\"]}"
      }
    }
  }
}
```

3. The server provides the following tools:

#### lookup_go_doc / describe_go_package

Fetches Go package documentation
```typescript
{
  "name": "describe_go_package",
  "arguments": {
    "package": "encoding/json", // required
    "symbol": "Marshal"        // optional
  }
}
```

#### lookup_python_doc / describe_python_package

Fetches Python package documentation
```typescript
{
  "name": "describe_python_package",
  "arguments": {
    "package": "requests",    // required
    "symbol": "get"          // optional
  }
}
```

#### describe_rust_package

Fetches Rust crate documentation from crates.io and docs.rs
```typescript
{
  "name": "describe_rust_package",
  "arguments": {
    "package": "serde",      // required: crate name
    "version": "1.0.219"     // optional: specific version
  }
}
```

#### search_package_docs

Search within package documentation
```typescript
{
  "name": "search_package_docs",
  "arguments": {
    "package": "requests",    // required: package name
    "query": "authentication", // required: search query
    "language": "python",     // required: "go", "python", "npm", "swift", or "rust"
    "fuzzy": true            // optional: enable fuzzy matching (default: true)
  }
}
```

#### lookup_npm_doc / describe_npm_package

Fetches NPM package documentation from both public and private registries. Automatically uses the appropriate registry based on your .npmrc configuration.

```typescript
{
  "name": "describe_npm_package",
  "arguments": {
    "package": "axios",      // required - supports both scoped (@org/pkg) and unscoped packages
    "version": "1.6.0"       // optional
  }
}
```

The tool reads your ~/.npmrc file to determine the correct registry for each package:

- Uses scoped registry configurations (e.g., @mycompany:registry=...)
- Supports private registries (GitHub Packages, GitLab, Nexus, Artifactory, etc.)
- Falls back to the default npm registry if no custom registry is configured

Example .npmrc configurations:

```npmrc
registry=https://nexus.mycompany.com/repository/npm-group/
@mycompany:registry=https://nexus.mycompany.com/repository/npm-private/
@mycompany-ct:registry=https://npm.pkg.github.com/
```

### Language Server Protocol (LSP) Tools

When LSP support is enabled, the following additional tools become available:

#### get_hover

Get hover information for a position in a document
```typescript
{
  "name": "get_hover",
  "arguments": {
    "languageId": "typescript", // required: language identifier (e.g., "typescript", "javascript")
    "filePath": "src/index.ts", // required: path to the source file
    "content": "const x = 1;",  // required: content of the file
    "line": 0,                  // required: zero-based line number
    "character": 6,             // required: zero-based character position
    "projectRoot": "/path/to/project" // optional: project root directory
  }
}
```

#### get_completions

Get completion suggestions for a position in a document
```typescript
{
  "name": "get_completions",
  "arguments": {
    "languageId": "typescript", // required: language identifier
    "filePath": "src/index.ts", // required: path to the source file
    "content": "const arr = []; arr.",  // required: content of the file
    "line": 0,                  // required: zero-based line number
    "character": 16,            // required: zero-based character position
    "projectRoot": "/path/to/project" // optional: project root directory
  }
}
```

#### get_diagnostics

Get diagnostic information (errors, warnings) for a document
```typescript
{
  "name": "get_diagnostics",
  "arguments": {
    "languageId": "typescript", // required: language identifier
    "filePath": "src/index.ts", // required: path to the source file
    "content": "const x: string = 1;",  // required: content of the file
    "projectRoot": "/path/to/project" // optional: project root directory
  }
}
```

### Example Usage in an LLM

#### Looking up Documentation

```typescript
// Looking up Go documentation
const goDocResult = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "describe_go_package",
  arguments: {
    package: "encoding/json",
    symbol: "Marshal"
  }
});

// Looking up Python documentation
const pythonDocResult = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "describe_python_package",
  arguments: {
    package: "requests",
    symbol: "post"
  }
});

// Looking up Rust documentation
const rustDocResult = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "describe_rust_package",
  arguments: {
    package: "serde"
  }
});

// Searching within documentation
const searchResult = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "search_package_docs",
  arguments: {
    package: "serde",
    query: "serialize",
    language: "rust",
    fuzzy: true
  }
});

// Using LSP for hover information (when LSP is enabled)
const hoverResult = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "get_hover",
  arguments: {
    languageId: "typescript",
    filePath: "src/index.ts",
    content: "const axios = require('axios');\naxios.get",
    line: 1,
    character: 7
  }
});
```

## Requirements

- Node.js >= 20
- Go (for Go package documentation)
- Python 3 (for Python package documentation)
- Internet connection (for NPM package documentation and Rust crate documentation)
- Language servers (for LSP functionality):
  - TypeScript/JavaScript: `npm install -g typescript-language-server typescript`
  - HTML/CSS/JSON: `npm install -g vscode-langservers-extracted`

## Development

```bash
# Install dependencies
npm i

# Build
npm run build

# Watch mode
npm run watch
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
