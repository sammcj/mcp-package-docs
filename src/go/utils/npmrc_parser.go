package utils

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// NPMRegistryConfig represents the configuration for an NPM registry
type NPMRegistryConfig struct {
	Registry string
	Token    string
	Email    string
}

// NPMRCParser provides utilities for parsing .npmrc files
type NPMRCParser struct {
	fsUtils *FileSystemUtils
}

// NewNPMRCParser creates a new .npmrc parser
func NewNPMRCParser(fsUtils *FileSystemUtils) *NPMRCParser {
	return &NPMRCParser{
		fsUtils: fsUtils,
	}
}

// GetRegistryConfigForPackage returns the registry configuration for a package
func (p *NPMRCParser) GetRegistryConfigForPackage(packageName string, projectPath string) (NPMRegistryConfig, error) {
	config := NPMRegistryConfig{
		Registry: "https://registry.npmjs.org/", // Default NPM registry
	}

	// Try to find .npmrc in the project directory first
	npmrcPaths := []string{}
	if projectPath != "" {
		npmrcPaths = append(npmrcPaths, filepath.Join(projectPath, ".npmrc"))
	}

	// Then try the user's home directory
	homeDir, err := os.UserHomeDir()
	if err == nil {
		npmrcPaths = append(npmrcPaths, filepath.Join(homeDir, ".npmrc"))
	}

	// Parse each .npmrc file
	for _, npmrcPath := range npmrcPaths {
		if !p.fsUtils.FileExists(npmrcPath) {
			continue
		}

		// Parse the .npmrc file
		registryConfig, err := p.parseNPMRC(npmrcPath, packageName)
		if err != nil {
			continue
		}

		// Update the config with any found values
		if registryConfig.Registry != "" {
			config.Registry = registryConfig.Registry
		}
		if registryConfig.Token != "" {
			config.Token = registryConfig.Token
		}
		if registryConfig.Email != "" {
			config.Email = registryConfig.Email
		}
	}

	return config, nil
}

// parseNPMRC parses an .npmrc file and returns the registry configuration
func (p *NPMRCParser) parseNPMRC(path string, packageName string) (NPMRegistryConfig, error) {
	config := NPMRegistryConfig{}

	file, err := os.Open(path)
	if err != nil {
		return config, err
	}
	defer file.Close()

	// Check if the package has a scope (e.g., @mycompany/package)
	scope := ""
	if strings.HasPrefix(packageName, "@") {
		parts := strings.Split(packageName, "/")
		if len(parts) > 0 {
			scope = parts[0]
		}
	}

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		line = strings.TrimSpace(line)

		// Skip comments and empty lines
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		// Parse key-value pairs
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.TrimSpace(parts[0])
		value := strings.TrimSpace(parts[1])

		// Handle registry configuration
		if key == "registry" {
			config.Registry = value
		} else if scope != "" && key == scope+":registry" {
			// Scoped registry takes precedence
			config.Registry = value
		}

		// Handle authentication tokens
		if strings.HasPrefix(key, "//") && strings.Contains(key, "/:_authToken") {
			// Extract the registry URL from the key
			registryURL := "https:" + strings.Split(key, "/:_authToken")[0]

			// If this token is for our registry, use it
			if config.Registry == registryURL || strings.Contains(config.Registry, registryURL) {
				config.Token = value
			}
		}

		// Handle email
		if key == "email" {
			config.Email = value
		}
	}

	if err := scanner.Err(); err != nil {
		return config, err
	}

	return config, nil
}
