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

// PythonHandler provides functionality for handling Python package documentation.
// It supports multiple documentation sources:
//   - Local pip and pydoc commands for installed packages
//   - PyPI API for package metadata and documentation
// The handler implements fallback mechanisms between these sources.
type PythonHandler struct {
	cmdRunner  *utils.CommandRunner
	httpClient *utils.HTTPClient
	fsUtils    *utils.FileSystemUtils
	mdParser   *parsing.MarkdownParser
}

// NewPythonHandler creates a new Python handler with the necessary dependencies.
// Parameters:
//   - cmdRunner: for executing pip and pydoc commands
//   - httpClient: for fetching documentation from PyPI
//   - fsUtils: for filesystem operations
// Returns an initialized PythonHandler instance.
func NewPythonHandler(
	cmdRunner *utils.CommandRunner,
	httpClient *utils.HTTPClient,
	fsUtils *utils.FileSystemUtils,
) *PythonHandler {
	return &PythonHandler{
		cmdRunner:  cmdRunner,
		httpClient: httpClient,
		fsUtils:    fsUtils,
		mdParser:   parsing.NewMarkdownParser(),
	}
}

// DescribePackage provides a comprehensive description of a Python package.
// It attempts to retrieve documentation in the following order:
//   1. Local pip show and pydoc commands for installed packages
//   2. PyPI API for package metadata and documentation
// For symbol-specific documentation, it will attempt to get targeted information.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Python package to describe
//   - symbol: optional specific symbol (function, class, etc.) to describe
//   - projectPath: optional path to project directory
// Returns formatted documentation or an error if all retrieval methods fail.
func (h *PythonHandler) DescribePackage(ctx context.Context, packageName, symbol, projectPath string) (string, error) {
	// First try to get documentation using pip show and pydoc
	pipInfo, err := h.getPipInfo(ctx, packageName)
	if err == nil && pipInfo != "" {
		// If symbol is provided, get specific documentation for it
		if symbol != "" {
			symbolDoc, err := h.getPythonDocumentation(ctx, packageName, symbol)
			if err == nil && symbolDoc != "" {
				return h.formatPythonDocumentation(packageName, symbol, pipInfo, symbolDoc), nil
			}
		} else {
			// Get general package documentation
			packageDoc, err := h.getPythonDocumentation(ctx, packageName, "")
			if err == nil && packageDoc != "" {
				return h.formatPythonDocumentation(packageName, "", pipInfo, packageDoc), nil
			}
		}
	}

	// If pip/pydoc fails or returns empty, try to fetch from PyPI
	pypiResult, err := h.fetchPyPI(ctx, packageName)
	if err == nil && pypiResult != "" {
		return pypiResult, nil
	}

	// If both methods fail, return an error
	return "", fmt.Errorf("failed to get documentation for package %s: %w", packageName, err)
}

// getPipInfo uses pip show to get package metadata from local installation.
// This provides basic package information such as version, author, and dependencies.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Python package
// Returns package metadata or an error if the pip command fails.
func (h *PythonHandler) getPipInfo(ctx context.Context, packageName string) (string, error) {
	result := h.cmdRunner.Run(ctx, "pip", "show", packageName)
	if result.Error != nil {
		return "", fmt.Errorf("pip show command failed: %w", result.Error)
	}

	return result.Stdout, nil
}

// getPythonDocumentation uses pydoc to get package documentation from local installation.
// It can retrieve both package-level and symbol-specific documentation.
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Python package
//   - symbol: optional specific symbol to document
// Returns formatted documentation or an error if the pydoc command fails.
func (h *PythonHandler) getPythonDocumentation(ctx context.Context, packageName, symbol string) (string, error) {
	var args []string
	if symbol != "" {
		args = []string{packageName + "." + symbol}
	} else {
		args = []string{packageName}
	}

	result := h.cmdRunner.Run(ctx, "python", append([]string{"-m", "pydoc"}, args...)...)
	if result.Error != nil {
		return "", fmt.Errorf("pydoc command failed: %w", result.Error)
	}

	return result.Stdout, nil
}

// fetchPyPI attempts to fetch documentation from the Python Package Index (PyPI).
// This provides comprehensive package metadata including:
//   - Version information and summary
//   - Detailed description (in Markdown if available)
//   - Author information and license
//   - Project links and homepage
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Python package
// Returns formatted package information or an error if retrieval fails.
func (h *PythonHandler) fetchPyPI(ctx context.Context, packageName string) (string, error) {
	url := fmt.Sprintf("https://pypi.org/pypi/%s/json", packageName)

	data, err := h.httpClient.Get(ctx, url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch from PyPI: %w", err)
	}

	// Parse the JSON response
	var pypiInfo struct {
		Info struct {
			Name        string `json:"name"`
			Version     string `json:"version"`
			Summary     string `json:"summary"`
			Description string `json:"description"`
			Author      string `json:"author"`
			AuthorEmail string `json:"author_email"`
			License     string `json:"license"`
			ProjectURL  string `json:"project_url"`
			Homepage    string `json:"home_page"`
		} `json:"info"`
	}

	if err := json.Unmarshal(data, &pypiInfo); err != nil {
		return "", fmt.Errorf("failed to parse PyPI info: %w", err)
	}

	// Format the PyPI information
	var result strings.Builder
	result.WriteString(fmt.Sprintf("# %s %s\n\n", pypiInfo.Info.Name, pypiInfo.Info.Version))

	if pypiInfo.Info.Summary != "" {
		result.WriteString(fmt.Sprintf("%s\n\n", pypiInfo.Info.Summary))
	}

	if pypiInfo.Info.Description != "" {
		// Check if the description is in Markdown format
		if strings.Contains(pypiInfo.Info.Description, "#") || strings.Contains(pypiInfo.Info.Description, "```") {
			// Extract relevant sections
			sections := h.mdParser.ExtractSections(pypiInfo.Info.Description)
			relevantSections := h.mdParser.FilterRelevantSections(sections)

			for _, section := range relevantSections {
				result.WriteString(fmt.Sprintf("## %s\n\n%s\n\n", section.Title, section.Content))
			}
		} else {
			// If not Markdown, just include a summary
			summary := h.mdParser.SummarizeMarkdown(pypiInfo.Info.Description, 500)
			result.WriteString(fmt.Sprintf("## Description\n\n%s\n\n", summary))
		}
	}

	// Add metadata
	result.WriteString("## Package Information\n\n")

	if pypiInfo.Info.Author != "" {
		result.WriteString(fmt.Sprintf("**Author:** %s", pypiInfo.Info.Author))
		if pypiInfo.Info.AuthorEmail != "" {
			result.WriteString(fmt.Sprintf(" <%s>", pypiInfo.Info.AuthorEmail))
		}
		result.WriteString("\n\n")
	}

	if pypiInfo.Info.License != "" {
		result.WriteString(fmt.Sprintf("**License:** %s\n\n", pypiInfo.Info.License))
	}

	if pypiInfo.Info.Homepage != "" {
		result.WriteString(fmt.Sprintf("**Homepage:** %s\n\n", pypiInfo.Info.Homepage))
	} else if pypiInfo.Info.ProjectURL != "" {
		result.WriteString(fmt.Sprintf("**Project URL:** %s\n\n", pypiInfo.Info.ProjectURL))
	}

	return result.String(), nil
}

// formatPythonDocumentation formats the combined output from pip show and pydoc.
// It processes and organizes:
//   - Package metadata from pip show
//   - Documentation from pydoc
//   - Symbol-specific documentation when applicable
// The output is structured into sections including:
//   - Package overview and summary
//   - Module docstring
//   - Functions and classes documentation
// Parameters:
//   - packageName: name of the Python package
//   - symbol: optional symbol name if documenting a specific item
//   - pipInfo: metadata from pip show command
//   - docResult: documentation from pydoc
// Returns formatted markdown documentation.
func (h *PythonHandler) formatPythonDocumentation(packageName, symbol, pipInfo, docResult string) string {
	var result strings.Builder

	// Extract package metadata from pip info
	var name, version, summary, author, license, homepage string
	lines := strings.Split(pipInfo, "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "Name: ") {
			name = strings.TrimPrefix(line, "Name: ")
		} else if strings.HasPrefix(line, "Version: ") {
			version = strings.TrimPrefix(line, "Version: ")
		} else if strings.HasPrefix(line, "Summary: ") {
			summary = strings.TrimPrefix(line, "Summary: ")
		} else if strings.HasPrefix(line, "Author: ") {
			author = strings.TrimPrefix(line, "Author: ")
		} else if strings.HasPrefix(line, "License: ") {
			license = strings.TrimPrefix(line, "License: ")
		} else if strings.HasPrefix(line, "Home-page: ") {
			homepage = strings.TrimPrefix(line, "Home-page: ")
		}
	}

	// Format the header
	if symbol != "" {
		result.WriteString(fmt.Sprintf("# %s.%s\n\n", packageName, symbol))
	} else {
		result.WriteString(fmt.Sprintf("# %s %s\n\n", name, version))
	}

	// Add summary if available
	if summary != "" {
		result.WriteString(fmt.Sprintf("%s\n\n", summary))
	}

	// Process the documentation
	if symbol != "" {
		// For a specific symbol, include the full documentation
		result.WriteString("## Documentation\n\n")
		result.WriteString("```python\n")
		result.WriteString(docResult)
		result.WriteString("\n```\n\n")
	} else {
		// For a package, extract and format the documentation
		// Extract module docstring
		docstringPattern := regexp.MustCompile(`(?s)DESCRIPTION\s+(.*?)(?:\n\n|\nNAME|\nPACKAGE|\nFUNCTIONS|\nCLASSES|\z)`)
		matches := docstringPattern.FindStringSubmatch(docResult)
		if len(matches) > 1 && matches[1] != "" {
			result.WriteString("## Description\n\n")
			result.WriteString(strings.TrimSpace(matches[1]))
			result.WriteString("\n\n")
		}

		// Extract functions
		functionsPattern := regexp.MustCompile(`(?s)FUNCTIONS\s+(.*?)(?:\n\n|\nCLASSES|\nDATA|\z)`)
		matches = functionsPattern.FindStringSubmatch(docResult)
		if len(matches) > 1 && matches[1] != "" {
			result.WriteString("## Functions\n\n")
			result.WriteString("```python\n")
			result.WriteString(strings.TrimSpace(matches[1]))
			result.WriteString("\n```\n\n")
		}

		// Extract classes
		classesPattern := regexp.MustCompile(`(?s)CLASSES\s+(.*?)(?:\n\n|\nDATA|\z)`)
		matches = classesPattern.FindStringSubmatch(docResult)
		if len(matches) > 1 && matches[1] != "" {
			result.WriteString("## Classes\n\n")
			result.WriteString("```python\n")
			result.WriteString(strings.TrimSpace(matches[1]))
			result.WriteString("\n```\n\n")
		}
	}

	// Add metadata
	result.WriteString("## Package Information\n\n")

	if author != "" {
		result.WriteString(fmt.Sprintf("**Author:** %s\n\n", author))
	}

	if license != "" {
		result.WriteString(fmt.Sprintf("**License:** %s\n\n", license))
	}

	if homepage != "" {
		result.WriteString(fmt.Sprintf("**Homepage:** %s\n\n", homepage))
	}

	return result.String()
}

// SearchPackage searches for content within a Python package's documentation.
// It searches through:
//   - Module docstrings
//   - Function definitions and documentation
//   - Class definitions and documentation
// Parameters:
//   - ctx: context for the operation
//   - packageName: name of the Python package to search within
//   - query: search query string
//   - fuzzySearch: whether to use fuzzy matching
// Returns formatted search results or an error if the search fails.
func (h *PythonHandler) SearchPackage(ctx context.Context, packageName, query string, fuzzySearch bool) (string, error) {
	// Get package documentation
	docResult, err := h.getPythonDocumentation(ctx, packageName, "")
	if err != nil {
		return "", fmt.Errorf("failed to get package documentation: %w", err)
	}

	// Split documentation into sections
	sections := make(map[string]string)

	// Extract module docstring
	docstringPattern := regexp.MustCompile(`(?s)DESCRIPTION\s+(.*?)(?:\n\n|\nNAME|\nPACKAGE|\nFUNCTIONS|\nCLASSES|\z)`)
	matches := docstringPattern.FindStringSubmatch(docResult)
	if len(matches) > 1 && matches[1] != "" {
		sections["Description"] = matches[1]
	}

	// Extract functions
	functionsPattern := regexp.MustCompile(`(?s)FUNCTIONS\s+(.*?)(?:\n\n|\nCLASSES|\nDATA|\z)`)
	matches = functionsPattern.FindStringSubmatch(docResult)
	if len(matches) > 1 && matches[1] != "" {
		sections["Functions"] = matches[1]
	}

	// Extract classes
	classesPattern := regexp.MustCompile(`(?s)CLASSES\s+(.*?)(?:\n\n|\nDATA|\z)`)
	matches = classesPattern.FindStringSubmatch(docResult)
	if len(matches) > 1 && matches[1] != "" {
		sections["Classes"] = matches[1]
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
		formattedResults.WriteString("```python\n")
		formattedResults.WriteString(context)
		formattedResults.WriteString("\n```\n\n")
	}

	return formattedResults.String(), nil
}
