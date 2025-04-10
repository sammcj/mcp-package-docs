package utils

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewFileSystemUtils(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if fsUtils == nil {
		t.Fatal("Expected non-nil FileSystemUtils")
	}
	if fsUtils.homeDir == "" {
		t.Error("Expected non-empty homeDir")
	}
}

func TestFileSystemUtils_FileExists(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary file
	tempFile, err := os.CreateTemp("", "fs_utils_test_file")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tempFile.Name())
	tempFile.Close()

	// Test existing file
	if !fsUtils.FileExists(tempFile.Name()) {
		t.Errorf("Expected file %s to exist", tempFile.Name())
	}

	// Test non-existent file
	if fsUtils.FileExists(tempFile.Name() + ".nonexistent") {
		t.Errorf("Expected file %s to not exist", tempFile.Name()+".nonexistent")
	}

	// Test directory (should return false for FileExists)
	tempDir, err := os.MkdirTemp("", "fs_utils_test_dir")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	if fsUtils.FileExists(tempDir) {
		t.Errorf("Expected directory %s to not be reported as a file", tempDir)
	}
}

func TestFileSystemUtils_DirExists(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary directory
	tempDir, err := os.MkdirTemp("", "fs_utils_test_dir")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Test existing directory
	if !fsUtils.DirExists(tempDir) {
		t.Errorf("Expected directory %s to exist", tempDir)
	}

	// Test non-existent directory
	if fsUtils.DirExists(tempDir + "_nonexistent") {
		t.Errorf("Expected directory %s to not exist", tempDir+"_nonexistent")
	}

	// Test file (should return false for DirExists)
	tempFile, err := os.CreateTemp("", "fs_utils_test_file")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tempFile.Name())
	tempFile.Close()

	if fsUtils.DirExists(tempFile.Name()) {
		t.Errorf("Expected file %s to not be reported as a directory", tempFile.Name())
	}
}

func TestFileSystemUtils_ExpandPath(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("Failed to get home directory: %v", err)
	}

	// Test expanding "~"
	expanded := fsUtils.ExpandPath("~")
	if expanded != homeDir {
		t.Errorf("Expected '~' to expand to '%s', got '%s'", homeDir, expanded)
	}

	// Test expanding "~/path"
	expanded = fsUtils.ExpandPath("~/Documents")
	expected := filepath.Join(homeDir, "Documents")
	if expanded != expected {
		t.Errorf("Expected '~/Documents' to expand to '%s', got '%s'", expected, expanded)
	}

	// Test non-tilde path
	path := "/usr/local/bin"
	expanded = fsUtils.ExpandPath(path)
	if expanded != path {
		t.Errorf("Expected '%s' to remain unchanged, got '%s'", path, expanded)
	}
}

func TestFileSystemUtils_FindFileInParentDirs(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "fs_utils_test_dir")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a file in the root directory
	rootFile := filepath.Join(tempDir, "root_file.txt")
	if err := os.WriteFile(rootFile, []byte("root file"), 0644); err != nil {
		t.Fatalf("Failed to create root file: %v", err)
	}

	// Create a subdirectory
	subDir := filepath.Join(tempDir, "subdir")
	if err := os.Mkdir(subDir, 0755); err != nil {
		t.Fatalf("Failed to create subdirectory: %v", err)
	}

	// Create a sub-subdirectory
	subSubDir := filepath.Join(subDir, "subsubdir")
	if err := os.Mkdir(subSubDir, 0755); err != nil {
		t.Fatalf("Failed to create sub-subdirectory: %v", err)
	}

	// Test finding file from subdirectory
	foundPath, err := fsUtils.FindFileInParentDirs(subDir, "root_file.txt")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if foundPath != rootFile {
		t.Errorf("Expected to find '%s', got '%s'", rootFile, foundPath)
	}

	// Test finding file from sub-subdirectory
	foundPath, err = fsUtils.FindFileInParentDirs(subSubDir, "root_file.txt")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if foundPath != rootFile {
		t.Errorf("Expected to find '%s', got '%s'", rootFile, foundPath)
	}

	// Test file not found
	_, err = fsUtils.FindFileInParentDirs(tempDir, "nonexistent_file.txt")
	if err == nil {
		t.Error("Expected error for non-existent file, got nil")
	}
}

func TestFileSystemUtils_ReadFileContent(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary file with content
	content := "test file content"
	tempFile, err := os.CreateTemp("", "fs_utils_test_file")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tempFile.Name())
	if _, err := tempFile.WriteString(content); err != nil {
		t.Fatalf("Failed to write to temp file: %v", err)
	}
	tempFile.Close()

	// Test reading file content
	readContent, err := fsUtils.ReadFileContent(tempFile.Name())
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if readContent != content {
		t.Errorf("Expected content '%s', got '%s'", content, readContent)
	}

	// Test reading non-existent file
	_, err = fsUtils.ReadFileContent(tempFile.Name() + ".nonexistent")
	if err == nil {
		t.Error("Expected error for non-existent file, got nil")
	}
}

func TestFileSystemUtils_WriteFileContent(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary directory
	tempDir, err := os.MkdirTemp("", "fs_utils_test_dir")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Test writing to a new file
	content := "test file content"
	filePath := filepath.Join(tempDir, "test_file.txt")
	err = fsUtils.WriteFileContent(filePath, content)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}

	// Verify the content was written correctly
	readContent, err := os.ReadFile(filePath)
	if err != nil {
		t.Errorf("Failed to read file: %v", err)
	}
	if string(readContent) != content {
		t.Errorf("Expected content '%s', got '%s'", content, string(readContent))
	}

	// Test writing to a file in a non-existent directory
	nestedFilePath := filepath.Join(tempDir, "nested", "dir", "test_file.txt")
	err = fsUtils.WriteFileContent(nestedFilePath, content)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}

	// Verify the content was written correctly
	readContent, err = os.ReadFile(nestedFilePath)
	if err != nil {
		t.Errorf("Failed to read file: %v", err)
	}
	if string(readContent) != content {
		t.Errorf("Expected content '%s', got '%s'", content, string(readContent))
	}
}

func TestFileSystemUtils_ListFiles(t *testing.T) {
	fsUtils, err := NewFileSystemUtils()
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}

	// Create a temporary directory structure
	tempDir, err := os.MkdirTemp("", "fs_utils_test_dir")
	if err != nil {
		t.Fatalf("Failed to create temp directory: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create some files
	files := []string{
		filepath.Join(tempDir, "file1.txt"),
		filepath.Join(tempDir, "file2.md"),
		filepath.Join(tempDir, "file3.go"),
	}
	for _, file := range files {
		if err := os.WriteFile(file, []byte("content"), 0644); err != nil {
			t.Fatalf("Failed to create file %s: %v", file, err)
		}
	}

	// Create a subdirectory with a file
	subDir := filepath.Join(tempDir, "subdir")
	if err := os.Mkdir(subDir, 0755); err != nil {
		t.Fatalf("Failed to create subdirectory: %v", err)
	}
	subDirFile := filepath.Join(subDir, "subfile.txt")
	if err := os.WriteFile(subDirFile, []byte("content"), 0644); err != nil {
		t.Fatalf("Failed to create file %s: %v", subDirFile, err)
	}

	// Test listing all files
	listedFiles, err := fsUtils.ListFiles(tempDir, "")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if len(listedFiles) != 4 { // 3 files + 1 file in subdirectory
		t.Errorf("Expected 4 files, got %d", len(listedFiles))
	}

	// Test listing files with pattern
	listedFiles, err = fsUtils.ListFiles(tempDir, ".txt")
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if len(listedFiles) != 2 { // file1.txt + subfile.txt
		t.Errorf("Expected 2 files, got %d", len(listedFiles))
	}
	for _, file := range listedFiles {
		if !strings.HasSuffix(file, ".txt") {
			t.Errorf("Expected file with .txt extension, got %s", file)
		}
	}

	// Test listing files in non-existent directory
	_, err = fsUtils.ListFiles(tempDir+"_nonexistent", "")
	if err == nil {
		t.Error("Expected error for non-existent directory, got nil")
	}
}
