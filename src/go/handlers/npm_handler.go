package languages

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"../parsing"
	"../utils"
)

// NPMPackageInfo represents information about an NPM package
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

// NPMHandler provides functionality for handling NPM packages
type NPMHandler struct {
	cmdRunner   *utils.CommandRunner
	httpClient  *utils.HTTPClient
	fsUtils     *utils.FileSystemUtils
	npmrcParser *utils.NPMRCParser
	htmlParser  *parsing.HTMLParser
	mdParser    *parsing.MarkdownParser
}

// NewNPMHandler creates a new NPM handler
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

// GetPackageInfo retrieves information about an NPM package
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

// GetPackageReadme retrieves the README for an NPM package
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

// GetPackageDocumentation retrieves documentation for an NPM package
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

// GetPackageExamples retrieves examples for an NPM package
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

// GetPackageAPI retrieves API documentation for an NPM package
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

// SearchPackage searches for content within an NPM package
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

// DescribePackage provides a brief description of an NPM package
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
