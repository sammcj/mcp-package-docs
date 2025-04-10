package handlers

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/sammcj/mcp-package-docs/src/go/parsing"
	"github.com/sammcj/mcp-package-docs/src/go/utils"
)

// SwiftHandler provides functionality for handling Swift packages
type SwiftHandler struct {
	cmdRunner  *utils.CommandRunner
	httpClient *utils.HTTPClient
	fsUtils    *utils.FileSystemUtils
	mdParser   *parsing.MarkdownParser
}

// NewSwiftHandler creates a new Swift handler
func NewSwiftHandler(
	cmdRunner *utils.CommandRunner,
	httpClient *utils.HTTPClient,
	fsUtils *utils.FileSystemUtils,
) *SwiftHandler {
	return &SwiftHandler{
		cmdRunner:  cmdRunner,
		httpClient: httpClient,
		fsUtils:    fsUtils,
		mdParser:   parsing.NewMarkdownParser(),
	}
}

// DescribePackage provides a brief description of a Swift package
func (h *SwiftHandler) DescribePackage(ctx context.Context, packageURL, symbol, projectPath string) (string, error) {
	// First try to get documentation using Swift Package Manager
	if projectPath != "" {
		swiftPMResult, err := h.getSwiftPMInfo(ctx, packageURL, projectPath)
		if err == nil && swiftPMResult != "" {
			return swiftPMResult, nil
		}
	}

	// If Swift PM fails or returns empty, try to fetch from GitHub
	githubResult, err := h.fetchGitHubInfo(ctx, packageURL)
	if err == nil && githubResult != "" {
		return githubResult, nil
	}

	// If both methods fail, return an error
	return "", fmt.Errorf("failed to get documentation for package %s: %w", packageURL, err)
}

// getSwiftPMInfo uses Swift Package Manager to get package metadata
func (h *SwiftHandler) getSwiftPMInfo(ctx context.Context, packageURL, projectPath string) (string, error) {
	// Check if Package.swift exists in the project path
	packageSwiftPath := fmt.Sprintf("%s/Package.swift", projectPath)
	if !h.fsUtils.FileExists(packageSwiftPath) {
		return "", fmt.Errorf("Package.swift not found at %s", packageSwiftPath)
	}

	// Read Package.swift to check if the package is a dependency
	packageSwiftContent, err := h.fsUtils.ReadFileContent(packageSwiftPath)
	if err != nil {
		return "", fmt.Errorf("failed to read Package.swift: %w", err)
	}

	// Extract package name from URL
	packageName := h.extractPackageNameFromURL(packageURL)
	if packageName == "" {
		return "", fmt.Errorf("could not extract package name from URL: %s", packageURL)
	}

	// Check if the package is a dependency in Package.swift
	if !strings.Contains(packageSwiftContent, packageURL) {
		return "", fmt.Errorf("package %s is not a dependency in Package.swift", packageURL)
	}

	// Run swift package show-dependencies to get package info
	cmdResult := h.cmdRunner.Run(ctx, "swift", "package", "--package-path", projectPath, "show-dependencies", "--format", "json")
	if cmdResult.Error != nil {
		return "", fmt.Errorf("swift package show-dependencies command failed: %w", cmdResult.Error)
	}

	// Parse the JSON response
	var dependencies []struct {
		Name         string `json:"name"`
		URL          string `json:"url"`
		Version      string `json:"version"`
		Path         string `json:"path"`
		Dependencies []struct {
			Name    string `json:"name"`
			URL     string `json:"url"`
			Version string `json:"version"`
		} `json:"dependencies"`
	}

	if err := json.Unmarshal([]byte(cmdResult.Stdout), &dependencies); err != nil {
		return "", fmt.Errorf("failed to parse dependencies: %w", err)
	}

	// Find the target package
	var targetPackage struct {
		Name    string
		URL     string
		Version string
		Path    string
	}

	for _, dep := range dependencies {
		if strings.Contains(dep.URL, packageName) || strings.EqualFold(dep.Name, packageName) {
			targetPackage.Name = dep.Name
			targetPackage.URL = dep.URL
			targetPackage.Version = dep.Version
			targetPackage.Path = dep.Path
			break
		}

		// Check nested dependencies
		for _, nestedDep := range dep.Dependencies {
			if strings.Contains(nestedDep.URL, packageName) || strings.EqualFold(nestedDep.Name, packageName) {
				targetPackage.Name = nestedDep.Name
				targetPackage.URL = nestedDep.URL
				targetPackage.Version = nestedDep.Version
				break
			}
		}
	}

	if targetPackage.Name == "" {
		return "", fmt.Errorf("package %s not found in dependencies", packageName)
	}

	// Format the package information
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# %s\n\n", targetPackage.Name))

	if targetPackage.Version != "" {
		sb.WriteString(fmt.Sprintf("**Version:** %s\n\n", targetPackage.Version))
	}

	if targetPackage.URL != "" {
		sb.WriteString(fmt.Sprintf("**URL:** %s\n\n", targetPackage.URL))
	}

	// Try to read the README.md file if the package path is available
	if targetPackage.Path != "" {
		readmePath := fmt.Sprintf("%s/README.md", targetPackage.Path)
		if h.fsUtils.FileExists(readmePath) {
			readmeContent, err := h.fsUtils.ReadFileContent(readmePath)
			if err == nil {
				// Extract relevant sections
				sections := h.mdParser.ExtractSections(readmeContent)
				relevantSections := h.mdParser.FilterRelevantSections(sections)

				for _, section := range relevantSections {
					sb.WriteString(fmt.Sprintf("## %s\n\n%s\n\n", section.Title, section.Content))
				}
			}
		}
	}

	return sb.String(), nil
}

// fetchGitHubInfo attempts to fetch documentation from GitHub
func (h *SwiftHandler) fetchGitHubInfo(ctx context.Context, packageURL string) (string, error) {
	// Extract owner and repo from GitHub URL
	owner, repo, err := h.extractGitHubOwnerRepo(packageURL)
	if err != nil {
		return "", err
	}

	// Fetch repository information from GitHub API
	repoURL := fmt.Sprintf("https://api.github.com/repos/%s/%s", owner, repo)
	repoData, err := h.httpClient.Get(ctx, repoURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch repository info from GitHub: %w", err)
	}

	// Parse the JSON response
	var repoInfo struct {
		Name        string `json:"name"`
		FullName    string `json:"full_name"`
		Description string `json:"description"`
		Homepage    string `json:"homepage"`
		Language    string `json:"language"`
		License     struct {
			Name string `json:"name"`
		} `json:"license"`
		Topics    []string `json:"topics"`
		StarCount int      `json:"stargazers_count"`
		ForkCount int      `json:"forks_count"`
	}

	if err := json.Unmarshal(repoData, &repoInfo); err != nil {
		return "", fmt.Errorf("failed to parse repository info: %w", err)
	}

	// Format the repository information
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# %s\n\n", repoInfo.Name))

	if repoInfo.Description != "" {
		sb.WriteString(fmt.Sprintf("%s\n\n", repoInfo.Description))
	}

	// Add metadata
	sb.WriteString("## Package Information\n\n")

	if repoInfo.Language != "" {
		sb.WriteString(fmt.Sprintf("**Language:** %s\n\n", repoInfo.Language))
	}

	if repoInfo.License.Name != "" {
		sb.WriteString(fmt.Sprintf("**License:** %s\n\n", repoInfo.License.Name))
	}

	if len(repoInfo.Topics) > 0 {
		sb.WriteString(fmt.Sprintf("**Topics:** %s\n\n", strings.Join(repoInfo.Topics, ", ")))
	}

	sb.WriteString(fmt.Sprintf("**Stars:** %d\n\n", repoInfo.StarCount))
	sb.WriteString(fmt.Sprintf("**Forks:** %d\n\n", repoInfo.ForkCount))

	// Add links
	sb.WriteString("## Links\n\n")

	if repoInfo.Homepage != "" {
		sb.WriteString(fmt.Sprintf("**Homepage:** %s\n\n", repoInfo.Homepage))
	}

	sb.WriteString(fmt.Sprintf("**Repository:** %s\n\n", packageURL))

	// Fetch README from GitHub API
	readmeURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/readme", owner, repo)
	readmeData, err := h.httpClient.Get(ctx, readmeURL, nil)
	if err == nil {
		var readmeInfo struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}

		if err := json.Unmarshal(readmeData, &readmeInfo); err == nil && readmeInfo.Content != "" {
			// Decode base64 content
			readmeContent, err := h.decodeBase64(readmeInfo.Content)
			if err == nil {
				// Extract relevant sections
				sections := h.mdParser.ExtractSections(readmeContent)
				relevantSections := h.mdParser.FilterRelevantSections(sections)

				if len(relevantSections) > 0 {
					sb.WriteString("## Documentation\n\n")
					for _, section := range relevantSections {
						sb.WriteString(fmt.Sprintf("### %s\n\n%s\n\n", section.Title, section.Content))
					}
				} else {
					// If no relevant sections found, include a summary
					summary := h.mdParser.SummarizeMarkdown(readmeContent, 500)
					if summary != "" {
						sb.WriteString("## Summary\n\n")
						sb.WriteString(summary)
						sb.WriteString("\n\n")
					}
				}
			}
		}
	}

	// Fetch Package.swift from GitHub API
	packageSwiftURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/contents/Package.swift", owner, repo)
	packageSwiftData, err := h.httpClient.Get(ctx, packageSwiftURL, nil)
	if err == nil {
		var packageSwiftInfo struct {
			Content  string `json:"content"`
			Encoding string `json:"encoding"`
		}

		if err := json.Unmarshal(packageSwiftData, &packageSwiftInfo); err == nil && packageSwiftInfo.Content != "" {
			// Decode base64 content
			packageSwiftContent, err := h.decodeBase64(packageSwiftInfo.Content)
			if err == nil {
				// Extract dependencies from Package.swift
				dependencies := h.extractDependenciesFromPackageSwift(packageSwiftContent)
				if len(dependencies) > 0 {
					sb.WriteString("## Dependencies\n\n")
					for _, dep := range dependencies {
						sb.WriteString(fmt.Sprintf("- %s\n", dep))
					}
					sb.WriteString("\n")
				}

				// Extract products from Package.swift
				products := h.extractProductsFromPackageSwift(packageSwiftContent)
				if len(products) > 0 {
					sb.WriteString("## Products\n\n")
					for _, product := range products {
						sb.WriteString(fmt.Sprintf("- %s\n", product))
					}
					sb.WriteString("\n")
				}
			}
		}
	}

	return sb.String(), nil
}

// extractGitHubOwnerRepo extracts the owner and repository name from a GitHub URL
func (h *SwiftHandler) extractGitHubOwnerRepo(url string) (string, string, error) {
	// Match GitHub URL patterns
	patterns := []string{
		`github\.com/([^/]+)/([^/]+)`,
		`github\.com:([^/]+)/([^/\.]+)`,
	}

	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		matches := re.FindStringSubmatch(url)
		if len(matches) >= 3 {
			owner := matches[1]
			repo := matches[2]
			// Remove .git suffix if present
			repo = strings.TrimSuffix(repo, ".git")
			return owner, repo, nil
		}
	}

	return "", "", fmt.Errorf("could not extract owner and repository from URL: %s", url)
}

// extractPackageNameFromURL extracts the package name from a URL
func (h *SwiftHandler) extractPackageNameFromURL(url string) string {
	// Extract the last part of the URL
	parts := strings.Split(url, "/")
	if len(parts) == 0 {
		return ""
	}

	lastPart := parts[len(parts)-1]
	// Remove .git suffix if present
	return strings.TrimSuffix(lastPart, ".git")
}

// decodeBase64 decodes a base64 encoded string
func (h *SwiftHandler) decodeBase64(encoded string) (string, error) {
	// GitHub API returns base64 content with newlines, remove them
	encoded = strings.ReplaceAll(encoded, "\n", "")
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// extractDependenciesFromPackageSwift extracts dependencies from Package.swift content
func (h *SwiftHandler) extractDependenciesFromPackageSwift(content string) []string {
	var dependencies []string

	// Match dependency declarations
	depPattern := regexp.MustCompile(`\.package\(url:\s*"([^"]+)",\s*from:\s*"([^"]+)"\)`)
	matches := depPattern.FindAllStringSubmatch(content, -1)
	for _, match := range matches {
		if len(match) >= 3 {
			dependencies = append(dependencies, fmt.Sprintf("%s (from %s)", match[1], match[2]))
		}
	}

	return dependencies
}

// extractProductsFromPackageSwift extracts products from Package.swift content
func (h *SwiftHandler) extractProductsFromPackageSwift(content string) []string {
	var products []string

	// Match product declarations
	productPattern := regexp.MustCompile(`\.(?:library|executable)\(\s*name:\s*"([^"]+)"`)
	matches := productPattern.FindAllStringSubmatch(content, -1)
	for _, match := range matches {
		if len(match) >= 2 {
			products = append(products, match[1])
		}
	}

	return products
}

// SearchPackage searches for content within a Swift package
func (h *SwiftHandler) SearchPackage(ctx context.Context, packageURL, query string, fuzzySearch bool) (string, error) {
	// Extract owner and repo from GitHub URL
	owner, repo, err := h.extractGitHubOwnerRepo(packageURL)
	if err != nil {
		return "", err
	}

	// Fetch README from GitHub API
	readmeURL := fmt.Sprintf("https://api.github.com/repos/%s/%s/readme", owner, repo)
	readmeData, err := h.httpClient.Get(ctx, readmeURL, nil)
	if err != nil {
		return "", fmt.Errorf("failed to fetch README from GitHub: %w", err)
	}

	var readmeInfo struct {
		Content  string `json:"content"`
		Encoding string `json:"encoding"`
	}

	if err := json.Unmarshal(readmeData, &readmeInfo); err != nil {
		return "", fmt.Errorf("failed to parse README info: %w", err)
	}

	// Decode base64 content
	readmeContent, err := h.decodeBase64(readmeInfo.Content)
	if err != nil {
		return "", fmt.Errorf("failed to decode README content: %w", err)
	}

	// Extract sections from the markdown
	sections := h.mdParser.ExtractSections(readmeContent)

	// Create a map of section content
	sectionMap := make(map[string]string)
	for i, section := range sections {
		sectionMap[fmt.Sprintf("Section %d: %s", i, section.Title)] = section.Content
	}

	// If no sections were found, use the whole document
	if len(sectionMap) == 0 {
		sectionMap["Package Documentation"] = readmeContent
	}

	// Search in sections
	results := parsing.Search(query, sectionMap, parsing.SearchOptions{
		Query:       query,
		FuzzySearch: fuzzySearch,
		MaxResults:  5,
	})

	// Format results
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# Search Results for '%s' in %s\n\n", query, repo))

	if len(results) == 0 {
		sb.WriteString("No results found.")
		return sb.String(), nil
	}

	for i, result := range results {
		sb.WriteString(fmt.Sprintf("## Result %d: %s\n\n", i+1, result.Source))

		// Extract context around the match
		context := parsing.ExtractContextAroundMatch(result.Content, query, 200)
		sb.WriteString("```swift\n")
		sb.WriteString(context)
		sb.WriteString("\n```\n\n")
	}

	return sb.String(), nil
}
