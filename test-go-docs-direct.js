#!/usr/bin/env node
import axios from 'axios';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

// Mock logger
const logger = {
  debug: (...args) => console.log('[DEBUG]', ...args),
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  child: () => logger
};

/**
 * Test function to fetch Go package documentation
 */
async function testGoPackageDoc(packageName) {
  console.log(`Testing Go package documentation retrieval for: ${packageName}`);

  try {
    // First try using go doc command (works for standard library and cached modules)
    try {
      console.log('Attempting to use go doc command...');
      const cmd = `go doc ${packageName}`;
      const { stdout } = await execAsync(cmd);
      console.log('Successfully retrieved documentation using go doc command:');
      console.log('---');
      console.log(stdout);
      console.log('---');
      return;
    } catch (cmdError) {
      console.log(`go doc command failed: ${cmdError.message}`);
    }

    // If go doc command fails, try to fetch from pkg.go.dev API
    try {
      console.log('Attempting to fetch from pkg.go.dev API...');
      const url = `https://pkg.go.dev/api/packages/${encodeURIComponent(packageName)}`;
      console.log(`Fetching from: ${url}`);

      const response = await axios.get(url);

      if (response.data) {
        console.log('Successfully retrieved documentation from pkg.go.dev API:');
        console.log('---');
        console.log('Synopsis:', response.data.Synopsis || 'None');
        console.log('Documentation available:', response.data.Documentation ? 'Yes' : 'No');
        console.log('---');
        return;
      }
    } catch (apiError) {
      console.log(`Error fetching from pkg.go.dev API: ${apiError.message}`);
    }

    // If API fails, try web scraping approach
    try {
      console.log('Attempting to fetch documentation from pkg.go.dev website...');
      const url = `https://pkg.go.dev/${encodeURIComponent(packageName)}`;
      console.log(`Fetching from: ${url}`);

      const response = await axios.get(url);

      if (response.data) {
        console.log('Successfully retrieved HTML from pkg.go.dev website');

        // Simple extraction of package description
        const descriptionMatch = response.data.match(/<meta name="description" content="([^"]+)"/);
        const description = descriptionMatch ? descriptionMatch[1] : `Go package: ${packageName}`;

        console.log('---');
        console.log('Description:', description);
        console.log('---');
        return;
      }
    } catch (webError) {
      console.log(`Error fetching from pkg.go.dev website: ${webError.message}`);
    }

    console.log('All methods failed to retrieve documentation');

  } catch (error) {
    console.error(`Error getting Go documentation for ${packageName}:`, error);
  }
}

// Test with the ollama package with full import path
testGoPackageDoc('github.com/ollama/ollama')
  .then(() => {
    console.log('\n\nTesting with a well-known package:');
    // Test with a well-known package
    return testGoPackageDoc('github.com/spf13/cobra');
  })
  .then(() => console.log('Test completed'))
  .catch(err => console.error('Test failed:', err));
