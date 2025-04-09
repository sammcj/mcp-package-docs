package utils

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// FileSystemUtils provides utilities for file system operations
type FileSystemUtils struct {
	homeDir string
}

// NewFileSystemUtils creates a new file system utilities instance
func NewFileSystemUtils() (*FileSystemUtils, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	return &FileSystemUtils{
		homeDir: homeDir,
	}, nil
}

// FileExists checks if a file exists and is not a directory
func (fs *FileSystemUtils) FileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// DirExists checks if a directory exists
func (fs *FileSystemUtils) DirExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// ExpandPath expands a path with ~ to the user's home directory
func (fs *FileSystemUtils) ExpandPath(path string) string {
	if path == "~" {
		return fs.homeDir
	} else if strings.HasPrefix(path, "~/") {
		return filepath.Join(fs.homeDir, path[2:])
	}
	return path
}

// FindFileInParentDirs looks for a file in the current directory and parent directories
func (fs *FileSystemUtils) FindFileInParentDirs(startDir, filename string) (string, error) {
	dir := startDir
	for {
		path := filepath.Join(dir, filename)
		if fs.FileExists(path) {
			return path, nil
		}

		// Move up one directory
		parentDir := filepath.Dir(dir)
		if parentDir == dir {
			// We've reached the root directory
			break
		}
		dir = parentDir
	}

	return "", errors.New("file not found in any parent directory")
}

// ReadFileContent reads the content of a file as a string
func (fs *FileSystemUtils) ReadFileContent(path string) (string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

// WriteFileContent writes content to a file, creating directories if needed
func (fs *FileSystemUtils) WriteFileContent(path string, content string) error {
	// Create directory if it doesn't exist
	dir := filepath.Dir(path)
	if !fs.DirExists(dir) {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}

	return os.WriteFile(path, []byte(content), 0644)
}

// ListFiles lists files in a directory with optional pattern matching
func (fs *FileSystemUtils) ListFiles(dir string, pattern string) ([]string, error) {
	if !fs.DirExists(dir) {
		return nil, errors.New("directory does not exist")
	}

	var files []string
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			if pattern == "" || filepath.Ext(path) == pattern || strings.Contains(filepath.Base(path), pattern) {
				files = append(files, path)
			}
		}
		return nil
	})

	return files, err
}
