package utils

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestNewCommandRunner(t *testing.T) {
	runner := NewCommandRunner()
	if runner == nil {
		t.Fatal("Expected non-nil runner")
	}
	if runner.defaultTimeout != 30*time.Second {
		t.Errorf("Expected default timeout of 30s, got %v", runner.defaultTimeout)
	}
}

func TestCommandRunner_Run(t *testing.T) {
	runner := NewCommandRunner()

	// Test successful command
	result := runner.Run(context.Background(), "echo", "hello", "world")
	if result.Error != nil {
		t.Fatalf("Unexpected error: %v", result.Error)
	}
	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}
	if result.Stdout != "hello world" {
		t.Errorf("Expected stdout 'hello world', got '%s'", result.Stdout)
	}
	if result.Stderr != "" {
		t.Errorf("Expected empty stderr, got '%s'", result.Stderr)
	}

	// Test command with stderr output
	result = runner.Run(context.Background(), "sh", "-c", "echo error message >&2")
	if result.Error != nil {
		t.Fatalf("Unexpected error: %v", result.Error)
	}
	if result.ExitCode != 0 {
		t.Errorf("Expected exit code 0, got %d", result.ExitCode)
	}
	if result.Stdout != "" {
		t.Errorf("Expected empty stdout, got '%s'", result.Stdout)
	}
	if result.Stderr != "error message" {
		t.Errorf("Expected stderr 'error message', got '%s'", result.Stderr)
	}

	// Test command with non-zero exit code
	result = runner.Run(context.Background(), "sh", "-c", "exit 1")
	if result.Error == nil {
		t.Fatal("Expected error for non-zero exit code, got nil")
	}
	if result.ExitCode != 1 {
		t.Errorf("Expected exit code 1, got %d", result.ExitCode)
	}
}

func TestCommandRunner_RunWithTimeout(t *testing.T) {
	runner := NewCommandRunner()

	// Test command that completes within timeout
	result := runner.RunWithTimeout(1*time.Second, "echo", "hello")
	if result.Error != nil {
		t.Fatalf("Unexpected error: %v", result.Error)
	}
	if result.Stdout != "hello" {
		t.Errorf("Expected stdout 'hello', got '%s'", result.Stdout)
	}

	// Test command that exceeds timeout
	result = runner.RunWithTimeout(10*time.Millisecond, "sleep", "1")
	if result.Error == nil {
		t.Fatal("Expected error for timeout, got nil")
	}
	// Check if the error message contains "context deadline exceeded" or "signal: killed"
	if !strings.Contains(result.Error.Error(), "context deadline exceeded") &&
	   !strings.Contains(result.Error.Error(), "signal: killed") {
		t.Errorf("Expected timeout error, got: %v", result.Error)
	}
}

func TestCommandRunner_RunSimple(t *testing.T) {
	runner := NewCommandRunner()

	// Test successful command
	output, err := runner.RunSimple("echo", "hello", "world")
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if output != "hello world" {
		t.Errorf("Expected output 'hello world', got '%s'", output)
	}

	// Test command with error
	output, err = runner.RunSimple("sh", "-c", "exit 1")
	if err == nil {
		t.Fatal("Expected error for non-zero exit code, got nil")
	}
	if output != "" {
		t.Errorf("Expected empty output, got '%s'", output)
	}
}

func TestCommandRunner_SetDefaultTimeout(t *testing.T) {
	runner := NewCommandRunner()
	runner.SetDefaultTimeout(10 * time.Second)
	if runner.defaultTimeout != 10*time.Second {
		t.Errorf("Expected default timeout of 10s, got %v", runner.defaultTimeout)
	}
}
