# Makefile for mcp-package-docs

# Variables
BINARY_NAME=mcp-package-docs
VERSION=$(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS=-ldflags "-X main.Version=$(VERSION)"
GO_FILES=$(shell find . -name "*.go" -type f)
GOPATH=$(shell go env GOPATH)

# Default target
.PHONY: all
all: lint test build

# Build the application
.PHONY: build
build:
	@echo "Building $(BINARY_NAME)..."
	@go build $(LDFLAGS) -o $(BINARY_NAME) ./src/go

# Run the application
.PHONY: run
run: build
	@echo "Running $(BINARY_NAME)..."
	@./$(BINARY_NAME)

# Install the application
.PHONY: install
install:
	@echo "Installing $(BINARY_NAME)..."
	@go install $(LDFLAGS) ./src/go

# Clean build artifacts
.PHONY: clean
clean:
	@echo "Cleaning..."
	@rm -f $(BINARY_NAME)
	@go clean

# Run tests
.PHONY: test
test:
	@echo "Running tests..."
	@go test -v ./src/go/...

# Run tests with coverage
.PHONY: test-coverage
test-coverage:
	@echo "Running tests with coverage..."
	@go test -v -coverprofile=coverage.out ./src/go/...
	@go tool cover -html=coverage.out -o coverage.html

# Lint the code
.PHONY: lint
lint:
	@echo "Linting code..."
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run ./src/go/...; \
	else \
		echo "golangci-lint not installed. Installing..."; \
		go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest; \
		$(GOPATH)/bin/golangci-lint run ./src/go/...; \
	fi

# Format the code
.PHONY: fmt
fmt:
	@echo "Formatting code..."
	@go fmt ./src/go/...

# Vet the code
.PHONY: vet
vet:
	@echo "Vetting code..."
	@go vet ./src/go/...

# Generate a new version tag
.PHONY: version
version:
	@echo "Current version: $(VERSION)"
	@read -p "Enter new version (e.g., v1.0.0): " version; \
	git tag -a $$version -m "Release $$version"; \
	echo "Tagged with $$version"

# Release a new version
.PHONY: release
release: clean test lint build
	@echo "Preparing release..."
	@if [ -z "$(VERSION)" ] || [ "$(VERSION)" = "dev" ]; then \
		echo "No version tag found. Use 'make version' first."; \
		exit 1; \
	fi
	@echo "Building release for version $(VERSION)..."
	@GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o $(BINARY_NAME)-linux-amd64 ./src/go
	@GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o $(BINARY_NAME)-darwin-amd64 ./src/go
	@GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o $(BINARY_NAME)-darwin-arm64 ./src/go
	@GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o $(BINARY_NAME)-windows-amd64.exe ./src/go
	@echo "Release artifacts built for version $(VERSION)"

# Help target
.PHONY: help
help:
	@echo "Available targets:"
	@echo "  all            : Run lint, test, and build"
	@echo "  build          : Build the application"
	@echo "  run            : Build and run the application"
	@echo "  install        : Install the application"
	@echo "  clean          : Clean build artifacts"
	@echo "  test           : Run tests"
	@echo "  test-coverage  : Run tests with coverage"
	@echo "  lint           : Lint the code"
	@echo "  fmt            : Format the code"
	@echo "  vet            : Vet the code"
	@echo "  version        : Create a new version tag"
	@echo "  release        : Build release artifacts"
	@echo "  help           : Show this help message"
