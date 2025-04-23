# Go parameters
BINARY_NAME=mcp-package-docs
GO=go
GOFLAGS=-v

# Get the current git tag or commit hash for versioning
VERSION=$(shell git describe --tags 2>/dev/null || git rev-parse --short HEAD)

.PHONY: all build clean test install

all: clean build

build:
$(GO) build $(GOFLAGS) -ldflags "-X main.Version=$(VERSION)" -o $(BINARY_NAME)

clean:
rm -f $(BINARY_NAME)
$(GO) clean

test:
$(GO) test ./... $(GOFLAGS)

install: build
sudo mv $(BINARY_NAME) /usr/local/bin/

# Development targets
dev: build
./$(BINARY_NAME)

lint:
golangci-lint run ./...

.DEFAULT_GOAL := build
