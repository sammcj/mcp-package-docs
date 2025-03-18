// Simple MCP-compliant logger
// Ensures stdout is kept clean for JSON-RPC messages by routing all logs to stderr
// This follows the pattern used by other CLI tools that need to maintain clean stdout
export class McpLogger {
  private prefix: string;
  private silent: boolean;

  constructor(prefix: string = '', silent: boolean = false) {
    this.prefix = prefix ? `[${prefix}] ` : '';
    this.silent = silent || process.env.MCP_SILENT_LOGS === 'true';
  }

  info(...args: unknown[]): void {
    if (!this.silent) {
      console.error(`${this.prefix}INFO:`, ...args)
    }
  }

  debug(...args: unknown[]): void {
    if (!this.silent) {
      console.error(`${this.prefix}DEBUG:`, ...args)
    }
  }

  warn(...args: unknown[]): void {
    if (!this.silent) {
      console.error(`${this.prefix}WARN:`, ...args)
    }
  }

  error(...args: unknown[]): void {
  // Always log errors, even in silent mode
    console.error(`${this.prefix}ERROR:`, ...args);
  }

  // Create a child logger with a new prefix
  child(prefix: string): McpLogger {
    return new McpLogger(prefix, this.silent)
  }

  // Set silent mode
  setSilent(silent: boolean): void {
    this.silent = silent;
  }
}

// Check if we're running as an MCP server
const isMcpServer = process.env.MCP_SERVER != 'false'

// Create root logger - silent by default when running as MCP server
export const logger = new McpLogger('MCP', isMcpServer)
