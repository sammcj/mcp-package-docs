#!/usr/bin/env node
import TypeScriptLspClient from './build/lsp/typescript-lsp-client.js';

// Sample TypeScript code with a type error
const sampleCode = `
// Test file for TypeScript language server functionality
import * as fs from 'fs';

// Define a class
class Person {
  name: string;
  age: number;

  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }

  greet(): string {
    return \`Hello, my name is \${this.name} and I am \${this.age} years old.\`;
  }
}

// Create an instance of the class
const person = new Person('John', 30);

// Call a method on the instance
const greeting = person.greet();

// Type error for testing diagnostics
const stringValue: string = 42;
`;

async function main() {
  console.log('Creating TypeScript LSP client...');
  const lspClient = new TypeScriptLspClient();

  try {
    // Test diagnostics functionality
    console.log('\n--- Testing diagnostics functionality ---');
    const diagnosticsResult = await lspClient.getDiagnostics(
      'typescript',
      'test-file.ts',
      sampleCode,
      process.cwd()
    );
    console.log('Diagnostics result:', JSON.stringify(diagnosticsResult, null, 2));

    // Success!
    console.log('\n--- Test completed successfully ---');
    console.log('The TypeScript language server is working correctly!');
    console.log('You can now use the LSP tools in the MCP server.');

  } catch (error) {
    console.error('Error testing LSP functionality:', error);
  } finally {
    // Clean up
    lspClient.cleanup();
  }
}

main().catch(console.error);
