package utils

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestNewHTTPClient(t *testing.T) {
	client := NewHTTPClient()
	if client == nil {
		t.Fatal("Expected non-nil client")
	}
	if client.client == nil {
		t.Fatal("Expected non-nil http.Client")
	}
	if client.client.Timeout != 30*time.Second {
		t.Errorf("Expected timeout of 30s, got %v", client.client.Timeout)
	}
}

func TestHTTPClient_Get(t *testing.T) {
	// Create a test server for headers test
	serverWithHeaders := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check request headers
		if r.Header.Get("User-Agent") != "mcp-package-docs/go" {
			t.Errorf("Expected User-Agent header to be 'mcp-package-docs/go', got %s", r.Header.Get("User-Agent"))
		}
		if r.Header.Get("Test-Header") != "test-value" {
			t.Errorf("Expected Test-Header header to be 'test-value', got %s", r.Header.Get("Test-Header"))
		}

		// Write response
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("test response with headers"))
	}))
	defer serverWithHeaders.Close()

	// Create a test server for no headers test
	serverNoHeaders := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check user agent header
		if r.Header.Get("User-Agent") != "mcp-package-docs/go" {
			t.Errorf("Expected User-Agent header to be 'mcp-package-docs/go', got %s", r.Header.Get("User-Agent"))
		}

		// Write response
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("test response no headers"))
	}))
	defer serverNoHeaders.Close()

	// Create client
	client := NewHTTPClient()

	// Test with headers
	headers := map[string]string{
		"Test-Header": "test-value",
	}
	data, err := client.Get(context.Background(), serverWithHeaders.URL, headers)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if string(data) != "test response with headers" {
		t.Errorf("Expected response 'test response with headers', got '%s'", string(data))
	}

	// Test without headers
	data, err = client.Get(context.Background(), serverNoHeaders.URL, nil)
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if string(data) != "test response no headers" {
		t.Errorf("Expected response 'test response no headers', got '%s'", string(data))
	}
}

func TestHTTPClient_GetWithAuth(t *testing.T) {
	// Create a test server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check authorization header
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("Expected Authorization header to be 'Bearer test-token', got %s", r.Header.Get("Authorization"))
		}

		// Write response
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("authenticated response"))
	}))
	defer server.Close()

	// Create client
	client := NewHTTPClient()

	// Test with auth token
	data, err := client.GetWithAuth(context.Background(), server.URL, "test-token")
	if err != nil {
		t.Fatalf("Unexpected error: %v", err)
	}
	if string(data) != "authenticated response" {
		t.Errorf("Expected response 'authenticated response', got '%s'", string(data))
	}
}

func TestHTTPClient_SetTimeout(t *testing.T) {
	client := NewHTTPClient()
	client.SetTimeout(10 * time.Second)
	if client.client.Timeout != 10*time.Second {
		t.Errorf("Expected timeout of 10s, got %v", client.client.Timeout)
	}
}

func TestHTTPClient_Get_Error(t *testing.T) {
	// Create client
	client := NewHTTPClient()

	// Test with invalid URL
	_, err := client.Get(context.Background(), "http://invalid-url-that-does-not-exist.example", nil)
	if err == nil {
		t.Fatal("Expected error for invalid URL, got nil")
	}
}

func TestHTTPClient_Get_Context(t *testing.T) {
	// Create a test server with a delay
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Delay response
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("delayed response"))
	}))
	defer server.Close()

	// Create client
	client := NewHTTPClient()

	// Create a context with a short timeout
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	// Test with context that will timeout
	_, err := client.Get(ctx, server.URL, nil)
	if err == nil {
		t.Fatal("Expected error for context timeout, got nil")
	}
}
