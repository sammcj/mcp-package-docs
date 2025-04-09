package parsing

import (
	"bytes"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// isHeading checks if a node is a heading
func isHeading(n ast.Node) bool {
	_, ok := n.(*ast.Heading)
	return ok
}

// MarkdownParser provides utilities for parsing Markdown content
type MarkdownParser struct {
	parser goldmark.Markdown
}

// MarkdownSection represents a section of a Markdown document
type MarkdownSection struct {
	Title   string
	Content string
	Level   int // Heading level (1-6)
}

// NewMarkdownParser creates a new Markdown parser
func NewMarkdownParser() *MarkdownParser {
	return &MarkdownParser{
		parser: goldmark.New(
			goldmark.WithExtensions(),
		),
	}
}

// ParseMarkdown parses Markdown content and returns the AST
func (p *MarkdownParser) ParseMarkdown(content string) (ast.Node, text.Reader) {
	reader := text.NewReader([]byte(content))
	return p.parser.Parser().Parse(reader), reader
}

// ExtractSections extracts sections from Markdown content based on headings
func (p *MarkdownParser) ExtractSections(content string) []MarkdownSection {
	root, reader := p.ParseMarkdown(content)

	var sections []MarkdownSection
	var currentSection *MarkdownSection

	// Walk the AST
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		switch node := n.(type) {
		case *ast.Heading:
			// If we find a heading, start a new section
			if currentSection != nil {
				// Add the previous section to our list
				sections = append(sections, *currentSection)
			}

			// Create a new section with this heading
			var title string
			if textBytes := node.Text(reader.Source()); len(textBytes) > 0 {
				title = string(textBytes)
			}
			currentSection = &MarkdownSection{
				Title: title,
				Level: node.Level,
			}

		default:
			// For all other nodes, if we have a current section, add their content to it
			if currentSection != nil && !isHeading(n) {
				var buf bytes.Buffer
				if err := p.parser.Renderer().Render(&buf, reader.Source(), n); err == nil {
					if buf.Len() > 0 {
						if currentSection.Content != "" {
							currentSection.Content += "\n"
						}
						currentSection.Content += buf.String()
					}
				}
			}
		}

		return ast.WalkContinue, nil
	})

	// Add the last section if there is one
	if currentSection != nil {
		sections = append(sections, *currentSection)
	}

	return sections
}

// FilterRelevantSections filters sections to keep only those relevant for documentation
func (p *MarkdownParser) FilterRelevantSections(sections []MarkdownSection) []MarkdownSection {
	var relevantSections []MarkdownSection

	// Define patterns for relevant and irrelevant sections
	relevantPatterns := []string{
		"(?i)usage", "(?i)example", "(?i)api", "(?i)documentation",
		"(?i)getting started", "(?i)installation", "(?i)quickstart",
		"(?i)guide", "(?i)tutorial", "(?i)how to", "(?i)features",
		"(?i)overview", "(?i)introduction", "(?i)function", "(?i)method",
		"(?i)class", "(?i)interface", "(?i)module", "(?i)package",
	}

	irrelevantPatterns := []string{
		"(?i)license", "(?i)contributor", "(?i)author", "(?i)acknowledgement",
		"(?i)changelog", "(?i)release note", "(?i)sponsor", "(?i)donation",
		"(?i)contributing", "(?i)code of conduct", "(?i)security",
	}

	// Compile patterns
	var relevantRegexps []*regexp.Regexp
	for _, pattern := range relevantPatterns {
		re, err := regexp.Compile(pattern)
		if err == nil {
			relevantRegexps = append(relevantRegexps, re)
		}
	}

	var irrelevantRegexps []*regexp.Regexp
	for _, pattern := range irrelevantPatterns {
		re, err := regexp.Compile(pattern)
		if err == nil {
			irrelevantRegexps = append(irrelevantRegexps, re)
		}
	}

	// Filter sections
	for _, section := range sections {
		// Skip empty sections
		if strings.TrimSpace(section.Content) == "" {
			continue
		}

		// Check if the section is irrelevant
		isIrrelevant := false
		for _, re := range irrelevantRegexps {
			if re.MatchString(section.Title) {
				isIrrelevant = true
				break
			}
		}

		if isIrrelevant {
			continue
		}

		// Check if the section is relevant or if it's a top-level section (likely important)
		isRelevant := section.Level <= 2 // Consider all h1 and h2 as relevant
		if !isRelevant {
			for _, re := range relevantRegexps {
				if re.MatchString(section.Title) {
					isRelevant = true
					break
				}
			}
		}

		if isRelevant {
			relevantSections = append(relevantSections, section)
		}
	}

	return relevantSections
}

// ExtractCodeBlocks extracts code blocks from Markdown content
func (p *MarkdownParser) ExtractCodeBlocks(content string) []string {
	root, reader := p.ParseMarkdown(content)

	var codeBlocks []string

	// Walk the AST to find code blocks
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		if cb, ok := n.(*ast.FencedCodeBlock); ok {
			var buf bytes.Buffer
			lines := cb.Lines()
			for i := 0; i < lines.Len(); i++ {
				line := lines.At(i)
				buf.Write(line.Value(reader.Source()))
			}

			code := buf.String()
			if code != "" {
				codeBlocks = append(codeBlocks, code)
			}
		}

		return ast.WalkContinue, nil
	})

	return codeBlocks
}

// ExtractFunctionSignatures attempts to extract function signatures from code blocks
func (p *MarkdownParser) ExtractFunctionSignatures(codeBlocks []string) []string {
	var signatures []string

	// Define patterns for common function signatures in different languages
	patterns := []*regexp.Regexp{
		// JavaScript/TypeScript
		regexp.MustCompile(`(?m)^(export\s+)?(async\s+)?(function\*?|const|let|var)\s+([a-zA-Z0-9_$]+)\s*(\([^)]*\))\s*(:\s*[^{]+)?`),
		// Python
		regexp.MustCompile(`(?m)^(async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)(\s*->\s*[^:]+)?:`),
		// Go
		regexp.MustCompile(`(?m)^func\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)\s*(\([^)]*\)|[^{]+)?`),
		// Java/Kotlin
		regexp.MustCompile(`(?m)^(public|private|protected)?\s*(static)?\s*[a-zA-Z0-9_<>]+\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)`),
		// Rust
		regexp.MustCompile(`(?m)^(pub\s+)?(fn|const|let)\s+([a-zA-Z0-9_]+)(\s*<[^>]*>)?\s*(\([^)]*\))(\s*->\s*[^{]+)?`),
		// Swift
		regexp.MustCompile(`(?m)^(public|private|internal)?\s*(static|class)?\s*func\s+([a-zA-Z0-9_]+)(\s*<[^>]*>)?\s*\(([^)]*)\)(\s*->\s*[^{]+)?`),
	}

	for _, codeBlock := range codeBlocks {
		for _, pattern := range patterns {
			matches := pattern.FindAllString(codeBlock, -1)
			for _, match := range matches {
				// Clean up the signature
				signature := strings.TrimSpace(match)
				if signature != "" {
					signatures = append(signatures, signature)
				}
			}
		}
	}

	return signatures
}

// ExtractAPISection attempts to find API documentation sections
func (p *MarkdownParser) ExtractAPISection(sections []MarkdownSection) string {
	apiPatterns := []string{
		"(?i)api", "(?i)reference", "(?i)documentation",
		"(?i)function", "(?i)method", "(?i)class", "(?i)interface",
	}

	var apiRegexps []*regexp.Regexp
	for _, pattern := range apiPatterns {
		re, err := regexp.Compile(pattern)
		if err == nil {
			apiRegexps = append(apiRegexps, re)
		}
	}

	var apiSections []MarkdownSection
	for _, section := range sections {
		for _, re := range apiRegexps {
			if re.MatchString(section.Title) {
				apiSections = append(apiSections, section)
				break
			}
		}
	}

	if len(apiSections) == 0 {
		return ""
	}

	var result strings.Builder
	for _, section := range apiSections {
		if result.Len() > 0 {
			result.WriteString("\n\n")
		}
		result.WriteString("## ")
		result.WriteString(section.Title)
		result.WriteString("\n\n")
		result.WriteString(section.Content)
	}

	return result.String()
}

// ExtractExamplesSection attempts to find example sections
func (p *MarkdownParser) ExtractExamplesSection(sections []MarkdownSection) string {
	examplePatterns := []string{
		"(?i)example", "(?i)usage", "(?i)getting started",
		"(?i)quickstart", "(?i)tutorial", "(?i)how to",
	}

	var exampleRegexps []*regexp.Regexp
	for _, pattern := range examplePatterns {
		re, err := regexp.Compile(pattern)
		if err == nil {
			exampleRegexps = append(exampleRegexps, re)
		}
	}

	var exampleSections []MarkdownSection
	for _, section := range sections {
		for _, re := range exampleRegexps {
			if re.MatchString(section.Title) {
				exampleSections = append(exampleSections, section)
				break
			}
		}
	}

	if len(exampleSections) == 0 {
		return ""
	}

	var result strings.Builder
	for _, section := range exampleSections {
		if result.Len() > 0 {
			result.WriteString("\n\n")
		}
		result.WriteString("## ")
		result.WriteString(section.Title)
		result.WriteString("\n\n")
		result.WriteString(section.Content)
	}

	return result.String()
}

// SummarizeMarkdown generates a concise summary of Markdown content
func (p *MarkdownParser) SummarizeMarkdown(content string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 500 // Default max length
	}

	// Extract the first paragraph as a summary
	paragraphs := strings.Split(content, "\n\n")
	if len(paragraphs) == 0 {
		return ""
	}

	// Find the first non-empty paragraph that doesn't start with a heading
	var summary string
	for _, para := range paragraphs {
		para = strings.TrimSpace(para)
		if para != "" && !strings.HasPrefix(para, "#") {
			summary = para
			break
		}
	}

	// If no suitable paragraph was found, use the first non-empty one
	if summary == "" && len(paragraphs) > 0 {
		for _, para := range paragraphs {
			para = strings.TrimSpace(para)
			if para != "" {
				summary = para
				break
			}
		}
	}

	// Remove Markdown formatting
	summary = regexp.MustCompile(`\[([^\]]+)\]\([^)]+\)`).ReplaceAllString(summary, "$1") // Links
	summary = regexp.MustCompile(`[*_]{1,2}([^*_]+)[*_]{1,2}`).ReplaceAllString(summary, "$1") // Bold/italic
	summary = regexp.MustCompile("`([^`]+)`").ReplaceAllString(summary, "$1") // Inline code

	// Truncate if necessary
	if len(summary) > maxLength {
		summary = summary[:maxLength-3] + "..."
	}

	return summary
}
