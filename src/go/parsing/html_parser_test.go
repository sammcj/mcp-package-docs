package parsing

import (
	"strings"
	"testing"

	"github.com/PuerkitoBio/goquery"
)

func TestNewHTMLParser(t *testing.T) {
	parser := NewHTMLParser()
	if parser == nil {
		t.Fatal("Expected non-nil HTMLParser")
	}
	if parser.converter == nil {
		t.Fatal("Expected non-nil HTML to Markdown converter")
	}
}

func TestHTMLParser_ParseHTML(t *testing.T) {
	parser := NewHTMLParser()

	// Test with valid HTML
	html := `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <h1>Hello World</h1>
    <p>This is a test paragraph.</p>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if doc == nil {
		t.Fatal("Expected non-nil document")
	}

	// Check if the document contains the expected elements
	title := doc.Find("title").Text()
	if title != "Test Page" {
		t.Errorf("Expected title 'Test Page', got '%s'", title)
	}

	h1 := doc.Find("h1").Text()
	if h1 != "Hello World" {
		t.Errorf("Expected h1 'Hello World', got '%s'", h1)
	}

	// Test with empty HTML
	doc, err = parser.ParseHTML("")
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if doc == nil {
		t.Fatal("Expected non-nil document for empty HTML")
	}

	// Test with malformed HTML (should still parse)
	malformedHTML := `<div><p>Unclosed paragraph tag<div>Nested div</div>`
	doc, err = parser.ParseHTML(malformedHTML)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if doc == nil {
		t.Fatal("Expected non-nil document for malformed HTML")
	}
}

func TestHTMLParser_HTMLToMarkdown(t *testing.T) {
	parser := NewHTMLParser()

	// Test with simple HTML
	html := `<h1>Heading</h1>
<p>This is a <strong>bold</strong> and <em>italic</em> text.</p>
<ul>
    <li>Item 1</li>
    <li>Item 2</li>
</ul>`

	markdown, err := parser.HTMLToMarkdown(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Check if the markdown contains expected patterns
	expectedPatterns := []string{
		"# Heading",
		"This is a **bold** and _italic_ text.",
		"- Item 1",
		"- Item 2",
	}

	for _, pattern := range expectedPatterns {
		if !strings.Contains(markdown, pattern) {
			t.Errorf("Expected markdown to contain '%s', got '%s'", pattern, markdown)
		}
	}

	// Test with empty HTML
	markdown, err = parser.HTMLToMarkdown("")
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if markdown != "" {
		t.Errorf("Expected empty markdown for empty HTML, got '%s'", markdown)
	}

	// Test with complex HTML
	complexHTML := `<div class="content">
<h1>Article Title</h1>
<p>Introduction paragraph with <a href="https://example.com">link</a>.</p>
<pre><code>function example() {
    return "code block";
}</code></pre>
<blockquote>
    <p>This is a quote</p>
</blockquote>
</div>`

	markdown, err = parser.HTMLToMarkdown(complexHTML)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Check if the markdown contains expected patterns
	complexPatterns := []string{
		"# Article Title",
		"Introduction paragraph with [link](https://example.com).",
		"```",
		"function example() {",
		"return \"code block\";",
		"```",
		"> This is a quote",
	}

	for _, pattern := range complexPatterns {
		if !strings.Contains(markdown, pattern) {
			t.Errorf("Expected markdown to contain '%s', got '%s'", pattern, markdown)
		}
	}
}

func TestHTMLParser_ExtractMainContent(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with various content containers
	html := `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <header>
        <nav>Navigation menu</nav>
    </header>
    <main>
        <h1>Main Content</h1>
        <p>This is the main content of the page.</p>
    </main>
    <aside>
        <div class="sidebar">Sidebar content</div>
    </aside>
    <footer>
        <p>Footer content</p>
    </footer>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract main content
	mainContent := parser.ExtractMainContent(doc)

	// Check if the main content contains expected content
	expectedContent := "Main Content"
	if !strings.Contains(mainContent, expectedContent) {
		t.Errorf("Expected main content to contain '%s', got '%s'", expectedContent, mainContent)
	}

	// Check if the main content does not contain navigation or footer
	unexpectedContent := []string{"Navigation menu", "Footer content"}
	for _, content := range unexpectedContent {
		if strings.Contains(mainContent, content) {
			t.Errorf("Expected main content to not contain '%s', but it does", content)
		}
	}

	// Test with HTML that has no main tag but has article
	htmlWithArticle := `<!DOCTYPE html>
<html>
<head>
    <title>Article Page</title>
</head>
<body>
    <header>Header</header>
    <article>
        <h1>Article Title</h1>
        <p>Article content.</p>
    </article>
    <footer>Footer</footer>
</body>
</html>`

	docWithArticle, _ := parser.ParseHTML(htmlWithArticle)
	articleContent := parser.ExtractMainContent(docWithArticle)

	if !strings.Contains(articleContent, "Article Title") {
		t.Errorf("Expected article content to contain 'Article Title', got '%s'", articleContent)
	}

	// Test with HTML that has no main content containers
	htmlWithoutMain := `<!DOCTYPE html>
<html>
<head>
    <title>No Main</title>
</head>
<body>
    <div>
        <h1>Page Title</h1>
        <p>Page content.</p>
    </div>
</body>
</html>`

	docWithoutMain, _ := parser.ParseHTML(htmlWithoutMain)
	bodyContent := parser.ExtractMainContent(docWithoutMain)

	if !strings.Contains(bodyContent, "Page Title") {
		t.Errorf("Expected body content to contain 'Page Title', got '%s'", bodyContent)
	}
}

func TestHTMLParser_ExtractTitle(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with a title
	html := `<!DOCTYPE html>
<html>
<head>
    <title>Test Page Title</title>
</head>
<body>
    <h1>Heading</h1>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract title
	title := parser.ExtractTitle(doc)
	if title != "Test Page Title" {
		t.Errorf("Expected title 'Test Page Title', got '%s'", title)
	}

	// Test with HTML that has no title
	htmlWithoutTitle := `<!DOCTYPE html>
<html>
<body>
    <h1>Heading</h1>
</body>
</html>`

	docWithoutTitle, _ := parser.ParseHTML(htmlWithoutTitle)
	emptyTitle := parser.ExtractTitle(docWithoutTitle)
	if emptyTitle != "" {
		t.Errorf("Expected empty title for HTML without title, got '%s'", emptyTitle)
	}
}

func TestHTMLParser_ExtractMetaDescription(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with a meta description
	html := `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
    <meta name="description" content="This is a test page description">
</head>
<body>
    <h1>Heading</h1>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract meta description
	description := parser.ExtractMetaDescription(doc)
	if description != "This is a test page description" {
		t.Errorf("Expected description 'This is a test page description', got '%s'", description)
	}

	// Test with HTML that has no meta description
	htmlWithoutDescription := `<!DOCTYPE html>
<html>
<head>
    <title>Test Page</title>
</head>
<body>
    <h1>Heading</h1>
</body>
</html>`

	docWithoutDescription, _ := parser.ParseHTML(htmlWithoutDescription)
	emptyDescription := parser.ExtractMetaDescription(docWithoutDescription)
	if emptyDescription != "" {
		t.Errorf("Expected empty description for HTML without meta description, got '%s'", emptyDescription)
	}
}

func TestHTMLParser_ExtractCodeBlocks(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with code blocks
	html := `<!DOCTYPE html>
<html>
<body>
    <pre><code>function example1() {
    return "code block 1";
}</code></pre>
    <p>Some text</p>
    <code>inline code</code>
    <pre><code>function example2() {
    return "code block 2";
}</code></pre>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract code blocks
	codeBlocks := parser.ExtractCodeBlocks(doc)
	if len(codeBlocks) != 3 {
		t.Errorf("Expected 3 code blocks, got %d", len(codeBlocks))
	}

	// Check content of code blocks
	expectedCode := []string{
		"function example1() {\n    return \"code block 1\";\n}",
		"inline code",
		"function example2() {\n    return \"code block 2\";\n}",
	}

	for i, expected := range expectedCode {
		if i >= len(codeBlocks) {
			t.Errorf("Missing code block at index %d", i)
			continue
		}
		if codeBlocks[i] != expected {
			t.Errorf("Expected code block '%s', got '%s'", expected, codeBlocks[i])
		}
	}

	// Test with HTML that has no code blocks
	htmlWithoutCode := `<!DOCTYPE html>
<html>
<body>
    <p>No code blocks here</p>
</body>
</html>`

	docWithoutCode, _ := parser.ParseHTML(htmlWithoutCode)
	emptyCodeBlocks := parser.ExtractCodeBlocks(docWithoutCode)
	if len(emptyCodeBlocks) != 0 {
		t.Errorf("Expected 0 code blocks for HTML without code, got %d", len(emptyCodeBlocks))
	}
}

func TestHTMLParser_ExtractLinks(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with links
	html := `<!DOCTYPE html>
<html>
<body>
    <a href="https://example.com">Example Link</a>
    <p>Some text with <a href="https://test.com">another link</a>.</p>
    <a href="#section">Internal link</a>
    <a href="">Empty link</a>
    <a href="https://empty-text.com"></a>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract links
	links := parser.ExtractLinks(doc)

	// Should have 3 links (excluding the internal link with # and empty link)
	if len(links) != 3 {
		t.Errorf("Expected 3 links, got %d", len(links))
	}

	// Check specific links
	expectedLinks := map[string]string{
		"Example Link": "https://example.com",
		"another link": "https://test.com",
		"https://empty-text.com": "https://empty-text.com", // Link with empty text uses href as text
	}

	for text, href := range expectedLinks {
		if links[text] != href {
			t.Errorf("Expected link '%s' to have href '%s', got '%s'", text, href, links[text])
		}
	}

	// Test with HTML that has no links
	htmlWithoutLinks := `<!DOCTYPE html>
<html>
<body>
    <p>No links here</p>
</body>
</html>`

	docWithoutLinks, _ := parser.ParseHTML(htmlWithoutLinks)
	emptyLinks := parser.ExtractLinks(docWithoutLinks)
	if len(emptyLinks) != 0 {
		t.Errorf("Expected 0 links for HTML without links, got %d", len(emptyLinks))
	}
}

func TestHTMLParser_ExtractHeadings(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with headings and content
	html := `<!DOCTYPE html>
<html>
<body>
    <h1>First Heading</h1>
    <p>Content under first heading.</p>
    <h2>Second Heading</h2>
    <p>Content under second heading.</p>
    <ul>
        <li>List item</li>
    </ul>
    <h3>Third Heading</h3>
    <p>Content under third heading.</p>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract headings
	headings := parser.ExtractHeadings(doc)

	// Should have 3 headings
	if len(headings) != 3 {
		t.Errorf("Expected 3 headings, got %d", len(headings))
	}

	// Check specific headings and their content
	expectedHeadings := map[string]string{
		"First Heading":  "Content under first heading.",
		"Second Heading": "Content under second heading.\n\n- List item",
		"Third Heading":  "Content under third heading.",
	}

	for heading, expectedContent := range expectedHeadings {
		content, exists := headings[heading]
		if !exists {
			t.Errorf("Expected heading '%s' not found", heading)
			continue
		}

		// Normalize content for comparison (remove extra whitespace)
		normalizedContent := strings.TrimSpace(content)
		normalizedExpected := strings.TrimSpace(expectedContent)

		if !strings.Contains(normalizedContent, normalizedExpected) {
			t.Errorf("Expected heading '%s' to have content containing '%s', got '%s'",
				heading, normalizedExpected, normalizedContent)
		}
	}

	// Test with HTML that has no headings
	htmlWithoutHeadings := `<!DOCTYPE html>
<html>
<body>
    <p>No headings here</p>
</body>
</html>`

	docWithoutHeadings, _ := parser.ParseHTML(htmlWithoutHeadings)
	emptyHeadings := parser.ExtractHeadings(docWithoutHeadings)
	if len(emptyHeadings) != 0 {
		t.Errorf("Expected 0 headings for HTML without headings, got %d", len(emptyHeadings))
	}
}

func TestHTMLParser_ExtractAPIDocumentation(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with API documentation
	html := `<!DOCTYPE html>
<html>
<body>
    <div class="introduction">
        <h1>Package Introduction</h1>
        <p>This is an introduction.</p>
    </div>
    <div class="api">
        <h2>API Reference</h2>
        <h3>function1(param)</h3>
        <p>Description of function1</p>
        <h3>function2(param)</h3>
        <p>Description of function2</p>
    </div>
    <div class="examples">
        <h2>Examples</h2>
        <p>Example content</p>
    </div>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract API documentation
	apiDocs := parser.ExtractAPIDocumentation(doc)

	// Check if API documentation contains expected content
	expectedContent := []string{
		"API Reference",
		"function1(param)",
		"function2(param)",
	}

	for _, expected := range expectedContent {
		if !strings.Contains(apiDocs, expected) {
			t.Errorf("Expected API docs to contain '%s', got '%s'", expected, apiDocs)
		}
	}

	// Test with HTML that has no API documentation
	htmlWithoutAPI := `<!DOCTYPE html>
<html>
<body>
    <div class="introduction">
        <h1>Package Introduction</h1>
        <p>This is an introduction.</p>
    </div>
    <div class="examples">
        <h2>Examples</h2>
        <p>Example content</p>
    </div>
</body>
</html>`

	docWithoutAPI, _ := parser.ParseHTML(htmlWithoutAPI)
	emptyAPIDocs := parser.ExtractAPIDocumentation(docWithoutAPI)
	if emptyAPIDocs != "" {
		t.Errorf("Expected empty API docs for HTML without API section, got '%s'", emptyAPIDocs)
	}
}

func TestHTMLParser_ExtractExamples(t *testing.T) {
	parser := NewHTMLParser()

	// Create a test HTML document with examples
	html := `<!DOCTYPE html>
<html>
<body>
    <div class="introduction">
        <h1>Package Introduction</h1>
        <p>This is an introduction.</p>
    </div>
    <div class="example">
        <h2>Example 1</h2>
        <pre><code>function example1() {
    return "example 1";
}</code></pre>
    </div>
    <div class="sample">
        <h2>Example 2</h2>
        <pre><code>function example2() {
    return "example 2";
}</code></pre>
    </div>
</body>
</html>`

	doc, err := parser.ParseHTML(html)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Extract examples
	examples := parser.ExtractExamples(doc)

	// Should have 2 examples
	if len(examples) != 2 {
		t.Errorf("Expected 2 examples, got %d", len(examples))
	}

	// Check if examples contain expected content
	expectedContent := []string{
		"Example 1",
		"function example1",
		"Example 2",
		"function example2",
	}

	for _, expected := range expectedContent {
		found := false
		for _, example := range examples {
			if strings.Contains(example, expected) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("Expected examples to contain '%s', but not found", expected)
		}
	}

	// Test with HTML that has no examples
	htmlWithoutExamples := `<!DOCTYPE html>
<html>
<body>
    <div class="introduction">
        <h1>Package Introduction</h1>
        <p>This is an introduction.</p>
    </div>
    <div class="api">
        <h2>API Reference</h2>
        <p>API content</p>
    </div>
</body>
</html>`

	docWithoutExamples, _ := parser.ParseHTML(htmlWithoutExamples)
	emptyExamples := parser.ExtractExamples(docWithoutExamples)
	if len(emptyExamples) != 0 {
		t.Errorf("Expected 0 examples for HTML without examples, got %d", len(emptyExamples))
	}
}

// Helper function to create a goquery document from HTML string
func createDocumentFromHTML(t *testing.T, html string) *goquery.Document {
	doc, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		t.Fatalf("Failed to create document: %v", err)
	}
	return doc
}
