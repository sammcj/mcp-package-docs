// Test file for TypeScript language server functionality

// Import a module
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
    return `Hello, my name is ${this.name} and I am ${this.age} years old.`;
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
