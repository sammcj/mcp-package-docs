package main

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/sammcj/mcp-package-docs/src/go/handlers"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// Version is the current version of the package documentation server.
// This is set during build time.
var Version = "dev"

// Cache represents a thread-safe in-memory cache for storing tool results.
// It provides basic key-value storage with mutex-protected access for concurrent operations.
// It supports TTL and maximum item limits.
type Cache struct {
	mu           sync.RWMutex
	items        map[string]*cacheItem
	maxItems     int
	ttl          time.Duration
	currentItems int
}

// cacheItem represents a single cached item with expiration time
type cacheItem struct {
	value      interface{}
	expiration time.Time
}

// NewCache creates a new Cache instance with the specified configuration.
// Parameters:
//   - maxItems: maximum number of items allowed in the cache (0 for unlimited)
//   - ttl: time-to-live duration for cached items (0 for no expiration)
//
// Returns a pointer to the newly created Cache.
func NewCache(maxItems int, ttl time.Duration) *Cache {
	c := &Cache{
		items:    make(map[string]*cacheItem),
		maxItems: maxItems,
		ttl:      ttl,
	}

	// Start cleanup goroutine if TTL is set
	if ttl > 0 {
		go c.cleanup()
	}

	return c
}

// Get retrieves an item from the cache using the provided key.
// Returns the cached value and a boolean indicating whether the key was found and valid.
// This method is thread-safe for concurrent access.
func (c *Cache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	item, found := c.items[key]
	if !found {
		return nil, false
	}

	// Check if item has expired
	if !item.expiration.IsZero() && time.Now().After(item.expiration) {
		return nil, false
	}

	return item.value, true
}

// Set adds or updates an item in the cache with the specified key and value.
// If the cache is at capacity, removes the oldest item before adding the new one.
// This method is thread-safe for concurrent access.
func (c *Cache) Set(key string, value interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Check if we need to make room
	if c.maxItems > 0 && len(c.items) >= c.maxItems && c.items[key] == nil {
		// Remove oldest item (simple implementation - could be improved)
		var oldestKey string
		var oldestTime time.Time
		first := true

		for k, v := range c.items {
			if first || v.expiration.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.expiration
				first = false
			}
		}

		delete(c.items, oldestKey)
	}

	// Calculate expiration time if TTL is set
	var expiration time.Time
	if c.ttl > 0 {
		expiration = time.Now().Add(c.ttl)
	}

	// Store the item
	c.items[key] = &cacheItem{
		value:      value,
		expiration: expiration,
	}
}

// cleanup periodically removes expired items from the cache
func (c *Cache) cleanup() {
	ticker := time.NewTicker(c.ttl / 2)
	defer ticker.Stop()

	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for key, item := range c.items {
			if !item.expiration.IsZero() && now.After(item.expiration) {
				delete(c.items, key)
			}
		}
		c.mu.Unlock()
	}
}

func main() {
	// Create a new cache with default settings
	cache := NewCache(1000, time.Hour) // 1000 items, 1 hour TTL

	// Create a new MCP server with default options
	srv := server.NewMCPServer(
		"mcp-package-docs",
		Version,
	)

	// Create a null logger for MCP-compliant logging (discards everything)
	nullLogger := log.New(devNull{}, "", 0)

	// Set up tool handlers
	if err := setupToolHandlers(srv, nullLogger, cache); err != nil {
		// Return silently - errors are handled through MCP protocol
		return
	}

	// Start the server using stdio transport
	if err := server.ServeStdio(srv); err != nil {
		// Return silently - errors are handled through MCP protocol
		return
	}
}

// devNull implements io.Writer by discarding everything
type devNull struct{}

func (devNull) Write(p []byte) (int, error) {
	return len(p), nil
}

// DocResult represents the structured result of a documentation query.
type DocResult struct {
	Description string `json:"description,omitempty"`
	Usage       string `json:"usage,omitempty"`
	Example     string `json:"example,omitempty"`
	Error       string `json:"error,omitempty"`
}

func setupToolHandlers(srv *server.MCPServer, logger *log.Logger, cache *Cache) error {
	cmdRunner := utils.NewCommandRunner()
	httpClient := utils.NewHTTPClient()
	fsUtils, err := utils.NewFileSystemUtils()
	if err != nil {
		return fmt.Errorf("failed to create file system utils: %w", err)
	}
	npmrcParser := utils.NewNPMRCParser(fsUtils)

	// Initialize handlers
	npmHandler := handlers.NewNPMHandler(cmdRunner, httpClient, fsUtils, npmrcParser)
	goHandler := handlers.NewGoHandler(cmdRunner, httpClient, fsUtils)
	pythonHandler := handlers.NewPythonHandler(cmdRunner, httpClient, fsUtils)
	rustHandler := handlers.NewRustHandler(cmdRunner, httpClient, fsUtils)
	swiftHandler := handlers.NewSwiftHandler(cmdRunner, httpClient, fsUtils)

	// Register tools
	srv.AddTool(mcp.NewTool("search_package_docs",
		mcp.WithDescription("Search within package documentation"),
		mcp.WithString("package", mcp.Required(), mcp.Description("Package name to search within")),
		mcp.WithString("query", mcp.Required(), mcp.Description("Search query")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Package language/ecosystem"), mcp.Enum("go", "python", "npm", "swift", "rust")),
		mcp.WithBoolean("fuzzy", mcp.Description("Enable fuzzy matching")),
		mcp.WithString("projectPath", mcp.Description("Optional path to project directory")),
	), handleSearch(cache, npmHandler, goHandler, pythonHandler, rustHandler, swiftHandler))

	srv.AddTool(mcp.NewTool("describe_package",
		mcp.WithDescription("Get a brief description of a package"),
		mcp.WithString("package", mcp.Required(), mcp.Description("Package name or URL")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Package language/ecosystem"), mcp.Enum("go", "python", "npm", "swift", "rust")),
		mcp.WithString("version", mcp.Description("Optional package version")),
		mcp.WithString("symbol", mcp.Description("Optional symbol name to look up specific documentation")),
		mcp.WithString("projectPath", mcp.Description("Optional path to project directory")),
	), handleDescribe(cache, npmHandler, goHandler, pythonHandler, rustHandler, swiftHandler))

	srv.AddTool(mcp.NewTool("get_package_doc",
		mcp.WithDescription("Get full documentation for a package"),
		mcp.WithString("package", mcp.Required(), mcp.Description("Package name or URL")),
		mcp.WithString("language", mcp.Required(), mcp.Description("Package language/ecosystem"), mcp.Enum("go", "python", "npm", "swift", "rust")),
		mcp.WithString("section", mcp.Description("Optional section to retrieve")),
		mcp.WithNumber("maxLength", mcp.Description("Optional maximum length")),
		mcp.WithString("query", mcp.Description("Optional search query")),
	), handleDoc(cache, npmHandler))

	return nil
}

// Handler functions
func handleSearch(cache *Cache, npm *handlers.NPMHandler, go_ *handlers.GoHandler, python *handlers.PythonHandler, rust *handlers.RustHandler, swift *handlers.SwiftHandler) func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		packageName, _ := request.Params.Arguments["package"].(string)
		query, _ := request.Params.Arguments["query"].(string)
		language, _ := request.Params.Arguments["language"].(string)
		fuzzySearch, _ := request.Params.Arguments["fuzzy"].(bool)
		projectPath, _ := request.Params.Arguments["projectPath"].(string)

		// Check cache first
		cacheKey := fmt.Sprintf("search:%s:%s:%s:%v:%s", language, packageName, query, fuzzySearch, projectPath)
		if cachedResult, found := cache.Get(cacheKey); found {
			return mcp.NewToolResultText(cachedResult.(string)), nil
		}

		var result string
		var err error

		switch language {
		case "go":
			result, err = go_.SearchPackage(ctx, packageName, query, fuzzySearch)
		case "python":
			result, err = python.SearchPackage(ctx, packageName, query, fuzzySearch)
		case "npm":
			result, err = npm.SearchPackage(ctx, packageName, query, fuzzySearch, projectPath)
		case "rust":
			result, err = rust.SearchPackage(ctx, packageName, query, fuzzySearch)
		case "swift":
			result, err = swift.SearchPackage(ctx, packageName, query, fuzzySearch)
		default:
			return nil, fmt.Errorf("unsupported language: %s", language)
		}

		if err != nil {
			return nil, fmt.Errorf("search failed: %w", err)
		}

		cache.Set(cacheKey, result)
		return mcp.NewToolResultText(result), nil
	}
}

func handleDescribe(cache *Cache, npm *handlers.NPMHandler, go_ *handlers.GoHandler, python *handlers.PythonHandler, rust *handlers.RustHandler, swift *handlers.SwiftHandler) func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		packageName, _ := request.Params.Arguments["package"].(string)
		language, _ := request.Params.Arguments["language"].(string)
		version, _ := request.Params.Arguments["version"].(string)
		symbol, _ := request.Params.Arguments["symbol"].(string)
		projectPath, _ := request.Params.Arguments["projectPath"].(string)

		cacheKey := fmt.Sprintf("describe:%s:%s:%s:%s:%s", language, packageName, version, symbol, projectPath)
		if cachedResult, found := cache.Get(cacheKey); found {
			return mcp.NewToolResultText(cachedResult.(string)), nil
		}

		var result string
		var err error

		switch language {
		case "go":
			result, err = go_.DescribePackage(ctx, packageName, symbol, projectPath)
		case "python":
			result, err = python.DescribePackage(ctx, packageName, symbol, projectPath)
		case "npm":
			result, err = npm.DescribePackage(ctx, packageName, version, projectPath)
		case "rust":
			result, err = rust.DescribePackage(ctx, packageName, version)
		case "swift":
			result, err = swift.DescribePackage(ctx, packageName, symbol, projectPath)
		default:
			return nil, fmt.Errorf("unsupported language: %s", language)
		}

		if err != nil {
			return nil, fmt.Errorf("describe failed: %w", err)
		}

		cache.Set(cacheKey, result)
		return mcp.NewToolResultText(result), nil
	}
}

func handleDoc(cache *Cache, npm *handlers.NPMHandler) func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		packageName, _ := request.Params.Arguments["package"].(string)
		language, _ := request.Params.Arguments["language"].(string)
		section, _ := request.Params.Arguments["section"].(string)
		maxLengthFloat, _ := request.Params.Arguments["maxLength"].(float64)
		query, _ := request.Params.Arguments["query"].(string)

		maxLength := int(maxLengthFloat)

		if language != "npm" {
			return nil, fmt.Errorf("full documentation retrieval is only supported for NPM packages")
		}

		cacheKey := fmt.Sprintf("doc:%s:%s:%s:%d:%s", language, packageName, section, maxLength, query)
		if cachedResult, found := cache.Get(cacheKey); found {
			return mcp.NewToolResultText(cachedResult.(string)), nil
		}

		result, err := npm.GetPackageDocumentation(ctx, packageName, "", "", section, maxLength, query)
		if err != nil {
			return nil, fmt.Errorf("documentation retrieval failed: %w", err)
		}

		cache.Set(cacheKey, result)
		return mcp.NewToolResultText(result), nil
	}
}
