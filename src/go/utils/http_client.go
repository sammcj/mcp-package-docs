package utils

import (
	"context"
	"io"
	"net/http"
	"time"
)

// HTTPClient provides a simple wrapper around the standard http client
// with timeouts and common functionality
type HTTPClient struct {
	client *http.Client
}

// NewHTTPClient creates a new HTTP client with sensible defaults
func NewHTTPClient() *HTTPClient {
	return &HTTPClient{
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// Get performs an HTTP GET request to the specified URL
func (c *HTTPClient) Get(ctx context.Context, url string, headers map[string]string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}

	// Add headers
	for key, value := range headers {
		req.Header.Add(key, value)
	}

	// Set default user agent if not provided
	if _, ok := headers["User-Agent"]; !ok {
		req.Header.Set("User-Agent", "mcp-package-docs/go")
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	return io.ReadAll(resp.Body)
}

// GetWithAuth performs an HTTP GET request with authentication
func (c *HTTPClient) GetWithAuth(ctx context.Context, url, authToken string) ([]byte, error) {
	headers := map[string]string{
		"Authorization": "Bearer " + authToken,
	}
	return c.Get(ctx, url, headers)
}

// SetTimeout sets the client timeout
func (c *HTTPClient) SetTimeout(timeout time.Duration) {
	c.client.Timeout = timeout
}
