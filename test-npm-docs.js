#!/usr/bin/env node
import { NpmDocsEnhancer } from './build/npm-docs-enhancer.js';
import { NpmDocsHandler } from './build/npm-docs-integration.js';
import { logger } from './build/logger.js';

// Simple test script to verify the NPM documentation functionality

async function testNpmDocs() {
  try {
    console.log('Testing NPM documentation functionality...');

    // Test the NpmDocsEnhancer
    const enhancer = new NpmDocsEnhancer(logger);

    // Test fetching TypeScript definitions
    console.log('\nTesting TypeScript definition fetching...');
    const typesContent = await enhancer.fetchTypeDefinition('axios');
    console.log(`Fetched TypeScript definitions: ${typesContent ? 'Yes' : 'No'}`);

    if (typesContent) {
      // Test extracting API documentation
      console.log('\nTesting API documentation extraction...');
      const apiDoc = await enhancer.extractApiDocumentation('axios', typesContent);
      console.log(`Extracted API documentation: ${apiDoc.exports.length} exports, ${apiDoc.types.length} types`);

      // Print a sample of the exports
      if (apiDoc.exports.length > 0) {
        console.log('\nSample exports:');
        apiDoc.exports.slice(0, 3).forEach(exp => {
          console.log(`- ${exp.name} (${exp.type})`);
        });
      }

      // Print a sample of the types
      if (apiDoc.types.length > 0) {
        console.log('\nSample types:');
        apiDoc.types.slice(0, 3).forEach(type => {
          console.log(`- ${type.name} (${type.type})`);
        });
      }
    }

    // Test fetching examples
    console.log('\nTesting example fetching...');
    const examples = await enhancer.fetchExamples('axios');
    console.log(`Fetched examples: ${examples.length}`);

    if (examples.length > 0) {
      console.log('\nFirst example snippet:');
      console.log(examples[0].split('\n').slice(0, 5).join('\n') + '...');
    }

    // Test the NpmDocsHandler with mock functions
    console.log('\nTesting NpmDocsHandler...');
    const handler = new NpmDocsHandler();

    // Mock functions
    const getRegistryConfigForPackage = () => ({ registry: 'https://registry.npmjs.org' });
    const isNpmPackageInstalledLocally = () => false;
    const getLocalNpmDoc = () => ({ description: 'Mock local documentation' });

    // Test describeNpmPackage
    console.log('\nTesting describeNpmPackage...');
    const describeResult = await handler.describeNpmPackage(
      { package: 'axios', includeTypes: true, includeExamples: true },
      getRegistryConfigForPackage,
      isNpmPackageInstalledLocally,
      getLocalNpmDoc
    );

    console.log('Description:', describeResult.description);
    console.log('Has usage:', !!describeResult.usage);
    console.log('Has example:', !!describeResult.example);
    console.log('Has error:', !!describeResult.error);

    console.log('\nTest completed successfully!');
  } catch (error) {
    console.error('Error during testing:', error);
  }
}

testNpmDocs();
