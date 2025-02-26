// Simple MCP-compliant logger
// Ensures stdout is kept clean for JSON-RPC messages by routing all logs to stderr
// This follows the pattern used by other CLI tools that need to maintain clean stdout
export class McpLogger {
  private prefix: string;

  constructor(prefix: string = '') {
    this.prefix = prefix ? `[${prefix}] ` : '';
  }

  info(...args: any[]): void {
    console.error(`${this.prefix}INFO:`, ...args);
  }

  debug(...args: any[]): void {
    console.error(`${this.prefix}DEBUG:`, ...args);
  }

  warn(...args: any[]): void {
    console.error(`${this.prefix}WARN:`, ...args);
  }

  error(...args: any[]): void {
    console.error(`${this.prefix}ERROR:`, ...args);
  }

  // Create a child logger with a new prefix
  child(prefix: string): McpLogger {
    return new McpLogger(prefix);
  }
}

// Create root logger
export const logger = new McpLogger('MCP');
