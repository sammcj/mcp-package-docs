package parsing

import (
	"bytes"
	"strings"

	md "github.com/JohannesKaufmann/html-to-markdown"
	"github.com/JohannesKaufmann/html-to-markdown/plugin"
	"github.com/PuerkitoBio/goquery"
)

// HTMLParser provides utilities for parsing HTML content
type HTMLParser struct {
	converter *md.Converter
}

// NewHTMLParser creates a new HTML parser
func NewHTMLParser() *HTMLParser {
	// Create a new HTML to Markdown converter
	converter := md.NewConverter("", true, nil)

	// Add GitHub flavoured markdown plugins
	converter.Use(plugin.GitHubFlavored())

	return &HTMLParser{
		converter: converter,
	}
}

// ParseHTML parses HTML content and returns a goquery Document
func (p *HTMLParser) ParseHTML(htmlContent string) (*goquery.Document, error) {
	return goquery.NewDocumentFromReader(strings.NewReader(htmlContent))
}

// HTMLToMarkdown converts HTML content to Markdown
func (p *HTMLParser) HTMLToMarkdown(htmlContent string) (string, error) {
	return p.converter.ConvertString(htmlContent)
}

// ExtractMainContent attempts to extract the main content from an HTML document
// by focusing on common content containers and removing navigation, headers, footers, etc.
func (p *HTMLParser) ExtractMainContent(doc *goquery.Document) string {
	// Try to find the main content container using common selectors
	mainSelectors := []string{
		"main", "article", "#content", ".content", "#main", ".main",
		"[role='main']", ".documentation", "#documentation",
	}

	var mainContent string
	for _, selector := range mainSelectors {
		if selection := doc.Find(selector).First(); selection.Length() > 0 {
			// Clone the selection to avoid modifying the original document
			clone := selection.Clone()

			// Remove common non-content elements
			clone.Find("nav, header, footer, .navigation, .sidebar, .menu, .ads, .comments").Remove()

			html, err := clone.Html()
			if err == nil && html != "" {
				mainContent = html
				break
			}
		}
	}

	// If no main content container was found, use the body
	if mainContent == "" {
			// Clone the body to avoid modifying the original document
			body := doc.Find("body").First()
			if body.Length() > 0 {
				clone := body.Clone()

				// Remove common non-content elements
				clone.Find("nav, header, footer, .navigation, .sidebar, .menu, .ads, .comments").Remove()

				html, err := clone.Html()
			if err == nil {
				mainContent = html
			}
		}
	}

	// Convert the extracted HTML to Markdown
	markdown, err := p.HTMLToMarkdown(mainContent)
	if err != nil {
		return ""
	}

	return markdown
}

// ExtractTitle extracts the title from an HTML document
func (p *HTMLParser) ExtractTitle(doc *goquery.Document) string {
	return strings.TrimSpace(doc.Find("title").First().Text())
}

// ExtractMetaDescription extracts the meta description from an HTML document
func (p *HTMLParser) ExtractMetaDescription(doc *goquery.Document) string {
	description, _ := doc.Find("meta[name='description']").Attr("content")
	return strings.TrimSpace(description)
}

// ExtractCodeBlocks extracts code blocks from HTML content
func (p *HTMLParser) ExtractCodeBlocks(doc *goquery.Document) []string {
	var codeBlocks []string

	// Extract code from pre and code elements
	doc.Find("pre, code").Each(func(i int, s *goquery.Selection) {
		code := strings.TrimSpace(s.Text())
		if code != "" {
			codeBlocks = append(codeBlocks, code)
		}
	})

	return codeBlocks
}

// ExtractLinks extracts links from HTML content
func (p *HTMLParser) ExtractLinks(doc *goquery.Document) map[string]string {
	links := make(map[string]string)

	doc.Find("a[href]").Each(func(i int, s *goquery.Selection) {
		href, exists := s.Attr("href")
		if exists && href != "" && !strings.HasPrefix(href, "#") {
			text := strings.TrimSpace(s.Text())
			if text == "" {
				text = href
			}
			links[text] = href
		}
	})

	return links
}

// ExtractHeadings extracts headings and their content from HTML
func (p *HTMLParser) ExtractHeadings(doc *goquery.Document) map[string]string {
	headings := make(map[string]string)

	doc.Find("h1, h2, h3, h4, h5, h6").Each(func(i int, s *goquery.Selection) {
		headingText := strings.TrimSpace(s.Text())
		if headingText != "" {
			// Get the content until the next heading
			var contentBuffer bytes.Buffer
			next := s.NextUntil("h1, h2, h3, h4, h5, h6")
			next.Each(func(j int, el *goquery.Selection) {
				html, err := el.Html()
				if err == nil {
					contentBuffer.WriteString(html)
				}
			})

			content, err := p.HTMLToMarkdown(contentBuffer.String())
			if err == nil {
				headings[headingText] = strings.TrimSpace(content)
			}
		}
	})

	return headings
}

// ExtractAPIDocumentation attempts to extract API documentation sections
func (p *HTMLParser) ExtractAPIDocumentation(doc *goquery.Document) string {
	// Look for common API documentation sections
	apiSelectors := []string{
		".api", "#api", "[id*='api']", "[class*='api']",
		".reference", "#reference", "[id*='reference']",
		".method", ".function", ".class", ".interface",
	}

	for _, selector := range apiSelectors {
		if selection := doc.Find(selector); selection.Length() > 0 {
			html, err := selection.Html()
			if err == nil && html != "" {
				markdown, err := p.HTMLToMarkdown(html)
				if err == nil {
					return markdown
				}
			}
		}
	}

	return ""
}

// ExtractExamples attempts to extract code examples
func (p *HTMLParser) ExtractExamples(doc *goquery.Document) []string {
	var examples []string

	// Look for common example sections
	exampleSelectors := []string{
		".example", "#example", "[id*='example']", "[class*='example']",
		".sample", "#sample", "[id*='sample']", "[class*='sample']",
		".demo", "#demo", "[id*='demo']", "[class*='demo']",
	}

	for _, selector := range exampleSelectors {
		doc.Find(selector).Each(func(i int, s *goquery.Selection) {
			html, err := s.Html()
			if err == nil && html != "" {
				markdown, err := p.HTMLToMarkdown(html)
				if err == nil && markdown != "" {
					examples = append(examples, markdown)
				}
			}
		})
	}

	return examples
}
