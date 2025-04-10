package parsing

import (
	"testing"
)

func TestSearch(t *testing.T) {
	// Create test content
	contents := map[string]string{
		"Document 1": "This is a test document with some test content.",
		"Document 2": "Another document with different content.",
		"Document 3": "This document also mentions test but in a different way.",
	}

	// Test exact search
	results := Search("test", contents, SearchOptions{
		Query:       "test",
		FuzzySearch: false,
		MaxResults:  10,
	})

	if len(results) != 2 {
		t.Errorf("Expected 2 results for exact search, got %d", len(results))
	}

	// Check that results are sorted by score (higher first)
	if len(results) >= 2 && results[0].Score < results[1].Score {
		t.Errorf("Expected results to be sorted by score (higher first)")
	}

	// Test fuzzy search
	fuzzyResults := Search("tst", contents, SearchOptions{
		Query:       "tst",
		FuzzySearch: true,
		MaxResults:  10,
	})

	if len(fuzzyResults) == 0 {
		t.Errorf("Expected at least one result for fuzzy search, got none")
	}

	// Test max results
	limitedResults := Search("test", contents, SearchOptions{
		Query:       "test",
		FuzzySearch: false,
		MaxResults:  1,
	})

	if len(limitedResults) != 1 {
		t.Errorf("Expected 1 result when MaxResults=1, got %d", len(limitedResults))
	}

	// Test with empty query
	emptyResults := Search("", contents, SearchOptions{
		Query:       "",
		FuzzySearch: false,
		MaxResults:  10,
	})

	if len(emptyResults) != 0 {
		t.Errorf("Expected 0 results for empty query, got %d", len(emptyResults))
	}

	// Test with no content
	noContentResults := Search("test", map[string]string{}, SearchOptions{
		Query:       "test",
		FuzzySearch: false,
		MaxResults:  10,
	})

	if len(noContentResults) != 0 {
		t.Errorf("Expected 0 results for empty content, got %d", len(noContentResults))
	}

	// Test with default max results
	defaultMaxResults := Search("test", contents, SearchOptions{
		Query:       "test",
		FuzzySearch: false,
	})

	if len(defaultMaxResults) != 2 {
		t.Errorf("Expected 2 results with default MaxResults, got %d", len(defaultMaxResults))
	}
}

func TestExtractContextAroundMatch(t *testing.T) {
	// Test with match in the middle
	content := "This is a long text with a test match in the middle of the content."
	context := ExtractContextAroundMatch(content, "test", 10)
	expected := "...with a test match..."
	if context != expected {
		t.Errorf("Expected context '%s', got '%s'", expected, context)
	}

	// Test with match at the beginning
	content = "Test is at the beginning of this text."
	context = ExtractContextAroundMatch(content, "Test", 10)
	expected = "Test is at..."
	if context != expected {
		t.Errorf("Expected context '%s', got '%s'", expected, context)
	}

	// Test with match at the end
	content = "This text has the match at the end: test"
	context = ExtractContextAroundMatch(content, "test", 10)
	expected = "...the end: test"
	if context != expected {
		t.Errorf("Expected context '%s', got '%s'", expected, context)
	}

	// Test with no match
	content = "This text does not contain the match."
	context = ExtractContextAroundMatch(content, "nonexistent", 10)
	expected = "This text..."
	if context != expected {
		t.Errorf("Expected context '%s', got '%s'", expected, context)
	}

	// Test with content shorter than context size
	content = "Short text."
	context = ExtractContextAroundMatch(content, "text", 20)
	expected = "Short text."
	if context != expected {
		t.Errorf("Expected context '%s', got '%s'", expected, context)
	}

	// Test with default context size
	content = "This is a very long text that should be truncated when using the default context size because it exceeds the default limit."
	context = ExtractContextAroundMatch(content, "truncated", 0)
	if len(context) <= 10 {
		t.Errorf("Expected context length > 10 with default context size, got %d", len(context))
	}
}

func TestSearchCodeBlocks(t *testing.T) {
	// Create test code blocks
	codeBlocks := []string{
		"function test() {\n  return 'test';\n}",
		"const example = 'This is an example';",
		"// Test comment\nfunction anotherTest() {\n  console.log('test');\n}",
	}

	// Test exact search
	results := SearchCodeBlocks("test", codeBlocks, false)
	if len(results) != 2 {
		t.Errorf("Expected 2 results for exact search, got %d", len(results))
	}

	// Test fuzzy search
	fuzzyResults := SearchCodeBlocks("tst", codeBlocks, true)
	if len(fuzzyResults) == 0 {
		t.Errorf("Expected at least one result for fuzzy search, got none")
	}

	// Test with empty code blocks
	emptyResults := SearchCodeBlocks("test", []string{}, false)
	if len(emptyResults) != 0 {
		t.Errorf("Expected 0 results for empty code blocks, got %d", len(emptyResults))
	}
}

func TestSearchFunctionSignatures(t *testing.T) {
	// Create test function signatures
	signatures := []string{
		"function test(param1: string, param2: number): boolean",
		"const example = (x: number) => string",
		"public void testMethod(String input)",
	}

	// Test exact search
	results := SearchFunctionSignatures("test", signatures, false)
	if len(results) != 2 {
		t.Errorf("Expected 2 results for exact search, got %d", len(results))
	}

	// Test fuzzy search
	fuzzyResults := SearchFunctionSignatures("strng", signatures, true)
	if len(fuzzyResults) == 0 {
		t.Errorf("Expected at least one result for fuzzy search, got none")
	}

	// Test with empty signatures
	emptyResults := SearchFunctionSignatures("test", []string{}, false)
	if len(emptyResults) != 0 {
		t.Errorf("Expected 0 results for empty signatures, got %d", len(emptyResults))
	}
}

func TestSearchMarkdownSections(t *testing.T) {
	// Create test markdown sections
	sections := []MarkdownSection{
		{
			Title:   "Introduction",
			Content: "This is an introduction to the test document.",
			Level:   1,
		},
		{
			Title:   "Examples",
			Content: "Here are some examples of the functionality.",
			Level:   2,
		},
		{
			Title:   "Test Cases",
			Content: "These are the test cases for the functionality.",
			Level:   2,
		},
	}

	// Test exact search
	results := SearchMarkdownSections("test", sections, false)
	if len(results) != 2 {
		t.Errorf("Expected 2 results for exact search, got %d", len(results))
	}

	// Test fuzzy search
	fuzzyResults := SearchMarkdownSections("introducion", sections, true)
	if len(fuzzyResults) == 0 {
		t.Errorf("Expected at least one result for fuzzy search, got none")
	}

	// Test with empty sections
	emptyResults := SearchMarkdownSections("test", []MarkdownSection{}, false)
	if len(emptyResults) != 0 {
		t.Errorf("Expected 0 results for empty sections, got %d", len(emptyResults))
	}
}
