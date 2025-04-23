package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/sammcj/mcp-package-docs/src/go/parsing"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// NPMPackageInfo represents comprehensive information about an NPM package retrieved from a registry.
// It includes metadata such as package details, dependencies, and type definitions.
type NPMPackageInfo struct {
	Name            string   `json:"name"`
	Version         string   `json:"version"`
	Description     string   `json:"description"`
	Homepage        string   `json:"homepage"`
	Repository      string   `json:"repository"`
	License         string   `json:"license"`
	Keywords        []string `json:"keywords"`
	Author          string   `json:"author"`
	Contributors    []string `json:"contributors"`
	Main            string   `json:"main"`
	Types           string   `json:"types"`
	Typings         string   `json:"typings"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
}

// NPMHandler provides functionality for handling NPM package documentation and metadata.
// It encapsulates the logic for interacting with NPM registries, parsing package documentation,
// and handling private registry authentication through .npmrc configuration.
type NPMHandler struct {
	cmdRunner   *utils.CommandRunner
	httpClient  *utils.HTTPClient
	fsUtils     *utils.FileSystemUtils
	npmrcParser *utils.NPMRCParser
	htmlParser  *parsing.HTMLParser
	mdParser    *parsing.MarkdownParser
}

// NewNPMHandler creates a new NPM handler with the necessary dependencies for package operations.
// It requires:
//   - cmdRunner: for executing NPM CLI commands
//   - httpClient: for making HTTP requests to NPM registries
//   - fsUtils: for file system operations
//   - npmrcParser: for parsing .npmrc configuration files
// Returns an initialized NPMHandler instance.
func NewNPMHandler(
	cmdRunner *utils.CommandRunner,
	httpClient *utils.HTTPClient,
	fsUtils *utils.FileSystemUtils,
	npmrcParser *utils.NPMRCParser,
) *NPMHandler {
	return &NPMHandler{
		cmdRunner:   cmdRunner,
		httpClient:  httpClient,
		fsUtils:     fsUtils,
		npmrcParser: npmrcParser,
		htmlParser:  parsing.NewHTMLParser(),
		mdParser:    parsing.NewMarkdownParser(),
	}
}

// GetPackageInfo retrieves comprehensive information about an NPM package from its registry.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package to retrieve information for
//   - version: specific version to retrieve (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
// Returns package information or an error if retrieval fails.
func (h *NPMHandler) GetPackageInfo(ctx context.Context, packageName, version, projectPath string) (*NPMPackageInfo, error) {
	// Get registry configuration
	registryConfig, err := h.npmrcParser.GetRegistryConfigForPackage(packageName, projectPath)
	if err != nil {
		return nil, fmt.Errorf("failed to get registry configuration: %w", err)
	}

	// Construct the URL for the package info
	url := fmt.Sprintf("%s/%s", registryConfig.Registry, packageName)
	if !strings.HasSuffix(url, "/") {
		url = url + "/"
	}

	// Add headers
	headers := make(map[string]string)
	if registryConfig.Token != "" {
		headers["Authorization"] = "Bearer " + registryConfig.Token
	}

	// Fetch package info from registry
	data, err := h.httpClient.Get(ctx, url, headers)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch package info: %w", err)
	}

	// Parse the JSON response
	var packageInfo struct {
		Versions map[string]NPMPackageInfo `json:"versions"`
		Time     map[string]string         `json:"time"`
	}

	if err := json.Unmarshal(data, &packageInfo); err != nil {
		return nil, fmt.Errorf("failed to parse package info: %w", err)
	}

	// If version is not specified, use the latest version
	if version == "" {
		// Find the latest version
		var latestVersion string
		var latestTime string

		for ver, timeStr := range packageInfo.Time {
			if ver != "created" && ver != "modified" {
				if latestTime == "" || timeStr > latestTime {
					latestTime = timeStr
					latestVersion = ver
				}
			}
		}

		version = latestVersion
	}

	// Get the package info for the specified version
	info, ok := packageInfo.Versions[version]
	if !ok {
		return nil, fmt.Errorf("version %s not found", version)
	}

	return &info, nil
}

// GetPackageReadme retrieves the README content for an NPM package from its registry.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package to retrieve README for
//   - version: specific version to retrieve (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
// Returns the README content as a string or an error if retrieval fails.
func (h *NPMHandler) GetPackageReadme(ctx context.Context, packageName, version, projectPath string) (string, error) {
	// Get registry configuration
	registryConfig, err := h.npmrcParser.GetRegistryConfigForPackage(packageName, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get registry configuration: %w", err)
	}

	// Construct the URL for the package info
	url := fmt.Sprintf("%s/%s", registryConfig.Registry, packageName)
	if !strings.HasSuffix(url, "/") {
		url = url + "/"
	}

	// Add headers
	headers := make(map[string]string)
	if registryConfig.Token != "" {
		headers["Authorization"] = "Bearer " + registryConfig.Token
	}

	// Fetch package info from registry
	data, err := h.httpClient.Get(ctx, url, headers)
	if err != nil {
		return "", fmt.Errorf("failed to fetch package info: %w", err)
	}

	// Parse the JSON response
	var packageInfo struct {
		Readme string `json:"readme"`
	}

	if err := json.Unmarshal(data, &packageInfo); err != nil {
		return "", fmt.Errorf("failed to parse package info: %w", err)
	}

	return packageInfo.Readme, nil
}

// GetPackageDocumentation retrieves and processes documentation for an NPM package.
// It can filter by section, limit content length, and search within the documentation.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package
//   - version: specific version (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
//   - section: optional specific section to retrieve
//   - maxLength: maximum length of returned content (0 for no limit)
//   - query: optional search query to filter content
// Returns formatted documentation content or an error if retrieval fails.
func (h *NPMHandler) GetPackageDocumentation(ctx context.Context, packageName, version, projectPath, section string, maxLength int, query string) (string, error) {
	// Get the README
	readme, err := h.GetPackageReadme(ctx, packageName, version, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get README: %w", err)
	}

	// Parse the README into sections
	sections := h.mdParser.ExtractSections(readme)

	// Filter relevant sections
	relevantSections := h.mdParser.FilterRelevantSections(sections)

	// If a specific section is requested, find it
	if section != "" {
		for _, s := range relevantSections {
			if strings.Contains(strings.ToLower(s.Title), strings.ToLower(section)) {
				return s.Content, nil
			}
		}
	}

	// If a query is provided, search for it
	if query != "" {
		// Create a map of section content
		sectionMap := make(map[string]string)
		for i, s := range relevantSections {
			sectionMap[fmt.Sprintf("Section %d: %s", i, s.Title)] = s.Content
		}

		// Search for the query
		results := parsing.Search(query, sectionMap, parsing.SearchOptions{
			Query:       query,
			FuzzySearch: true,
			MaxResults:  5,
		})

		if len(results) > 0 {
			var resultContent strings.Builder
			for _, result := range results {
				resultContent.WriteString(fmt.Sprintf("## %s\n\n", result.Source))
				resultContent.WriteString(parsing.ExtractContextAroundMatch(result.Content, query, 200))
				resultContent.WriteString("\n\n")
			}
			return resultContent.String(), nil
		}
	}

	// If no specific section or query, return a summary
	var fullContent strings.Builder
	for _, s := range relevantSections {
		fullContent.WriteString(fmt.Sprintf("## %s\n\n", s.Title))
		fullContent.WriteString(s.Content)
		fullContent.WriteString("\n\n")
	}

	content := fullContent.String()

	// Truncate if necessary
	if maxLength > 0 && len(content) > maxLength {
		content = content[:maxLength] + "...\n\n(Content truncated due to length)"
	}

	return content, nil
}

// GetPackageExamples retrieves code examples from an NPM package's documentation.
// It attempts to find examples in several locations:
//   1. Dedicated examples section in README
//   2. Code blocks throughout the documentation
//   3. Examples directory in the package repository
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package
//   - version: specific version (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
// Returns formatted examples or an error if retrieval fails.
func (h *NPMHandler) GetPackageExamples(ctx context.Context, packageName, version, projectPath string) (string, error) {
	// Get the README
	readme, err := h.GetPackageReadme(ctx, packageName, version, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get README: %w", err)
	}

	// Parse the README into sections
	sections := h.mdParser.ExtractSections(readme)

	// Extract examples section
	examplesSection := h.mdParser.ExtractExamplesSection(sections)
	if examplesSection != "" {
		return examplesSection, nil
	}

	// If no examples section found, extract code blocks
	codeBlocks := h.mdParser.ExtractCodeBlocks(readme)
	if len(codeBlocks) > 0 {
		var examples strings.Builder
		examples.WriteString("## Code Examples\n\n")
		for i, block := range codeBlocks {
			examples.WriteString(fmt.Sprintf("### Example %d\n\n```\n%s\n```\n\n", i+1, block))
		}
		return examples.String(), nil
	}

	// Try to find examples in the repository
	// This would require cloning the repository, which is out of scope for now
	return "No examples found in the package documentation.", nil
}

// GetPackageAPI retrieves API documentation for an NPM package.
// It attempts to extract API information from:
//   1. Dedicated API section in README
//   2. Function signatures in code blocks
//   3. TypeScript type definitions if available
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package
//   - version: specific version (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
// Returns formatted API documentation or an error if retrieval fails.
func (h *NPMHandler) GetPackageAPI(ctx context.Context, packageName, version, projectPath string) (string, error) {
	// Get the README
	readme, err := h.GetPackageReadme(ctx, packageName, version, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get README: %w", err)
	}

	// Parse the README into sections
	sections := h.mdParser.ExtractSections(readme)

	// Extract API section
	apiSection := h.mdParser.ExtractAPISection(sections)
	if apiSection != "" {
		return apiSection, nil
	}

	// If no API section found, extract function signatures from code blocks
	codeBlocks := h.mdParser.ExtractCodeBlocks(readme)
	signatures := h.mdParser.ExtractFunctionSignatures(codeBlocks)

	if len(signatures) > 0 {
		var api strings.Builder
		api.WriteString("## API Reference\n\n")
		api.WriteString("The following function signatures were extracted from the documentation:\n\n")
		for _, sig := range signatures {
			api.WriteString(fmt.Sprintf("```\n%s\n```\n\n", sig))
		}
		return api.String(), nil
	}

	return "No API documentation found in the package documentation.", nil
}

// SearchPackage performs a search within an NPM package's documentation.
// It searches through README content, code examples, and API documentation.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package to search within
//   - query: search query string
//   - fuzzySearch: whether to use fuzzy matching
//   - projectPath: optional path to project for .npmrc configuration
// Returns search results formatted as markdown or an error if search fails.
func (h *NPMHandler) SearchPackage(ctx context.Context, packageName, query string, fuzzySearch bool, projectPath string) (string, error) {
	// Get the README
	readme, err := h.GetPackageReadme(ctx, packageName, "", projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get README: %w", err)
	}

	// Parse the README into sections
	sections := h.mdParser.ExtractSections(readme)

	// Search in sections
	sectionResults := parsing.SearchMarkdownSections(query, sections, fuzzySearch)

	// Extract code blocks and search in them
	codeBlocks := h.mdParser.ExtractCodeBlocks(readme)
	codeResults := parsing.SearchCodeBlocks(query, codeBlocks, fuzzySearch)

	// Extract function signatures and search in them
	signatures := h.mdParser.ExtractFunctionSignatures(codeBlocks)
	signatureResults := parsing.SearchFunctionSignatures(query, signatures, fuzzySearch)

	// Combine results
	var results []parsing.SearchResult
	results = append(results, sectionResults...)
	results = append(results, codeResults...)
	results = append(results, signatureResults...)

	// Sort results by score (higher is better)
	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	// Format results
	var formattedResults strings.Builder
	formattedResults.WriteString(fmt.Sprintf("# Search Results for '%s' in %s\n\n", query, packageName))

	if len(results) == 0 {
		formattedResults.WriteString("No results found.")
		return formattedResults.String(), nil
	}

	for i, result := range results {
		formattedResults.WriteString(fmt.Sprintf("## Result %d: %s\n\n", i+1, result.Source))

		// Extract context around the match
		context := parsing.ExtractContextAroundMatch(result.Content, query, 200)
		formattedResults.WriteString(context)
		formattedResults.WriteString("\n\n")
	}

	return formattedResults.String(), nil
}

// DescribePackage provides a brief, structured description of an NPM package.
// The description includes:
//   - Basic package information (name, version, description)
//   - Documentation summary
//   - Homepage and repository links
//   - License information
//   - Keywords and dependencies
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the package to describe
//   - version: specific version (empty string for latest)
//   - projectPath: optional path to project for .npmrc configuration
// Returns formatted package description or an error if retrieval fails.
func (h *NPMHandler) DescribePackage(ctx context.Context, packageName, version, projectPath string) (string, error) {
	// Get package info
	info, err := h.GetPackageInfo(ctx, packageName, version, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get package info: %w", err)
	}

	// Get the README
	readme, err := h.GetPackageReadme(ctx, packageName, version, projectPath)
	if err != nil {
		return "", fmt.Errorf("failed to get README: %w", err)
	}

	// Generate a summary
	summary := h.mdParser.SummarizeMarkdown(readme, 500)

	// Format the description
	var description strings.Builder
	description.WriteString(fmt.Sprintf("# %s@%s\n\n", info.Name, info.Version))

	if info.Description != "" {
		description.WriteString(fmt.Sprintf("%s\n\n", info.Description))
	}

	if summary != "" {
		description.WriteString(fmt.Sprintf("## Summary\n\n%s\n\n", summary))
	}

	if info.Homepage != "" {
		description.WriteString(fmt.Sprintf("**Homepage:** %s\n\n", info.Homepage))
	}

	if info.License != "" {
		description.WriteString(fmt.Sprintf("**License:** %s\n\n", info.License))
	}

	if len(info.Keywords) > 0 {
		description.WriteString(fmt.Sprintf("**Keywords:** %s\n\n", strings.Join(info.Keywords, ", ")))
	}

	if len(info.Dependencies) > 0 {
		description.WriteString("**Dependencies:**\n\n")
		for dep, ver := range info.Dependencies {
			description.WriteString(fmt.Sprintf("- %s: %s\n", dep, ver))
		}
		description.WriteString("\n")
	}

	return description.String(), nil
}
