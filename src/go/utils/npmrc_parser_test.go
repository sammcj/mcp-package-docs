package utils

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewNPMRCParser(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	parser := NewNPMRCParser(fsUtils)
	if parser == nil {
		t.Fatal("Expected non-nil NPMRCParser")
	}
	if parser.fsUtils == nil {
		t.Fatal("Expected non-nil fsUtils")
	}
}

func TestNPMRCParser_GetRegistryConfigForPackage(t *testing.T) {
	// Create a temporary directory for the test
	tempDir, err := os.MkdirTemp("", "npmrc_parser_test")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a test .npmrc file
	npmrcContent := `
# NPM Registry configuration
registry=https://custom-registry.example.com/
@mycompany:registry=https://private-registry.mycompany.com/
//private-registry.mycompany.com/:_authToken=test-token
email=test@example.com
`
	npmrcPath := filepath.Join(tempDir, ".npmrc")
	if err := os.WriteFile(npmrcPath, []byte(npmrcContent), 0644); err != nil {
		t.Fatalf("Failed to create test .npmrc file: %v", err)
	}

	// Create the parser
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	parser := NewNPMRCParser(fsUtils)

	// Test with a regular package
	config, err := parser.GetRegistryConfigForPackage("lodash", tempDir)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if config.Registry != "https://custom-registry.example.com/" {
		t.Errorf("Expected registry 'https://custom-registry.example.com/', got '%s'", config.Registry)
	}
	if config.Email != "test@example.com" {
		t.Errorf("Expected email 'test@example.com', got '%s'", config.Email)
	}
	if config.Token != "" {
		t.Errorf("Expected empty token, got '%s'", config.Token)
	}

	// Test with a scoped package
	config, err = parser.GetRegistryConfigForPackage("@mycompany/package", tempDir)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if config.Registry != "https://private-registry.mycompany.com/" {
		t.Errorf("Expected registry 'https://private-registry.mycompany.com/', got '%s'", config.Registry)
	}
	if config.Email != "test@example.com" {
		t.Errorf("Expected email 'test@example.com', got '%s'", config.Email)
	}
	if config.Token != "test-token" {
		t.Errorf("Expected token 'test-token', got '%s'", config.Token)
	}

	// Test with non-existent project path
	config, err = parser.GetRegistryConfigForPackage("lodash", tempDir+"_nonexistent")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	// Should fall back to default registry
	if config.Registry != "https://registry.npmjs.org/" {
		t.Errorf("Expected default registry 'https://registry.npmjs.org/', got '%s'", config.Registry)
	}
}

func TestNPMRCParser_parseNPMRC(t *testing.T) {
	// Create a temporary directory for the test
	tempDir, err := os.MkdirTemp("", "npmrc_parser_test")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a test .npmrc file with various configurations
	npmrcContent := `
# Comment line
registry=https://registry.example.com/
@scope:registry=https://scoped-registry.example.com/
//scoped-registry.example.com/:_authToken=scoped-token
//registry.example.com/:_authToken=registry-token
email=user@example.com

# Invalid lines
invalid-line
key-without-value=
`
	npmrcPath := filepath.Join(tempDir, ".npmrc")
	if err := os.WriteFile(npmrcPath, []byte(npmrcContent), 0644); err != nil {
		t.Fatalf("Failed to create test .npmrc file: %v", err)
	}

	// Create the parser
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	parser := NewNPMRCParser(fsUtils)

	// Test parsing for a regular package
	config, err := parser.parseNPMRC(npmrcPath, "package")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if config.Registry != "https://registry.example.com/" {
		t.Errorf("Expected registry 'https://registry.example.com/', got '%s'", config.Registry)
	}
	if config.Token != "registry-token" {
		t.Errorf("Expected token 'registry-token', got '%s'", config.Token)
	}
	if config.Email != "user@example.com" {
		t.Errorf("Expected email 'user@example.com', got '%s'", config.Email)
	}

	// Test parsing for a scoped package
	config, err = parser.parseNPMRC(npmrcPath, "@scope/package")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if config.Registry != "https://scoped-registry.example.com/" {
		t.Errorf("Expected registry 'https://scoped-registry.example.com/', got '%s'", config.Registry)
	}
	if config.Token != "scoped-token" {
		t.Errorf("Expected token 'scoped-token', got '%s'", config.Token)
	}
	if config.Email != "user@example.com" {
		t.Errorf("Expected email 'user@example.com', got '%s'", config.Email)
	}

	// Test parsing with non-existent file
	config, err = parser.parseNPMRC(npmrcPath+"_nonexistent", "package")
	if err == nil {
		t.Error("Expected error for non-existent file, got nil")
	}
}
