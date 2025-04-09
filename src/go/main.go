package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/sammcj/mcp-package-docs/src/go/handlers"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// Version is set during build
var Version = "dev"

// Cache provides simple in-memory caching for tool results
type Cache struct {
	mu    sync.RWMutex
	items map[string]interface{}
}

// NewCache creates a new cache instance
func NewCache() *Cache {
	return &Cache{
		items: make(map[string]interface{}),
	}
}

// Get retrieves an item from the cache
func (c *Cache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	item, found := c.items[key]
	return item, found
}

// Set adds an item to the cache
func (c *Cache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = value
}

func main() {
	// Set up logging to stderr
	logger := log.New(os.Stderr, "[mcp-package-docs] ", log.LstdFlags)

	// Create a new cache
	cache := NewCache()

	// Create a new MCP server
	srv := server.NewMCPServer(
		"mcp-package-docs",
		Version,
		server.WithLogging(),
	)

	// Set up tool handlers
	setupToolHandlers(srv, logger, cache)

	// Start the server using stdio transport
	logger.Println("Starting MCP Package Docs server")
	if err := server.ServeStdio(srv); err != nil {
		logger.Fatalf("Server error: %v", err)
	}
}

// DocResult represents the structured result of a documentation query
type DocResult struct {
	Description string `json:"description,omitempty"`
	Usage       string `json:"usage,omitempty"`
	Example     string `json:"example,omitempty"`
	Error       string `json:"error,omitempty"`
}

// setupToolHandlers registers all tool handlers with the server
func setupToolHandlers(srv *server.MCPServer, logger *log.Logger, cache *Cache) {
	// Create utility instances
	cmdRunner := utils.NewCommandRunner()
	httpClient := utils.NewHTTPClient()
	fsUtils, err := utils.NewFileSystemUtils()
	if err != nil {
		logger.Fatalf("Failed to create file system utils: %v", err)
	}
	npmrcParser := utils.NewNPMRCParser(fsUtils)

	// Initialize handlers
	npmHandler := handlers.NewNPMHandler(cmdRunner, httpClient, fsUtils, npmrcParser)
	goHandler := handlers.NewGoHandler(cmdRunner, httpClient, fsUtils)
	// Define search_package_docs tool
	searchPackageDocsTool := mcp.NewTool("search_package_docs",
		mcp.WithDescription("Search within package documentation"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name to search within"),
		),
		mcp.WithString("query",
			mcp.Required(),
			mcp.Description("Search query"),
		),
		mcp.WithString("language",
			mcp.Required(),
			mcp.Description("Package language/ecosystem"),
			mcp.Enum("go", "python", "npm", "swift", "rust"),
		),
		mcp.WithBoolean("fuzzy",
			mcp.Description("Enable fuzzy matching"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	)

	// Define describe_go_package tool
	describeGoPackageTool := mcp.NewTool("describe_go_package",
		mcp.WithDescription("Get a brief description of a Go package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Full package import path (e.g. encoding/json)"),
		),
		mcp.WithString("symbol",
			mcp.Description("Optional symbol name to look up specific documentation"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	)

	// Define describe_python_package tool
	describePythonPackageTool := mcp.NewTool("describe_python_package",
		mcp.WithDescription("Get a brief description of a Python package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name (e.g. requests)"),
		),
		mcp.WithString("symbol",
			mcp.Description("Optional symbol name to look up specific documentation"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	)

	// Define describe_rust_package tool
	describeRustPackageTool := mcp.NewTool("describe_rust_package",
		mcp.WithDescription("Get a brief description of a Rust package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Crate name (e.g. serde)"),
		),
		mcp.WithString("version",
			mcp.Description("Optional crate version"),
		),
	)

	// Define describe_npm_package tool
	describeNpmPackageTool := mcp.NewTool("describe_npm_package",
		mcp.WithDescription("Get a brief description of an NPM package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name (e.g. axios)"),
		),
		mcp.WithString("version",
			mcp.Description("Optional package version"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	)

	// Define describe_swift_package tool
	describeSwiftPackageTool := mcp.NewTool("describe_swift_package",
		mcp.WithDescription("Get a brief description of a Swift package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package URL (e.g. https://github.com/apple/swift-argument-parser)"),
		),
		mcp.WithString("symbol",
			mcp.Description("Optional symbol name to look up specific documentation"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for Package.swift file"),
		),
	)

	// Define get_npm_package_doc tool
	getNpmPackageDocTool := mcp.NewTool("get_npm_package_doc",
		mcp.WithDescription("Get full documentation for an NPM package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name (e.g. axios)"),
		),
		mcp.WithString("version",
			mcp.Description("Optional package version"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
		mcp.WithString("section",
			mcp.Description("Optional section to retrieve (e.g. 'installation', 'api', 'examples')"),
		),
		mcp.WithNumber("maxLength",
			mcp.Description("Optional maximum length of the returned documentation"),
		),
		mcp.WithString("query",
			mcp.Description("Optional search query to filter documentation content"),
		),
	)

	// Register tool handlers
	srv.AddTool(searchPackageDocsTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// TODO: Implement search_package_docs handler
		return mcp.NewToolResultText("Search package docs functionality not yet implemented"), nil
	})

	srv.AddTool(describeGoPackageTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Extract parameters
		packageName, ok := request.Params.Arguments["package"].(string)
		if !ok || packageName == "" {
			return nil, fmt.Errorf("package parameter is required")
		}

		// Extract optional parameters
		var symbol, projectPath string
		if symbolVal, ok := request.Params.Arguments["symbol"].(string); ok {
			symbol = symbolVal
		}
		if projectPathVal, ok := request.Params.Arguments["projectPath"].(string); ok {
			projectPath = projectPathVal
		}

		// Get package documentation
		result, err := goHandler.DescribePackage(ctx, packageName, symbol, projectPath)
		if err != nil {
			return mcp.NewToolResultText(fmt.Sprintf("Error: %v", err)), nil
		}

		return mcp.NewToolResultText(result), nil
	})

	srv.AddTool(describePythonPackageTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// TODO: Implement describe_python_package handler
		return mcp.NewToolResultText("Python package documentation functionality not yet implemented"), nil
	})

	srv.AddTool(describeRustPackageTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// TODO: Implement describe_rust_package handler
		return mcp.NewToolResultText("Rust package documentation functionality not yet implemented"), nil
	})

	srv.AddTool(describeNpmPackageTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Extract parameters
		packageName, ok := request.Params.Arguments["package"].(string)
		if !ok || packageName == "" {
			return nil, fmt.Errorf("package parameter is required")
		}

		// Extract optional parameters
		var version, projectPath string
		if versionVal, ok := request.Params.Arguments["version"].(string); ok {
			version = versionVal
		}
		if projectPathVal, ok := request.Params.Arguments["projectPath"].(string); ok {
			projectPath = projectPathVal
		}

		// Get package documentation
		result, err := npmHandler.DescribePackage(ctx, packageName, version, projectPath)
		if err != nil {
			return mcp.NewToolResultText(fmt.Sprintf("Error: %v", err)), nil
		}

		return mcp.NewToolResultText(result), nil
	})

	srv.AddTool(describeSwiftPackageTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// TODO: Implement describe_swift_package handler
		return mcp.NewToolResultText("Swift package documentation functionality not yet implemented"), nil
	})

	srv.AddTool(getNpmPackageDocTool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Extract parameters
		packageName, ok := request.Params.Arguments["package"].(string)
		if !ok || packageName == "" {
			return nil, fmt.Errorf("package parameter is required")
		}

		// Extract optional parameters
		var version, projectPath, section, query string
		var maxLength int

		if versionVal, ok := request.Params.Arguments["version"].(string); ok {
			version = versionVal
		}
		if projectPathVal, ok := request.Params.Arguments["projectPath"].(string); ok {
			projectPath = projectPathVal
		}
		if sectionVal, ok := request.Params.Arguments["section"].(string); ok {
			section = sectionVal
		}
		if queryVal, ok := request.Params.Arguments["query"].(string); ok {
			query = queryVal
		}
		if maxLengthVal, ok := request.Params.Arguments["maxLength"].(float64); ok {
			maxLength = int(maxLengthVal)
		}

		// Get package documentation
		result, err := npmHandler.GetPackageDocumentation(ctx, packageName, version, projectPath, section, maxLength, query)
		if err != nil {
			return mcp.NewToolResultText(fmt.Sprintf("Error: %v", err)), nil
		}

		return mcp.NewToolResultText(result), nil
	})

	// Add legacy tool aliases
	srv.AddTool(mcp.NewTool("lookup_go_doc",
		mcp.WithDescription("[DEPRECATED] Use describe_go_package instead. Get a brief description of a Go package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Full package import path (e.g. encoding/json)"),
		),
		mcp.WithString("symbol",
			mcp.Description("Optional symbol name to look up specific documentation"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Redirect to describe_go_package handler
		return mcp.NewToolResultText("This tool is deprecated. Please use describe_go_package instead."), nil
	})

	srv.AddTool(mcp.NewTool("lookup_python_doc",
		mcp.WithDescription("[DEPRECATED] Use describe_python_package instead. Get a brief description of a Python package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name (e.g. requests)"),
		),
		mcp.WithString("symbol",
			mcp.Description("Optional symbol name to look up specific documentation"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Redirect to describe_python_package handler
		return mcp.NewToolResultText("This tool is deprecated. Please use describe_python_package instead."), nil
	})

	srv.AddTool(mcp.NewTool("lookup_npm_doc",
		mcp.WithDescription("[DEPRECATED] Use describe_npm_package instead. Get a brief description of an NPM package"),
		mcp.WithString("package",
			mcp.Required(),
			mcp.Description("Package name (e.g. axios)"),
		),
		mcp.WithString("version",
			mcp.Description("Optional package version"),
		),
		mcp.WithString("projectPath",
			mcp.Description("Optional path to project directory for local .npmrc files"),
		),
	), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// Redirect to describe_npm_package handler
		return mcp.NewToolResultText("This tool is deprecated. Please use describe_npm_package instead."), nil
	})
}
