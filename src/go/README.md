# MCP Package Documentation Server

An MCP (Model Context Protocol) server that provides comprehensive documentation tools for multiple programming languages, including Go, Python, NPM, Rust, and Swift. This server helps AI language models access and search through package documentation efficiently.

## Features

- **Multi-language Support**: Works with multiple package ecosystems:
  - Go (via `go doc` and pkg.go.dev)
  - Python
  - NPM
  - Rust
  - Swift

TODO:

- Add Java (Maven, Gradle)

- **Smart Caching**: Implements an intelligent caching system with TTL and size limits to optimise performance

- **Documentation Tools**:
  1. **search_package_docs**: Search within package documentation with support for fuzzy matching
  2. **describe_package**: Get brief descriptions of packages and specific symbols
  3. **get_package_doc**: Retrieve full package documentation (currently NPM only)

## Installation

1. Clone the repository:

```bash
git clone https://github.com/sammcj/mcp-package-docs.git
cd mcp-package-docs/src/go
```

2. Build the binary:

```bash
make build
```

3. Install globally (optional):

```bash
make install
```

## Usage

The server provides the following MCP tools:

### search_package_docs

Search within package documentation:

```json
{
  "package": "express",
  "query": "middleware",
  "language": "npm",
  "fuzzy": true,
  "projectPath": "/optional/path/to/project"
}
```

Supported languages: `go`, `python`, `npm`, `swift`, `rust`

### describe_package

Get a brief description of a package:

```json
{
  "package": "gorilla/mux",
  "language": "go",
  "version": "v1.8.0",
  "symbol": "Router",
  "projectPath": "/optional/path/to/project"
}
```

### get_package_doc

Get full documentation for a package (NPM only):

```json
{
  "package": "react",
  "language": "npm",
  "section": "hooks",
  "maxLength": 5000,
  "query": "useState"
}
```

## Development

### Prerequisites

- Go 1.x or higher
- Make

### Building

```bash
make build
```

### Testing

Run the test suite:

```bash
make test
```

### Linting

Run the linter:

```bash
make lint
```

## Project Structure

```
.
├── handlers/         # Language-specific documentation handlers
├── parsing/         # Documentation parsing utilities
└── utils/           # Common utilities (HTTP, filesystem, etc.)
```

## Caching

The server implements an in-memory cache with the following features:

- TTL-based expiration
- Maximum item limit
- Thread-safe operations
- Automatic cleanup of expired items

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run the test suite
5. Submit a pull request

## License

This project is licensed under the MIT License - see the LICENSE file for details.
