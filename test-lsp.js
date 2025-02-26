#!/usr/bin/env node
import TypeScriptLspClient from './build/lsp/typescript-lsp-client.js';

// Sample TypeScript code to test
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

// Use the fs module
const fileContent = fs.readFileSync('test-typescript.ts', 'utf-8');

// Array with methods
const numbers = [1, 2, 3, 4, 5];
numbers.map(n => n * 2);

// Type error for testing diagnostics
const stringValue: string = 42;
`;

async function testLsp() {
  console.log('Creating TypeScript LSP client...');
  const lspClient = new TypeScriptLspClient();

  try {
    // Test hover functionality
    console.log('\n--- Testing hover functionality ---');
    const hoverResult = await lspClient.getHover(
      'typescript',
      'test-file.ts',
      sampleCode,
      7, // Line for "name: string;"
      6, // Character position for "name"
      process.cwd()
    );
    console.log('Hover result:', JSON.stringify(hoverResult, null, 2));

    // Test completions functionality
    console.log('\n--- Testing completions functionality ---');
    const completionsResult = await lspClient.getCompletions(
      'typescript',
      'test-file.ts',
      sampleCode,
      31, // Line for "numbers.map"
      12, // Character position after "numbers."
      process.cwd()
    );
    console.log('Completions result:', JSON.stringify(completionsResult.slice(0, 3), null, 2)); // Show first 3 completions

    // Test diagnostics functionality
    console.log('\n--- Testing diagnostics functionality ---');
    const diagnosticsResult = await lspClient.getDiagnostics(
      'typescript',
      'test-file.ts',
      sampleCode,
      process.cwd()
    );
    console.log('Diagnostics result:', JSON.stringify(diagnosticsResult, null, 2));

  } catch (error) {
    console.error('Error testing LSP functionality:', error);
  } finally {
    // Clean up
    lspClient.cleanup();
  }
}

testLsp().catch(console.error);
