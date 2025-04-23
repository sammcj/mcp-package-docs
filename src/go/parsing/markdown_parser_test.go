package parsing

import (
	"strings"
	"testing"

	"github.com/yuin/goldmark/ast"
)

func TestNewMarkdownParser(t *testing.T) {
	parser := NewMarkdownParser()
	if parser == nil {
		t.Fatal("Expected non-nil MarkdownParser")
	}
	if parser.parser == nil {
		t.Fatal("Expected non-nil goldmark parser")
	}
}

func TestMarkdownParser_ParseMarkdown(t *testing.T) {
	parser := NewMarkdownParser()

	// Test with valid Markdown
	markdown := "# Heading\n\nThis is a paragraph.\n\n## Subheading\n\n- List item 1\n- List item 2"
	root, reader := parser.ParseMarkdown(markdown)

	if root == nil {
		t.Fatal("Expected non-nil AST root node")
	}
	if reader == nil {
		t.Fatal("Expected non-nil text reader")
	}

	// Check if the AST contains the expected nodes
	var headingCount, paragraphCount, listCount int
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}

		switch n.(type) {
		case *ast.Heading:
			headingCount++
		case *ast.Paragraph:
			paragraphCount++
		case *ast.List:
			listCount++
		}
		return ast.WalkContinue, nil
	})

	if headingCount != 2 {
		t.Errorf("Expected 2 headings, got %d", headingCount)
	}
	if paragraphCount != 1 {
		t.Errorf("Expected 1 paragraph, got %d", paragraphCount)
	}
	if listCount != 1 {
		t.Errorf("Expected 1 list, got %d", listCount)
	}

	// Test with empty Markdown
	emptyRoot, emptyReader := parser.ParseMarkdown("")
	if emptyRoot == nil {
		t.Fatal("Expected non-nil AST root node for empty Markdown")
	}
	if emptyReader == nil {
		t.Fatal("Expected non-nil text reader for empty Markdown")
	}

	// Check if the empty AST contains no content nodes
	var nodeCount int
	ast.Walk(emptyRoot, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && n != emptyRoot {
			nodeCount++
		}
		return ast.WalkContinue, nil
	})

	if nodeCount > 0 {
		t.Errorf("Expected empty AST for empty Markdown, got %d nodes", nodeCount)
	}
}

func TestMarkdownParser_ExtractSections(t *testing.T) {
	parser := NewMarkdownParser()

	// Test with Markdown containing multiple sections
	markdown := `# Main Heading

Introduction paragraph.

## Section 1

Content of section 1.

### Subsection 1.1

Content of subsection 1.1.

## Section 2

Content of section 2.

# Another Main Heading

Another introduction paragraph.`

	sections := parser.ExtractSections(markdown)

	// Check if the correct number of sections was extracted
	if len(sections) != 5 {
		t.Errorf("Expected 5 sections, got %d", len(sections))
	}

	// Check specific sections
	expectedSections := []struct {
		Title   string
		Content string
		Level   int
	}{
		{"Main Heading", "Introduction paragraph.", 1},
		{"Section 1", "Content of section 1.", 2},
		{"Subsection 1.1", "Content of subsection 1.1.", 3},
		{"Section 2", "Content of section 2.", 2},
		{"Another Main Heading", "Another introduction paragraph.", 1},
	}

	for i, expected := range expectedSections {
		if i >= len(sections) {
			t.Errorf("Missing section at index %d", i)
			continue
		}

		section := sections[i]
		if section.Title != expected.Title {
			t.Errorf("Expected section title '%s', got '%s'", expected.Title, section.Title)
		}
		if !strings.Contains(section.Content, expected.Content) {
			t.Errorf("Expected section content to contain '%s', got '%s'", expected.Content, section.Content)
		}
		if section.Level != expected.Level {
			t.Errorf("Expected section level %d, got %d", expected.Level, section.Level)
		}
	}

	// Test with empty Markdown
	emptySections := parser.ExtractSections("")
	if len(emptySections) != 0 {
		t.Errorf("Expected 0 sections for empty Markdown, got %d", len(emptySections))
	}

	// Test with Markdown containing only headings (no content)
	headingsOnlyMarkdown := "# Heading 1\n## Heading 2\n### Heading 3"
	headingsOnlySections := parser.ExtractSections(headingsOnlyMarkdown)
	if len(headingsOnlySections) != 3 {
		t.Errorf("Expected 3 sections for headings-only Markdown, got %d", len(headingsOnlySections))
	}
	for _, section := range headingsOnlySections {
		if section.Content != "" {
			t.Errorf("Expected empty content for heading-only section, got '%s'", section.Content)
		}
	}
}

func TestMarkdownParser_FilterRelevantSections(t *testing.T) {
	parser := NewMarkdownParser()

	// Create test sections
	sections := []MarkdownSection{
		{Title: "Introduction", Content: "This is an introduction.", Level: 1},
		{Title: "Installation", Content: "How to install the package.", Level: 2},
		{Title: "Usage", Content: "How to use the package.", Level: 2},
		{Title: "API Reference", Content: "API documentation.", Level: 2},
		{Title: "Examples", Content: "Code examples.", Level: 2},
		{Title: "License", Content: "MIT License", Level: 2},
		{Title: "Contributors", Content: "List of contributors.", Level: 2},
		{Title: "Random Section", Content: "Some random content.", Level: 3},
	}

	// Filter relevant sections
	relevantSections := parser.FilterRelevantSections(sections)

	// Check if the correct sections were filtered
	if len(relevantSections) != 5 {
		t.Errorf("Expected 5 relevant sections, got %d", len(relevantSections))
	}

	// Check that relevant sections were kept
	relevantTitles := []string{"Introduction", "Installation", "Usage", "API Reference", "Examples"}
	for _, title := range relevantTitles {
		found := false
		for _, section := range relevantSections {
			if section.Title == title {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Expected to find relevant section '%s', but it was filtered out", title)
		}
	}

	// Check that irrelevant sections were filtered out
	irrelevantTitles := []string{"License", "Contributors"}
	for _, title := range irrelevantTitles {
		found := false
		for _, section := range relevantSections {
			if section.Title == title {
				found = true
				break
			}
		}
		if found {
			t.Errorf("Expected irrelevant section '%s' to be filtered out, but it was kept", title)
		}
	}

	// Test with empty sections
	emptySections := parser.FilterRelevantSections([]MarkdownSection{})
	if len(emptySections) != 0 {
		t.Errorf("Expected 0 sections for empty input, got %d", len(emptySections))
	}

	// Test with sections that have empty content
	emptyContentSections := []MarkdownSection{
		{Title: "Usage", Content: "", Level: 2},
		{Title: "API", Content: "", Level: 2},
	}
	filteredEmptyContentSections := parser.FilterRelevantSections(emptyContentSections)
	if len(filteredEmptyContentSections) != 0 {
		t.Errorf("Expected 0 sections for empty content sections, got %d", len(filteredEmptyContentSections))
	}
}

func TestMarkdownParser_ExtractCodeBlocks(t *testing.T) {
	parser := NewMarkdownParser()

	// Test with Markdown containing code blocks
	markdown := `# Code Examples

Here's a JavaScript example:

` + "```javascript" + `
function example() {
    return "Hello, world!";
}
` + "```" + `

And a Python example:

` + "```python" + `
def example():
    return "Hello, world!"
` + "```" + `

Inline code: ` + "`const x = 5;`" + `
`

	codeBlocks := parser.ExtractCodeBlocks(markdown)

	// Check if the correct number of code blocks was extracted
	if len(codeBlocks) != 2 {
		t.Errorf("Expected 2 code blocks, got %d", len(codeBlocks))
	}

	// Check specific code blocks
	expectedBlocks := []string{
		"function example() {\n    return \"Hello, world!\";\n}",
		"def example():\n    return \"Hello, world!\"",
	}

	for i, expected := range expectedBlocks {
		if i >= len(codeBlocks) {
			t.Errorf("Missing code block at index %d", i)
			continue
		}
		if !strings.Contains(codeBlocks[i], expected) {
			t.Errorf("Expected code block to contain '%s', got '%s'", expected, codeBlocks[i])
		}
	}

	// Test with Markdown containing no code blocks
	noCodeMarkdown := "# Heading\n\nThis is a paragraph with no code blocks."
	noCodeBlocks := parser.ExtractCodeBlocks(noCodeMarkdown)
	if len(noCodeBlocks) != 0 {
		t.Errorf("Expected 0 code blocks for Markdown without code blocks, got %d", len(noCodeBlocks))
	}

	// Test with empty Markdown
	emptyCodeBlocks := parser.ExtractCodeBlocks("")
	if len(emptyCodeBlocks) != 0 {
		t.Errorf("Expected 0 code blocks for empty Markdown, got %d", len(emptyCodeBlocks))
	}
}

func TestMarkdownParser_ExtractFunctionSignatures(t *testing.T) {
	parser := NewMarkdownParser()

	// Create test code blocks with function signatures in different languages
	codeBlocks := []string{
		// JavaScript/TypeScript
		`function calculateTotal(items: Item[], tax: number = 0.1): number {
    const subtotal = items.reduce((sum, item) => sum + item.price, 0);
    return subtotal * (1 + tax);
}

const greet = (name: string): string => {
	return fmt.Sprintf("Hello, %s!", name)
};`,
		// Python
		`def calculate_total(items, tax=0.1):
    """Calculate the total price with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax)

async def fetch_data(url: str) -> dict:
    """Fetch data from URL asynchronously."""
    response = await http.get(url)
    return response.json()`,
		// Go
		`func CalculateTotal(items []Item, tax float64) float64 {
    subtotal := 0.0
    for _, item := range items {
        subtotal += item.Price
    }
    return subtotal * (1 + tax)
}

func (s *Service) ProcessOrder(ctx context.Context, order Order) (OrderResult, error) {
    // Process the order
    return OrderResult{}, nil
}`,
		// Rust
		`pub fn calculate_total(items: &[Item], tax: f64) -> f64 {
    let subtotal: f64 = items.iter().map(|item| item.price).sum();
    subtotal * (1.0 + tax)
}

fn process_order<T: AsRef<str>>(order_id: T) -> Result<Order, Error> {
    // Process the order
    Ok(Order::new())
}`,
	}

	// Extract function signatures
	signatures := parser.ExtractFunctionSignatures(codeBlocks)

	// Check if signatures were extracted
	if len(signatures) == 0 {
		t.Fatal("Expected function signatures to be extracted, got none")
	}

	// Check for specific signatures
	expectedSignatures := []string{
		"function calculateTotal(items: Item[], tax: number = 0.1): number",
		"const greet = (name: string): string",
		"def calculate_total(items, tax=0.1):",
		"async def fetch_data(url: str) -> dict:",
		"func CalculateTotal(items []Item, tax float64) float64",
		"func (s *Service) ProcessOrder(ctx context.Context, order Order) (OrderResult, error)",
		"pub fn calculate_total(items: &[Item], tax: f64) -> f64",
		"fn process_order<T: AsRef<str>>(order_id: T) -> Result<Order, Error>",
	}

	for _, expected := range expectedSignatures {
		found := false
		for _, signature := range signatures {
			if strings.Contains(signature, expected) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Expected to find signature containing '%s', but it was not extracted", expected)
		}
	}

	// Test with empty code blocks
	emptySignatures := parser.ExtractFunctionSignatures([]string{})
	if len(emptySignatures) != 0 {
		t.Errorf("Expected 0 signatures for empty code blocks, got %d", len(emptySignatures))
	}

	// Test with code blocks that don't contain function signatures
	noSignatureBlocks := []string{
		"const x = 5;",
		"let y = 10;",
		"// This is a comment",
	}
	noSignatures := parser.ExtractFunctionSignatures(noSignatureBlocks)
	if len(noSignatures) != 0 {
		t.Errorf("Expected 0 signatures for code blocks without functions, got %d", len(noSignatures))
	}
}

func TestMarkdownParser_ExtractAPISection(t *testing.T) {
	parser := NewMarkdownParser()

	// Create test sections
	sections := []MarkdownSection{
		{Title: "Introduction", Content: "This is an introduction.", Level: 1},
		{Title: "API Reference", Content: "API documentation.", Level: 2},
		{Title: "Methods", Content: "Method documentation.", Level: 2},
		{Title: "Usage", Content: "Usage examples.", Level: 2},
		{Title: "Examples", Content: "Code examples.", Level: 2},
	}

	// Extract API section
	apiSection := parser.ExtractAPISection(sections)

	// Check if API sections were extracted and combined
	expectedTitles := []string{"API Reference", "Methods"}
	for _, title := range expectedTitles {
		if !strings.Contains(apiSection, title) {
			t.Errorf("Expected API section to contain '%s', got '%s'", title, apiSection)
		}
	}

	// Test with no API sections
	noAPISections := []MarkdownSection{
		{Title: "Introduction", Content: "This is an introduction.", Level: 1},
		{Title: "Usage", Content: "Usage examples.", Level: 2},
		{Title: "Examples", Content: "Code examples.", Level: 2},
	}
	noAPISection := parser.ExtractAPISection(noAPISections)
	if noAPISection != "" {
		t.Errorf("Expected empty string for no API sections, got '%s'", noAPISection)
	}

	// Test with empty sections
	emptyAPISection := parser.ExtractAPISection([]MarkdownSection{})
	if emptyAPISection != "" {
		t.Errorf("Expected empty string for empty sections, got '%s'", emptyAPISection)
	}
}

func TestMarkdownParser_ExtractExamplesSection(t *testing.T) {
	parser := NewMarkdownParser()

	// Create test sections
	sections := []MarkdownSection{
		{Title: "Introduction", Content: "This is an introduction.", Level: 1},
		{Title: "API Reference", Content: "API documentation.", Level: 2},
		{Title: "Examples", Content: "Code examples.", Level: 2},
		{Title: "Usage", Content: "Usage examples.", Level: 2},
		{Title: "Getting Started", Content: "Getting started guide.", Level: 2},
	}

	// Extract examples section
	examplesSection := parser.ExtractExamplesSection(sections)

	// Check if examples sections were extracted and combined
	expectedTitles := []string{"Examples", "Usage", "Getting Started"}
	for _, title := range expectedTitles {
		if !strings.Contains(examplesSection, title) {
			t.Errorf("Expected examples section to contain '%s', got '%s'", title, examplesSection)
		}
	}

	// Test with no examples sections
	noExamplesSections := []MarkdownSection{
		{Title: "Introduction", Content: "This is an introduction.", Level: 1},
		{Title: "API Reference", Content: "API documentation.", Level: 2},
	}
	noExamplesSection := parser.ExtractExamplesSection(noExamplesSections)
	if noExamplesSection != "" {
		t.Errorf("Expected empty string for no examples sections, got '%s'", noExamplesSection)
	}

	// Test with empty sections
	emptyExamplesSection := parser.ExtractExamplesSection([]MarkdownSection{})
	if emptyExamplesSection != "" {
		t.Errorf("Expected empty string for empty sections, got '%s'", emptyExamplesSection)
	}
}

func TestMarkdownParser_SummarizeMarkdown(t *testing.T) {
	parser := NewMarkdownParser()

	// Test with Markdown containing multiple paragraphs
	markdown := `# Heading

This is the first paragraph that should be used as a summary.

This is the second paragraph that should be ignored.

## Subheading

More content that should be ignored.`

	// Test with default max length
	summary := parser.SummarizeMarkdown(markdown, 0)
	if !strings.Contains(summary, "This is the first paragraph") {
		t.Errorf("Expected summary to contain first paragraph, got '%s'", summary)
	}
	if strings.Contains(summary, "second paragraph") {
		t.Errorf("Expected summary to not contain second paragraph, got '%s'", summary)
	}

	// Test with custom max length
	shortSummary := parser.SummarizeMarkdown(markdown, 20)
	if len(shortSummary) > 23 { // 20 chars + "..."
		t.Errorf("Expected summary length to be at most 23 characters, got %d: '%s'", len(shortSummary), shortSummary)
	}
	if !strings.HasSuffix(shortSummary, "...") {
		t.Errorf("Expected truncated summary to end with '...', got '%s'", shortSummary)
	}

	// Test with Markdown that starts with a heading
	headingMarkdown := `# Package Name

This is the package description.`

	headingSummary := parser.SummarizeMarkdown(headingMarkdown, 0)
	if !strings.Contains(headingSummary, "This is the package description") {
		t.Errorf("Expected summary to contain description, got '%s'", headingSummary)
	}
	if strings.Contains(headingSummary, "# Package Name") {
		t.Errorf("Expected summary to not contain heading, got '%s'", headingSummary)
	}

	// Test with Markdown containing formatting
	formattedMarkdown := `# Heading

This is a paragraph with [links](https://example.com), *italic* and **bold** text, and ` + "`code`" + `.`

	formattedSummary := parser.SummarizeMarkdown(formattedMarkdown, 0)
	if strings.Contains(formattedSummary, "[links]") || strings.Contains(formattedSummary, "](") {
		t.Errorf("Expected summary to remove link formatting, got '%s'", formattedSummary)
	}
	if strings.Contains(formattedSummary, "*italic*") || strings.Contains(formattedSummary, "**bold**") {
		t.Errorf("Expected summary to remove emphasis formatting, got '%s'", formattedSummary)
	}
	if strings.Contains(formattedSummary, "`code`") {
		t.Errorf("Expected summary to remove code formatting, got '%s'", formattedSummary)
	}

	// Test with empty Markdown
	emptySummary := parser.SummarizeMarkdown("", 0)
	if emptySummary != "" {
		t.Errorf("Expected empty summary for empty Markdown, got '%s'", emptySummary)
	}
}

// Helper function to check if a node is a heading
func TestIsHeading(t *testing.T) {
	parser := NewMarkdownParser()
	markdown := "# Heading"
	root, _ := parser.ParseMarkdown(markdown)

	var headingNode ast.Node
	ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering && n.Kind() == ast.KindHeading {
			headingNode = n
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})

	if headingNode == nil {
		t.Fatal("Failed to find heading node for testing")
	}

	// Test with a heading node
	if !isHeading(headingNode) {
		t.Error("Expected isHeading to return true for a heading node")
	}

	// Test with a non-heading node (the document root)
	if isHeading(root) {
		t.Error("Expected isHeading to return false for a non-heading node")
	}
}
