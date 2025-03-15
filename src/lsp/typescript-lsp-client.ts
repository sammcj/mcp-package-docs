import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  CompletionItem,
  CompletionParams,
  DidOpenTextDocumentParams,
  Hover,
  InitializeParams,
  PublishDiagnosticsParams,
  TextDocumentIdentifier,
  TextDocumentItem,
} from 'vscode-languageserver-protocol/node.js';
import { logger, McpLogger } from '../logger.js';
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
    logger.debug(`Installing ${packageName}...`);
    const exec = promisify(childProcess.exec);
    await exec(`npm install --no-save ${packageName}`);
    logger.debug(`Successfully installed ${packageName}`);
  } catch (error) {
    logger.error(`Failed to install ${packageName}:`, error);
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
  private logger: McpLogger;

  constructor() {
    this.languageServers = new Map();
    this.diagnosticsListeners = new Map();
    this.logger = logger.child('LSP');
  }

  private getServerKey(languageId: string, projectRoot?: string): string {
    return `${languageId}:${projectRoot || 'default'}`;
  }

  private async getLanguageServerConfig(languageId: string): Promise<LanguageServerConfig | undefined> {
    this.logger.debug(`Getting config for ${languageId}`);

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
    this.logger.debug(`Raw config for ${languageId}:`, configStr);

    if (configStr) {
      try {
        // Try to parse the environment variable configuration
        const config = JSON.parse(configStr);
        this.logger.debug(`Using custom config for ${languageId}:`, config);
        return config;
      } catch (error) {
        if (error instanceof Error) {
          this.logger.error(`Invalid config for ${languageId}:`, error.message);
        } else {
          this.logger.error(`Invalid config for ${languageId}:`, error);
        }
        // Fall back to default if parsing fails
        this.logger.debug(`Falling back to default config for ${languageId}`);
      }
    }

    // Get default config
    const defaultConfig = defaultConfigs[languageId.toLowerCase()];
    if (!defaultConfig) {
      this.logger.debug(`No config found for ${languageId}`);
      return undefined;
    }

    // Check if the command exists
    const commandName = defaultConfig.command;
    const commandAvailable = await commandExists(commandName);

    if (!commandAvailable) {
      this.logger.debug(`Command ${commandName} not found, attempting to install...`);

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
          this.logger.debug(`Successfully installed ${packageToInstall}`);

          // For locally installed packages, use npx to run them
          return {
            command: 'npx',
            args: [commandName, ...defaultConfig.args]
          };
        } catch (error) {
          this.logger.error(`Failed to install ${packageToInstall}:`, error);
        }
      }
    }

    this.logger.debug(`Using default config for ${languageId}`);
    return defaultConfig;
  }

  public async getOrCreateServer(languageId: string, projectRoot?: string): Promise<LanguageServerInstance> {
    const serverKey = this.getServerKey(languageId, projectRoot);
    this.logger.debug(`Request for ${serverKey}`);

    if (this.languageServers.has(serverKey)) {
      this.logger.debug(`Returning existing ${serverKey} server`);
      return this.languageServers.get(serverKey)!;
    }

    const config = await this.getLanguageServerConfig(languageId);
    if (!config) {
      throw new Error(`No language server configured for ${languageId}`);
    }

    this.logger.debug(`Spawning ${serverKey} server:`, config);
    const serverProcess = childProcess.spawn(config.command, config.args);

    serverProcess.on('error', (error) => {
      this.logger.error(`[${serverKey} process] Error:`, error);
    });

    serverProcess.stderr.on('data', (data) => {
      this.logger.error(`[${serverKey} stderr]`, data.toString());
    });

    // Create message connection
    this.logger.debug(`Creating message connection for ${serverKey}`);
    const connection = createMessageConnection(
      new StreamMessageReader(serverProcess.stdout),
      new StreamMessageWriter(serverProcess.stdin)
    );

    // Debug logging for messages
    connection.onNotification((method, params) => {
      this.logger.debug(`[${serverKey}] Notification received:`, method, params);
    });

    connection.onRequest((method, params) => {
      this.logger.debug(`[${serverKey}] Request received:`, method, params);
    });

    // If projectRoot is not provided, default to current working directory
    const actualRoot = projectRoot && existsSync(projectRoot) ? projectRoot : process.cwd();

    // Initialize connection
    this.logger.debug(`Starting connection for ${serverKey}`);
    connection.listen();

    // Initialize language server
    this.logger.debug(`Initializing ${serverKey} server`);
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

      this.logger.debug(`Initialize result for ${serverKey}:`, initializeResult);
      await connection.sendNotification('initialized');
      this.logger.debug(`Sent initialized notification for ${serverKey}`);

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
      this.logger.error(`Failed to initialize ${serverKey} server:`, error);
      throw error;
    }

    // Set up diagnostics handler
    connection.onNotification(
      'textDocument/publishDiagnostics',
      (params: PublishDiagnosticsParams) => {
        this.logger.debug(`[${serverKey}] Received diagnostics:`, params);
        const listeners = this.diagnosticsListeners.get(params.uri) || [];
        listeners.forEach(listener => listener(params));
      }
    );

    const server = { connection, process: serverProcess, workspaceRoot: actualRoot };
    this.languageServers.set(serverKey, server);
    this.logger.debug(`Successfully created ${serverKey} server`);
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
    this.logger.debug(`Processing hover request for ${languageId}`);

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

    this.logger.debug(`Sending document to server:`, textDocument);
    await server.connection.sendNotification('textDocument/didOpen', {
      textDocument,
    } as DidOpenTextDocumentParams);

    try {
      this.logger.debug(`Requesting hover information`);
      const hover: Hover = await server.connection.sendRequest('textDocument/hover', {
        textDocument: { uri } as TextDocumentIdentifier,
        position: { line, character },
      });

      this.logger.debug(`Received hover response:`, hover);
      return hover;
    } catch (error) {
      this.logger.error('Hover request failed:', error);
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
    this.logger.debug(`Processing completions request for ${languageId}`);

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

    this.logger.debug(`Sending document to server:`, textDocument);
    await server.connection.sendNotification('textDocument/didOpen', {
      textDocument,
    } as DidOpenTextDocumentParams);

    try {
      this.logger.debug(`Requesting completions`);
      const completionParams: CompletionParams = {
        textDocument: { uri },
        position: { line, character },
      };

      const completions: CompletionItem[] | null = await server.connection.sendRequest(
        'textDocument/completion',
        completionParams
      );

      this.logger.debug(`Received completions:`, completions);
      return completions || [];
    } catch (error) {
      this.logger.error('Completions request failed:', error);
      throw error;
    }
  }

  public async getDiagnostics(
    languageId: string,
    filePath: string,
    content: string,
    projectRoot?: string
  ): Promise<any> {
    this.logger.debug(`Processing diagnostics request for ${languageId}`);

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

    this.logger.debug(`Setting up diagnostics listener for ${uri}`);
    return new Promise((resolve, reject) => {
      const listeners = this.diagnosticsListeners.get(uri) || [];
      const listener = (params: PublishDiagnosticsParams) => {
        this.logger.debug(`Received diagnostics for ${uri}:`, params);
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
      this.logger.debug(`Sending document to server:`, textDocument);
      server.connection.sendNotification('textDocument/didOpen', {
        textDocument,
      } as DidOpenTextDocumentParams);

      // Set timeout
      setTimeout(() => {
        this.logger.debug(`Timeout reached for ${uri}`);
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
          resolve([]);
        }
      }, 2000);
    });
  }

  public cleanup(): void {
    this.logger.debug('Disposing language servers...');
    for (const [id, server] of this.languageServers.entries()) {
      this.logger.debug(`Disposing ${id} server...`);
      server.connection.dispose();
      server.process.kill();
    }
    this.languageServers.clear();
    this.diagnosticsListeners.clear();
  }
}

export default TypeScriptLspClient;
