package handlers

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/sammcj/mcp-package-docs/src/go/parsing"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// GoHandler provides functionality for handling Go package documentation.
// It supports retrieving package documentation through both the 'go doc' command
// and pkg.go.dev website, with fallback mechanisms between the two sources.
type GoHandler struct {
	cmdRunner  *utils.CommandRunner
	httpClient *utils.HTTPClient
	fsUtils    *utils.FileSystemUtils
	mdParser   *parsing.MarkdownParser
}

// NewGoHandler creates a new Go handler with the necessary dependencies.
// Parameters:
//   - cmdRunner: for executing go doc commands
//   - httpClient: for fetching documentation from pkg.go.dev
//   - fsUtils: for filesystem operations
//
// Returns an initialized GoHandler instance.
func NewGoHandler(
	cmdRunner *utils.CommandRunner,
	httpClient *utils.HTTPClient,
	fsUtils *utils.FileSystemUtils,
) *GoHandler {
	return &GoHandler{
		cmdRunner:  cmdRunner,
		httpClient: httpClient,
		fsUtils:    fsUtils,
		mdParser:   parsing.NewMarkdownParser(),
	}
}

// DescribePackage provides a comprehensive description of a Go package.
// It attempts to retrieve documentation first using the local 'go doc' command,
// falling back to pkg.go.dev if the local documentation is unavailable.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Go package to describe
//   - symbol: optional specific symbol (type, function, etc.) to describe
//   - projectPath: optional path to the project directory
//
// Returns formatted documentation or an error if retrieval fails.
func (h *GoHandler) DescribePackage(ctx context.Context, packageName, symbol, projectPath string) (string, error) {
	// First try to get documentation using go doc command
	docResult, err := h.getGoDocumentation(ctx, packageName, symbol)
	if err == nil && docResult != "" {
		return h.formatGoDocumentation(packageName, symbol, docResult), nil
	}

	// If go doc fails or returns empty, try to fetch from pkg.go.dev
	pkgDocResult, err := h.fetchPkgGoDev(ctx, packageName)
	if err == nil && pkgDocResult != "" {
		return pkgDocResult, nil
	}

	// If both methods fail, return an error
	return "", fmt.Errorf("failed to get documentation for package %s: %w", packageName, err)
}

// getGoDocumentation uses the go doc command to get package documentation.
// It executes 'go doc' with appropriate arguments based on whether a specific
// symbol is requested or just the package overview is needed.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Go package
//   - symbol: optional symbol name to look up specific documentation
//
// Returns the raw documentation output or an error if the command fails.
func (h *GoHandler) getGoDocumentation(ctx context.Context, packageName, symbol string) (string, error) {
	args := []string{"doc"}

	if symbol != "" {
		args = append(args, packageName+"."+symbol)
	} else {
		args = append(args, packageName)
	}

	result := h.cmdRunner.Run(ctx, "go", args...)
	if result.Error != nil {
		return "", fmt.Errorf("go doc command failed: %w", result.Error)
	}

	return result.Stdout, nil
}

// fetchPkgGoDev attempts to fetch documentation from pkg.go.dev website.
// This serves as a fallback when local documentation is unavailable.
// It processes the HTML content to extract relevant documentation sections.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Go package
//
// Returns formatted markdown documentation or an error if retrieval fails.
func (h *GoHandler) fetchPkgGoDev(ctx context.Context, packageName string) (string, error) {
	url := fmt.Sprintf("https://pkg.go.dev/%s", packageName)

	data, err := h.httpClient.Get(ctx, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch from pkg.go.dev: %w", err)
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
	result.WriteString(fmt.Sprintf("# %s\n\n", packageName))

	// Extract package overview
	overview := h.extractPackageOverview(markdown)
	if overview != "" {
		result.WriteString(fmt.Sprintf("## Overview\n\n%s\n\n", overview))
	}

	// Add relevant sections
	for _, section := range relevantSections {
		result.WriteString(fmt.Sprintf("## %s\n\n%s\n\n", section.Title, section.Content))
	}

	return result.String(), nil
}

// extractPackageOverview extracts the package overview from pkg.go.dev HTML content.
// It uses regex patterns to identify and extract the primary package description.
// Parameters:
//   - markdown: the converted markdown content from pkg.go.dev HTML
//
// Returns the extracted overview text, or empty string if no overview is found.
func (h *GoHandler) extractPackageOverview(markdown string) string {
	// Look for the package overview section
	overviewPattern := regexp.MustCompile(`(?s)package\s+\w+\s+(.+?)(?:\n\n|\n#)`)
	matches := overviewPattern.FindStringSubmatch(markdown)
	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}
	return ""
}

// formatGoDocumentation formats the output from go doc command into structured markdown.
// It processes the raw documentation to extract and organize:
//   - Package overview
//   - Function definitions and documentation
//   - Type definitions and documentation
//
// Parameters:
//   - packageName: name of the Go package
//   - symbol: optional symbol name if documenting a specific item
//   - docResult: raw documentation from go doc command
//
// Returns formatted markdown documentation.
func (h *GoHandler) formatGoDocumentation(packageName, symbol, docResult string) string {
	var result strings.Builder

	if symbol != "" {
		result.WriteString(fmt.Sprintf("# %s.%s\n\n", packageName, symbol))
	} else {
		result.WriteString(fmt.Sprintf("# %s\n\n", packageName))
	}

	// Extract package overview (first paragraph)
	lines := strings.Split(docResult, "\n")
	var overview strings.Builder
	inOverview := false

	for _, line := range lines {
		// Skip package declaration line
		if strings.HasPrefix(line, "package ") {
			continue
		}

		// Start collecting overview after empty line following package declaration
		if !inOverview && line == "" {
			inOverview = true
			continue
		}

		// Stop at next empty line or when we hit a function/type declaration
		if inOverview {
			if line == "" || strings.HasPrefix(line, "func ") || strings.HasPrefix(line, "type ") {
				break
			}
			overview.WriteString(line)
			overview.WriteString("\n")
		}
	}

	if overviewText := overview.String(); overviewText != "" {
		result.WriteString("## Overview\n\n")
		result.WriteString(overviewText)
		result.WriteString("\n\n")
	}

	// Extract functions and types
	var functions, types []string
	currentSection := ""
	var currentContent strings.Builder

	for _, line := range lines {
		if strings.HasPrefix(line, "func ") {
			if currentSection != "" && currentContent.Len() > 0 {
				if currentSection == "func" {
					functions = append(functions, currentContent.String())
				} else if currentSection == "type" {
					types = append(types, currentContent.String())
				}
				currentContent.Reset()
			}
			currentSection = "func"
			currentContent.WriteString(line)
			currentContent.WriteString("\n")
		} else if strings.HasPrefix(line, "type ") {
			if currentSection != "" && currentContent.Len() > 0 {
				if currentSection == "func" {
					functions = append(functions, currentContent.String())
				} else if currentSection == "type" {
					types = append(types, currentContent.String())
				}
				currentContent.Reset()
			}
			currentSection = "type"
			currentContent.WriteString(line)
			currentContent.WriteString("\n")
		} else if currentSection != "" {
			currentContent.WriteString(line)
			currentContent.WriteString("\n")
		}
	}

	// Add the last section
	if currentSection != "" && currentContent.Len() > 0 {
		if currentSection == "func" {
			functions = append(functions, currentContent.String())
		} else if currentSection == "type" {
			types = append(types, currentContent.String())
		}
	}

	// Add functions section
	if len(functions) > 0 {
		result.WriteString("## Functions\n\n")
		for _, function := range functions {
			result.WriteString("```go\n")
			result.WriteString(function)
			result.WriteString("```\n\n")
		}
	}

	// Add types section
	if len(types) > 0 {
		result.WriteString("## Types\n\n")
		for _, typeDecl := range types {
			result.WriteString("```go\n")
			result.WriteString(typeDecl)
			result.WriteString("```\n\n")
		}
	}

	// If we didn't extract structured content, include the full documentation
	if overview.Len() == 0 && len(functions) == 0 && len(types) == 0 {
		result.WriteString("## Documentation\n\n")
		result.WriteString("```\n")
		result.WriteString(docResult)
		result.WriteString("\n```\n")
	}

	return result.String()
}

// SearchPackage searches for content within a Go package's documentation.
// It extracts and searches through function definitions, type definitions,
// and general package documentation using configurable fuzzy matching.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Go package to search within
//   - query: search query string
//   - fuzzySearch: whether to use fuzzy matching
//
// Returns formatted search results or an error if the search fails.
func (h *GoHandler) SearchPackage(ctx context.Context, packageName, query string, fuzzySearch bool) (string, error) {
	// Get package documentation
	docResult, err := h.getGoDocumentation(ctx, packageName, "")
	if err != nil {
		return "", fmt.Errorf("failed to get package documentation: %w", err)
	}

	// Split documentation into sections
	sections := make(map[string]string)

	// Extract functions and types
	funcPattern := regexp.MustCompile(`(?ms)^func\s+([^\(]+).*?(?:^$|\z)`)
	funcMatches := funcPattern.FindAllStringSubmatch(docResult, -1)
	for _, match := range funcMatches {
		if len(match) >= 2 {
			name := strings.TrimSpace(match[1])
			sections["Function: "+name] = match[0]
		}
	}

	typePattern := regexp.MustCompile(`(?ms)^type\s+([^\s]+).*?(?:^$|\z)`)
	typeMatches := typePattern.FindAllStringSubmatch(docResult, -1)
	for _, match := range typeMatches {
		if len(match) >= 2 {
			name := strings.TrimSpace(match[1])
			sections["Type: "+name] = match[0]
		}
	}

	// If no sections were found, use the whole document
	if len(sections) == 0 {
		sections["Package Documentation"] = docResult
	}

	// Search in sections
	results := parsing.Search(query, sections, parsing.SearchOptions{
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
		formattedResults.WriteString("```go\n")
		formattedResults.WriteString(context)
		formattedResults.WriteString("\n```\n\n")
	}

	return formattedResults.String(), nil
}
