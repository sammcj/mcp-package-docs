import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver-protocol/node.js';
import {
  CompletionItem,
  CompletionParams,
  DidOpenTextDocumentParams,
  Hover,
  InitializeParams,
  PublishDiagnosticsParams,
  TextDocumentIdentifier,
  TextDocumentItem,
} from 'vscode-languageserver-protocol';
import * as childProcess from 'child_process';
import { dirname, join, isAbsolute } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { promisify } from 'util';

export interface LanguageServerConfig {
  command: string;
  args: string[];
}

// Helper function to check if a command exists
async function commandExists(command: string): Promise<boolean> {
  try {
    const exec = promisify(childProcess.exec);
    const platform = process.platform;

    if (platform === 'win32') {
      // Windows
      await exec(`where ${command}`);
    } else {
      // Unix-like (macOS, Linux)
      await exec(`which ${command}`);
    }
    return true;
  } catch (error) {
    return false;
  }
}

// Helper function to install a package using npm
async function installPackage(packageName: string): Promise<void> {
  try {
    console.log(`[installPackage] Installing ${packageName}...`);
    const exec = promisify(childProcess.exec);
    await exec(`npm install --no-save ${packageName}`);
    console.log(`[installPackage] Successfully installed ${packageName}`);
  } catch (error) {
    console.error(`[installPackage] Failed to install ${packageName}:`, error);
    throw error;
  }
}

export interface LanguageServerInstance {
  connection: MessageConnection;
  process: ReturnType<typeof childProcess.spawn>;
  workspaceRoot: string;
}

export class TypeScriptLspClient {
  private languageServers: Map<string, LanguageServerInstance>;
  private diagnosticsListeners: Map<string, ((params: PublishDiagnosticsParams) => void)[]>;

  constructor() {
    this.languageServers = new Map();
    this.diagnosticsListeners = new Map();
  }

  private getServerKey(languageId: string, projectRoot?: string): string {
    return `${languageId}:${projectRoot || 'default'}`;
  }

  private async getLanguageServerConfig(languageId: string): Promise<LanguageServerConfig | undefined> {
    console.log(`[getLanguageServerConfig] Getting config for ${languageId}`);

    // Default configurations for common language servers
    const defaultConfigs: Record<string, LanguageServerConfig> = {
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio']
      },
      javascript: {
        command: 'typescript-language-server',
        args: ['--stdio']
      },
      html: {
        command: 'vscode-html-language-server',
        args: ['--stdio']
      },
      css: {
        command: 'vscode-css-language-server',
        args: ['--stdio']
      },
      json: {
        command: 'vscode-json-language-server',
        args: ['--stdio']
      }
    };

    // Check if there's an environment variable override
    const configStr = process.env[`${languageId.toUpperCase()}_SERVER`];
    console.log(`[getLanguageServerConfig] Raw config for ${languageId}:`, configStr);

    if (configStr) {
      try {
        // Try to parse the environment variable configuration
        const config = JSON.parse(configStr);
        console.log(`[getLanguageServerConfig] Using custom config for ${languageId}:`, config);
        return config;
      } catch (error) {
        if (error instanceof Error) {
          console.error(`[getLanguageServerConfig] Invalid config for ${languageId}:`, error.message);
        } else {
          console.error(`[getLanguageServerConfig] Invalid config for ${languageId}:`, error);
        }
        // Fall back to default if parsing fails
        console.log(`[getLanguageServerConfig] Falling back to default config for ${languageId}`);
      }
    }

    // Get default config
    const defaultConfig = defaultConfigs[languageId.toLowerCase()];
    if (!defaultConfig) {
      console.log(`[getLanguageServerConfig] No config found for ${languageId}`);
      return undefined;
    }

    // Check if the command exists
    const commandName = defaultConfig.command;
    const commandAvailable = await commandExists(commandName);

    if (!commandAvailable) {
      console.log(`[getLanguageServerConfig] Command ${commandName} not found, attempting to install...`);

      // Map language server commands to npm packages
      const packageMap: Record<string, string> = {
        'typescript-language-server': 'typescript-language-server typescript',
        'vscode-html-language-server': 'vscode-langservers-extracted',
        'vscode-css-language-server': 'vscode-langservers-extracted',
        'vscode-json-language-server': 'vscode-langservers-extracted'
      };

      const packageToInstall = packageMap[commandName];
      if (packageToInstall) {
        try {
          await installPackage(packageToInstall);
          console.log(`[getLanguageServerConfig] Successfully installed ${packageToInstall}`);

          // For locally installed packages, use npx to run them
          return {
            command: 'npx',
            args: [commandName, ...defaultConfig.args]
          };
        } catch (error) {
          console.error(`[getLanguageServerConfig] Failed to install ${packageToInstall}:`, error);
        }
      }
    }

    console.log(`[getLanguageServerConfig] Using default config for ${languageId}`);
    return defaultConfig;
  }

  public async getOrCreateServer(languageId: string, projectRoot?: string): Promise<LanguageServerInstance> {
    const serverKey = this.getServerKey(languageId, projectRoot);
    console.log(`[getOrCreateServer] Request for ${serverKey}`);

    if (this.languageServers.has(serverKey)) {
      console.log(`[getOrCreateServer] Returning existing ${serverKey} server`);
      return this.languageServers.get(serverKey)!;
    }

    const config = await this.getLanguageServerConfig(languageId);
    if (!config) {
      throw new Error(`No language server configured for ${languageId}`);
    }

    console.log(`[getOrCreateServer] Spawning ${serverKey} server:`, config);
    const serverProcess = childProcess.spawn(config.command, config.args);

    serverProcess.on('error', (error) => {
      console.error(`[${serverKey} process] Error:`, error);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[${serverKey} stderr]`, data.toString());
    });

    // Create message connection
    console.log(`[getOrCreateServer] Creating message connection for ${serverKey}`);
    const connection = createMessageConnection(
      new StreamMessageReader(serverProcess.stdout),
      new StreamMessageWriter(serverProcess.stdin)
    );

    // Debug logging for messages
    connection.onNotification((method, params) => {
      console.log(`[${serverKey}] Notification received:`, method, params);
    });

    connection.onRequest((method, params) => {
      console.log(`[${serverKey}] Request received:`, method, params);
    });

    // If projectRoot is not provided, default to current working directory
    const actualRoot = projectRoot && existsSync(projectRoot) ? projectRoot : process.cwd();

    // Initialize connection
    console.log(`[getOrCreateServer] Starting connection for ${serverKey}`);
    connection.listen();

    // Initialize language server
    console.log(`[getOrCreateServer] Initializing ${serverKey} server`);
    try {
      const initializeResult = await connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri: `file://${actualRoot}`,
        workspaceFolders: [{
          uri: `file://${actualRoot}`,
          name: `${languageId}-workspace`
        }],
        capabilities: {
          workspace: {
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: true },
            workspaceFolders: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: true,
              willSave: true,
              willSaveWaitUntil: true,
              didSave: true
            },
            completion: {
              dynamicRegistration: true,
              completionItem: {
                snippetSupport: true,
                commitCharactersSupport: true,
                documentationFormat: ['markdown', 'plaintext'],
                deprecatedSupport: true,
                preselectSupport: true
              },
              contextSupport: true
            },
            hover: {
              dynamicRegistration: true,
              contentFormat: ['markdown', 'plaintext']
            },
            signatureHelp: {
              dynamicRegistration: true,
              signatureInformation: {
                documentationFormat: ['markdown', 'plaintext']
              }
            },
            declaration: { dynamicRegistration: true, linkSupport: true },
            definition: { dynamicRegistration: true, linkSupport: true },
            typeDefinition: { dynamicRegistration: true, linkSupport: true },
            implementation: { dynamicRegistration: true, linkSupport: true },
            references: { dynamicRegistration: true },
            documentHighlight: { dynamicRegistration: true },
            documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
            codeAction: {
              dynamicRegistration: true,
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: [] }
              }
            },
            codeLens: { dynamicRegistration: true },
            formatting: { dynamicRegistration: true },
            rangeFormatting: { dynamicRegistration: true },
            onTypeFormatting: { dynamicRegistration: true },
            rename: { dynamicRegistration: true },
            documentLink: { dynamicRegistration: true },
            colorProvider: { dynamicRegistration: true },
            foldingRange: { dynamicRegistration: true },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: true
            }
          }
        },
        initializationOptions: null,
      } as InitializeParams);

      console.log(`[getOrCreateServer] Initialize result for ${serverKey}:`, initializeResult);
      await connection.sendNotification('initialized');
      console.log(`[getOrCreateServer] Sent initialized notification for ${serverKey}`);

      // Optional: send workspace configuration changes if needed
      if (languageId === 'typescript') {
        await connection.sendNotification('workspace/didChangeConfiguration', {
          settings: {
            typescript: {
              format: {
                enable: true
              },
              suggest: {
                enabled: true,
                includeCompletionsForModuleExports: true
              },
              validate: {
                enable: true
              }
            }
          }
        });
      }
    } catch (error) {
      console.error(`[getOrCreateServer] Failed to initialize ${serverKey} server:`, error);
      throw error;
    }

    // Set up diagnostics handler
    connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: PublishDiagnosticsParams) => {
        console.log(`[${serverKey}] Received diagnostics:`, params);
        const listeners = this.diagnosticsListeners.get(params.uri) || [];
        listeners.forEach(listener => listener(params));
      }
    );

    const server = { connection, process: serverProcess, workspaceRoot: actualRoot };
    this.languageServers.set(serverKey, server);
    console.log(`[getOrCreateServer] Successfully created ${serverKey} server`);
    return server;
  }

  public async getHover(
    languageId: string,
    filePath: string,
    content: string,
    line: number,
    character: number,
    projectRoot?: string
  ): Promise<any> {
    console.log(`[getHover] Processing request for ${languageId}`);

    const server = await this.getOrCreateServer(languageId, projectRoot);
    const actualRoot = server.workspaceRoot;

    const absolutePath = isAbsolute(filePath) ? filePath : join(actualRoot, filePath);
    const uri = `file://${absolutePath}`;

    // Ensure directory exists (for languages that may require file presence)
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const textDocument: TextDocumentItem = {
      uri,
      languageId,
      version: 1,
      text: content,
    };

    console.log(`[getHover] Sending document to server:`, textDocument);
    await server.connection.sendNotification('textDocument/didOpen', {
      textDocument,
    } as DidOpenTextDocumentParams);

    try {
      console.log(`[getHover] Requesting hover information`);
      const hover: Hover = await server.connection.sendRequest('textDocument/hover', {
        textDocument: { uri } as TextDocumentIdentifier,
        position: { line, character },
      });

      console.log(`[getHover] Received hover response:`, hover);
      return hover;
    } catch (error) {
      console.error('[getHover] Request failed:', error);
      throw error;
    }
  }

  public async getCompletions(
    languageId: string,
    filePath: string,
    content: string,
    line: number,
    character: number,
    projectRoot?: string
  ): Promise<CompletionItem[]> {
    console.log(`[getCompletions] Processing request for ${languageId}`);

    const server = await this.getOrCreateServer(languageId, projectRoot);
    const actualRoot = server.workspaceRoot;

    const absolutePath = isAbsolute(filePath) ? filePath : join(actualRoot, filePath);
    const uri = `file://${absolutePath}`;

    // Ensure directory exists
    const dir = dirname(absolutePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const textDocument: TextDocumentItem = {
      uri,
      languageId,
      version: 1,
      text: content,
    };

    console.log(`[getCompletions] Sending document to server:`, textDocument);
    await server.connection.sendNotification('textDocument/didOpen', {
      textDocument,
    } as DidOpenTextDocumentParams);

    try {
      console.log(`[getCompletions] Requesting completions`);
      const completionParams: CompletionParams = {
        textDocument: { uri },
        position: { line, character },
      };

      const completions: CompletionItem[] | null = await server.connection.sendRequest(
        'textDocument/completion',
        completionParams
      );

      console.log(`[getCompletions] Received completions:`, completions);
      return completions || [];
    } catch (error) {
      console.error('[getCompletions] Request failed:', error);
      throw error;
    }
  }

  public async getDiagnostics(
    languageId: string,
    filePath: string,
    content: string,
    projectRoot?: string
  ): Promise<any> {
    console.log(`[getDiagnostics] Processing request for ${languageId}`);

    const server = await this.getOrCreateServer(languageId, projectRoot);
    const actualRoot = server.workspaceRoot;

    const absolutePath = isAbsolute(filePath) ? filePath : join(actualRoot, filePath);
    const uri = `file://${absolutePath}`;

    // Ensure directory exists
    const fileDir = dirname(absolutePath);
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }

    const textDocument: TextDocumentItem = {
      uri,
      languageId,
      version: 1,
      text: content,
    };

    console.log(`[getDiagnostics] Setting up diagnostics listener for ${uri}`);
    return new Promise((resolve, reject) => {
      const listeners = this.diagnosticsListeners.get(uri) || [];
      const listener = (params: PublishDiagnosticsParams) => {
        console.log(`[getDiagnostics] Received diagnostics for ${uri}:`, params);
        resolve(params.diagnostics);

        // Remove listener after receiving diagnostics
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      };
      listeners.push(listener);
      this.diagnosticsListeners.set(uri, listeners);

      // Send document to trigger diagnostics
      console.log(`[getDiagnostics] Sending document to server:`, textDocument);
      server.connection.sendNotification('textDocument/didOpen', {
        textDocument,
      } as DidOpenTextDocumentParams);

      // Set timeout
      setTimeout(() => {
        console.log(`[getDiagnostics] Timeout reached for ${uri}`);
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
          resolve([]);
        }
      }, 2000);
    });
  }

  public cleanup(): void {
    console.log('[cleanup] Disposing language servers...');
    for (const [id, server] of this.languageServers.entries()) {
      console.log(`[cleanup] Disposing ${id} server...`);
      server.connection.dispose();
      server.process.kill();
    }
    this.languageServers.clear();
    this.diagnosticsListeners.clear();
  }
}

export default TypeScriptLspClient;
