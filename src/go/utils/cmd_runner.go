package utils

import (
	"bytes"
	"context"
	"os/exec"
	"strings"
	"time"
)

// CommandRunner provides utilities for executing shell commands
type CommandRunner struct {
	defaultTimeout time.Duration
}

// CommandResult represents the result of a command execution
type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
	Error    error
}

// NewCommandRunner creates a new command runner with default settings
func NewCommandRunner() *CommandRunner {
	return &CommandRunner{
		defaultTimeout: 30 * time.Second,
	}
}

// Run executes a command with arguments and returns the result
func (r *CommandRunner) Run(ctx context.Context, command string, args ...string) CommandResult {
	cmd := exec.CommandContext(ctx, command, args...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	result := CommandResult{
		Stdout:   strings.TrimSpace(stdout.String()),
		Stderr:   strings.TrimSpace(stderr.String()),
		ExitCode: 0,
		Error:    nil,
	}

	if err != nil {
		result.Error = err
		if exitError, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitError.ExitCode()
		}
	}

	return result
}

// RunWithTimeout executes a command with a specific timeout
func (r *CommandRunner) RunWithTimeout(timeout time.Duration, command string, args ...string) CommandResult {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return r.Run(ctx, command, args...)
}

// RunSimple is a convenience method for running simple commands
// and only returning stdout if successful
func (r *CommandRunner) RunSimple(command string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), r.defaultTimeout)
	defer cancel()

	result := r.Run(ctx, command, args...)
	if result.Error != nil {
		return "", result.Error
	}

	return result.Stdout, nil
}

// SetDefaultTimeout sets the default timeout for command execution
func (r *CommandRunner) SetDefaultTimeout(timeout time.Duration) {
	r.defaultTimeout = timeout
}
