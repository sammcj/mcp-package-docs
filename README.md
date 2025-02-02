# Package Documentation MCP Server
[![smithery badge](https://smithery.ai/badge/mcp-package-docs)](https://smithery.ai/server/mcp-package-docs)

An MCP (Model Context Protocol) server that provides LLMs with efficient access to package documentation across multiple programming languages.

<a href="https://glama.ai/mcp/servers/mrk7ul7nz7"><img width="380" height="200" src="https://glama.ai/mcp/servers/mrk7ul7nz7/badge" alt="Package Docs Server MCP server" /></a>

## Features

- **Multi-Language Support**:
  - Go packages via `go doc`
  - Python libraries via built-in `help()`
  - NPM packages via registry documentation

- **Smart Documentation Parsing**:
  - Structured output with description, usage, and examples
  - Focused information to avoid context overload
  - Support for specific symbol/function lookups

- **Performance Optimised**:
  - Built-in caching
  - Efficient parsing
  - Minimal memory footprint

## Installation

### Installing via Smithery

To install Package Docs for Claude Desktop automatically via [Smithery](https://smithery.ai/server/mcp-package-docs):

```bash
npx -y @smithery/cli install mcp-package-docs --client claude
```

### Manual Installation
```bash
npx -y mcp-package-docs
```

## Usage

### As an MCP Server

1. Add to your MCP settings configuration:

```json
{
  "mcpServers": {
    "package-docs": {
      "command": "npx",
      "args": ["-y", "mcp-package-docs"]
    }
  }
}
```

2. The server provides three tools:

#### lookup_go_doc

Fetches Go package documentation
```typescript
{
  "name": "lookup_go_doc",
  "arguments": {
    "package": "encoding/json", // required
    "symbol": "Marshal"        // optional
  }
}
```

#### lookup_python_doc

Fetches Python package documentation
```typescript
{
  "name": "lookup_python_doc",
  "arguments": {
    "package": "requests",    // required
    "symbol": "get"          // optional
  }
}
```

#### lookup_npm_doc

Fetches NPM package documentation
```typescript
{
  "name": "lookup_npm_doc",
  "arguments": {
    "package": "axios",      // required
    "version": "1.6.0"       // optional
  }
}
```

### Example Usage in an LLM

```typescript
const result = await use_mcp_tool({
  server_name: "package-docs",
  tool_name: "lookup_python_doc",
  arguments: {
    package: "requests",
    symbol: "post"
  }
});
```

## Requirements

- Node.js >= 20
- Go (for Go package documentation)
- Python 3 (for Python package documentation)
- Internet connection (for NPM package documentation)

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
