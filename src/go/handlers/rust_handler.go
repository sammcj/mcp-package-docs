package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/sammcj/mcp-package-docs/src/go/parsing"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// RustHandler provides functionality for handling Rust package documentation.
// It supports multiple documentation sources:
//   - Local cargo and rustdoc commands
//   - crates.io API for package metadata
//   - docs.rs for detailed documentation and README content
//
// The handler implements fallback mechanisms between these sources.
type RustHandler struct {
	cmdRunner  *utils.CommandRunner
	httpClient *utils.HTTPClient
	fsUtils    *utils.FileSystemUtils
	mdParser   *parsing.MarkdownParser
}

// NewRustHandler creates a new Rust handler with the necessary dependencies.
// Parameters:
//   - cmdRunner: for executing cargo and rustdoc commands
//   - httpClient: for fetching documentation from crates.io and docs.rs
//   - fsUtils: for filesystem operations
//
// Returns an initialized RustHandler instance.
func NewRustHandler(
	cmdRunner *utils.CommandRunner,
	httpClient *utils.HTTPClient,
	fsUtils *utils.FileSystemUtils,
) *RustHandler {
	return &RustHandler{
		cmdRunner:  cmdRunner,
		httpClient: httpClient,
		fsUtils:    fsUtils,
		mdParser:   parsing.NewMarkdownParser(),
	}
}

// DescribePackage provides a comprehensive description of a Rust package.
// It attempts to retrieve documentation in the following order:
//  1. Local cargo/rustdoc documentation
//  2. crates.io API for metadata
//  3. docs.rs for detailed documentation
//
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package to describe
//   - version: optional specific version to retrieve
//
// Returns formatted documentation or an error if all retrieval methods fail.
func (h *RustHandler) DescribePackage(ctx context.Context, packageName, version string) (string, error) {
	// First try to get documentation using cargo
	cargoInfo, err := h.getCargoInfo(ctx, packageName)
	if err == nil && cargoInfo != "" {
		// Get local documentation if available
		rustdocResult, err := h.getRustDocumentation(ctx, packageName)
		if err == nil && rustdocResult != "" {
			return h.formatRustDocumentation(packageName, version, cargoInfo, rustdocResult), nil
		}
	}

	// If cargo/rustdoc fails or returns empty, try to fetch from crates.io
	cratesResult, err := h.fetchCratesIO(ctx, packageName, version)
	if err == nil && cratesResult != "" {
		return cratesResult, nil
	}

	// If both methods fail, try to fetch from docs.rs
	docsRsResult, err := h.fetchDocsRs(ctx, packageName, version)
	if err == nil && docsRsResult != "" {
		return docsRsResult, nil
	}

	// If all methods fail, return an error
	return "", fmt.Errorf("failed to get documentation for package %s: %w", packageName, err)
}

// getCargoInfo uses the cargo command to get package metadata from local installation.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package
//
// Returns package metadata or an error if the cargo command fails.
func (h *RustHandler) getCargoInfo(ctx context.Context, packageName string) (string, error) {
	result := h.cmdRunner.Run(ctx, "cargo", "search", packageName, "--limit", "1")
	if result.Error != nil {
		return "", fmt.Errorf("cargo search command failed: %w", result.Error)
	}

	return result.Stdout, nil
}

// getRustDocumentation uses rustdoc to get package documentation from local installation.
// This method:
//  1. Gets documentation path from rustup
//  2. Checks if package documentation exists
//  3. Reads and converts HTML documentation to markdown
//
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package
//
// Returns formatted documentation or an error if retrieval fails.
func (h *RustHandler) getRustDocumentation(ctx context.Context, packageName string) (string, error) {
	// Try to get documentation from locally installed packages
	result := h.cmdRunner.Run(ctx, "rustup", "doc", "--path")
	if result.Error != nil {
		return "", fmt.Errorf("rustup doc command failed: %w", result.Error)
	}

	docPath := strings.TrimSpace(result.Stdout)
	if docPath == "" {
		return "", fmt.Errorf("rustup doc path is empty")
	}

	// Check if the package documentation exists
	packageDocPath := fmt.Sprintf("%s/%s/index.html", docPath, packageName)
	if !h.fsUtils.FileExists(packageDocPath) {
		return "", fmt.Errorf("package documentation not found at %s", packageDocPath)
	}

	// Read the documentation HTML
	docContent, err := h.fsUtils.ReadFileContent(packageDocPath)
	if err != nil {
		return "", fmt.Errorf("failed to read documentation: %w", err)
	}

	// Convert HTML to markdown
	htmlParser := parsing.NewHTMLParser()
	markdown, err := htmlParser.HTMLToMarkdown(docContent)
	if err != nil {
		return "", fmt.Errorf("failed to convert HTML to markdown: %w", err)
	}

	return markdown, nil
}

// fetchCratesIO attempts to fetch documentation from the crates.io API.
// This provides comprehensive package metadata including:
//   - Version information
//   - Package description and metadata
//   - Repository and documentation links
//   - README content (via docs.rs integration)
//
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package
//   - version: optional specific version
//
// Returns formatted package information or an error if retrieval fails.
func (h *RustHandler) fetchCratesIO(ctx context.Context, packageName, version string) (string, error) {
	// Construct the URL for the crates.io API
	url := fmt.Sprintf("https://crates.io/api/v1/crates/%s", packageName)
	if version != "" {
		url = fmt.Sprintf("%s/%s", url, version)
	}

	data, err := h.httpClient.Get(ctx, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch from crates.io: %w", err)
	}

	// Parse the JSON response
	var cratesInfo struct {
		Crate struct {
			ID            string   `json:"id"`
			Name          string   `json:"name"`
			Description   string   `json:"description"`
			MaxVersion    string   `json:"max_version"`
			Homepage      string   `json:"homepage"`
			Documentation string   `json:"documentation"`
			Repository    string   `json:"repository"`
			Categories    []string `json:"categories"`
			Keywords      []string `json:"keywords"`
			License       string   `json:"license"`
		} `json:"crate"`
		Versions []struct {
			ID      string `json:"id"`
			Version string `json:"num"`
			Yanked  bool   `json:"yanked"`
		} `json:"versions"`
	}

	if err := json.Unmarshal(data, &cratesInfo); err != nil {
		return "", fmt.Errorf("failed to parse crates.io info: %w", err)
	}

	// Format the crates.io information
	var result strings.Builder
	result.WriteString(fmt.Sprintf("# %s %s\n\n", cratesInfo.Crate.Name, cratesInfo.Crate.MaxVersion))

	if cratesInfo.Crate.Description != "" {
		result.WriteString(fmt.Sprintf("%s\n\n", cratesInfo.Crate.Description))
	}

	// Add metadata
	result.WriteString("## Package Information\n\n")

	if cratesInfo.Crate.License != "" {
		result.WriteString(fmt.Sprintf("**License:** %s\n\n", cratesInfo.Crate.License))
	}

	if len(cratesInfo.Crate.Keywords) > 0 {
		result.WriteString(fmt.Sprintf("**Keywords:** %s\n\n", strings.Join(cratesInfo.Crate.Keywords, ", ")))
	}

	if len(cratesInfo.Crate.Categories) > 0 {
		result.WriteString(fmt.Sprintf("**Categories:** %s\n\n", strings.Join(cratesInfo.Crate.Categories, ", ")))
	}

	// Add links
	result.WriteString("## Links\n\n")

	if cratesInfo.Crate.Homepage != "" {
		result.WriteString(fmt.Sprintf("**Homepage:** %s\n\n", cratesInfo.Crate.Homepage))
	}

	if cratesInfo.Crate.Documentation != "" {
		result.WriteString(fmt.Sprintf("**Documentation:** %s\n\n", cratesInfo.Crate.Documentation))
	}

	if cratesInfo.Crate.Repository != "" {
		result.WriteString(fmt.Sprintf("**Repository:** %s\n\n", cratesInfo.Crate.Repository))
	}

	result.WriteString(fmt.Sprintf("**Crates.io:** https://crates.io/crates/%s\n\n", cratesInfo.Crate.Name))

	// Add versions
	if len(cratesInfo.Versions) > 0 {
		result.WriteString("## Recent Versions\n\n")
		maxVersions := 5
		if len(cratesInfo.Versions) < maxVersions {
			maxVersions = len(cratesInfo.Versions)
		}
		for i := 0; i < maxVersions; i++ {
			version := cratesInfo.Versions[i]
			yanked := ""
			if version.Yanked {
				yanked = " (yanked)"
			}
			result.WriteString(fmt.Sprintf("- %s%s\n", version.Version, yanked))
		}
		result.WriteString("\n")
	}

	// Try to fetch README from docs.rs
	readme, err := h.fetchDocsRsReadme(ctx, packageName, version)
	if err == nil && readme != "" {
		// Extract relevant sections
		sections := h.mdParser.ExtractSections(readme)
		relevantSections := h.mdParser.FilterRelevantSections(sections)

		if len(relevantSections) > 0 {
			result.WriteString("## Documentation\n\n")
			for _, section := range relevantSections {
				result.WriteString(fmt.Sprintf("### %s\n\n%s\n\n", section.Title, section.Content))
			}
		} else {
			// If no relevant sections found, include a summary
			summary := h.mdParser.SummarizeMarkdown(readme, 500)
			if summary != "" {
				result.WriteString("## Summary\n\n")
				result.WriteString(summary)
				result.WriteString("\n\n")
			}
		}
	}

	return result.String(), nil
}

// fetchDocsRs attempts to fetch documentation from docs.rs website.
// This provides detailed API documentation and examples.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package
//   - version: optional specific version
//
// Returns formatted documentation or an error if retrieval fails.
func (h *RustHandler) fetchDocsRs(ctx context.Context, packageName, version string) (string, error) {
	// Construct the URL for docs.rs
	url := fmt.Sprintf("https://docs.rs/%s", packageName)
	if version != "" {
		url = fmt.Sprintf("%s/%s", url, version)
	}

	data, err := h.httpClient.Get(ctx, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch from docs.rs: %w", err)
	}

	// Convert HTML to markdown
	htmlParser := parsing.NewHTMLParser()
	markdown, err := htmlParser.HTMLToMarkdown(string(data))
	if err != nil {
		return "", fmt.Errorf("failed to convert HTML to markdown: %w", err)
	}

	// Extract relevant sections
	sections := h.mdParser.ExtractSections(markdown)
	relevantSections := h.mdParser.FilterRelevantSections(sections)

	var result strings.Builder
	result.WriteString(fmt.Sprintf("# %s", packageName))
	if version != "" {
		result.WriteString(fmt.Sprintf(" %s", version))
	}
	result.WriteString("\n\n")

	// Extract package overview
	overview := h.extractPackageOverview(markdown)
	if overview != "" {
		result.WriteString(fmt.Sprintf("## Overview\n\n%s\n\n", overview))
	}

	// Add relevant sections
	for _, section := range relevantSections {
		result.WriteString(fmt.Sprintf("## %s\n\n%s\n\n", section.Title, section.Content))
	}

	// Add link to docs.rs
	result.WriteString(fmt.Sprintf("**Documentation:** %s\n\n", url))

	return result.String(), nil
}

// fetchDocsRsReadme attempts to fetch the README from docs.rs.
// This provides the package's README.md content, which often contains
// detailed usage examples and getting started guides.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package
//   - version: optional specific version
//
// Returns README content or an error if retrieval fails.
func (h *RustHandler) fetchDocsRsReadme(ctx context.Context, packageName, version string) (string, error) {
	// Construct the URL for docs.rs README
	url := fmt.Sprintf("https://docs.rs/crate/%s", packageName)
	if version != "" {
		url = fmt.Sprintf("%s/%s", url, version)
	}
	url = fmt.Sprintf("%s/source/README.md", url)

	data, err := h.httpClient.Get(ctx, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch README from docs.rs: %w", err)
	}

	return string(data), nil
}

// extractPackageOverview extracts the package overview from docs.rs markdown content.
// It attempts to find the overview section using multiple patterns:
//  1. Dedicated "Overview" section
//  2. First non-heading paragraph after the title
//
// Parameters:
//   - markdown: the markdown content to extract overview from
//
// Returns the extracted overview text or empty string if no overview is found.
func (h *RustHandler) extractPackageOverview(markdown string) string {
	// Look for the package overview section
	overviewPattern := regexp.MustCompile(`(?s)# Overview\s+(.+?)(?:\n\n|\n#)`)
	matches := overviewPattern.FindStringSubmatch(markdown)
	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}

	// Try alternative pattern
	altPattern := regexp.MustCompile(`(?s)^(?:# .+?\n\n)(.+?)(?:\n\n|\n#)`)
	matches = altPattern.FindStringSubmatch(markdown)
	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}

	return ""
}

// formatRustDocumentation formats the combined output from cargo and rustdoc.
// It processes and combines:
//   - Package metadata from cargo
//   - Documentation content from rustdoc
//   - Relevant sections extracted from the documentation
//
// Parameters:
//   - packageName: name of the Rust package
//   - version: optional specific version
//   - cargoInfo: metadata from cargo command
//   - docResult: documentation from rustdoc
//
// Returns formatted markdown documentation.
func (h *RustHandler) formatRustDocumentation(packageName, version, cargoInfo, docResult string) string {
	var result strings.Builder

	// Extract package metadata from cargo info
	var name, ver, description string
	lines := strings.Split(cargoInfo, "\n")
	for _, line := range lines {
		if strings.Contains(line, packageName) {
			parts := strings.SplitN(line, " = ", 2)
			if len(parts) == 2 {
				name = strings.TrimSpace(parts[0])
				descParts := strings.SplitN(parts[1], " (", 2)
				if len(descParts) == 2 {
					description = strings.TrimSpace(descParts[0])
					verParts := strings.SplitN(descParts[1], ")", 2)
					if len(verParts) > 0 {
						ver = strings.TrimSpace(verParts[0])
					}
				}
			}
			break
		}
	}

	// Use provided version if available
	if version != "" {
		ver = version
	}

	// Format the header
	result.WriteString(fmt.Sprintf("# %s", name))
	if ver != "" {
		result.WriteString(fmt.Sprintf(" %s", ver))
	}
	result.WriteString("\n\n")

	// Add description if available
	if description != "" {
		result.WriteString(fmt.Sprintf("%s\n\n", description))
	}

	// Process the documentation
	// Extract relevant sections from the markdown
	sections := h.mdParser.ExtractSections(docResult)
	relevantSections := h.mdParser.FilterRelevantSections(sections)

	for _, section := range relevantSections {
		result.WriteString(fmt.Sprintf("## %s\n\n%s\n\n", section.Title, section.Content))
	}

	// If no relevant sections were found, include the full documentation
	if len(relevantSections) == 0 {
		result.WriteString("## Documentation\n\n")
		result.WriteString(docResult)
		result.WriteString("\n\n")
	}

	return result.String()
}

// SearchPackage searches for content within a Rust package's documentation.
// It fetches documentation from docs.rs and performs a search within:
//   - Overview and general documentation
//   - API documentation sections
//   - Code examples
//
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Rust package to search within
//   - query: search query string
//   - fuzzySearch: whether to use fuzzy matching
//
// Returns formatted search results or an error if the search fails.
func (h *RustHandler) SearchPackage(ctx context.Context, packageName, query string, fuzzySearch bool) (string, error) {
	// Try to get documentation from docs.rs
	markdown, err := h.fetchDocsRs(ctx, packageName, "")
	if err != nil {
		return "", fmt.Errorf("failed to get package documentation: %w", err)
	}

	// Extract sections from the markdown
	sections := h.mdParser.ExtractSections(markdown)

	// Create a map of section content
	sectionMap := make(map[string]string)
	for i, section := range sections {
		sectionMap[fmt.Sprintf("Section %d: %s", i, section.Title)] = section.Content
	}

	// If no sections were found, use the whole document
	if len(sectionMap) == 0 {
		sectionMap["Package Documentation"] = markdown
	}

	// Search in sections
	results := parsing.Search(query, sectionMap, parsing.SearchOptions{
		Query:       query,
		FuzzySearch: fuzzySearch,
		MaxResults:  5,
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
		formattedResults.WriteString("```rust\n")
		formattedResults.WriteString(context)
		formattedResults.WriteString("\n```\n\n")
	}

	return formattedResults.String(), nil
}
