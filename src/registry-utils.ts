import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join as pathJoin, dirname } from 'path';
import { McpLogger } from './logger.js';

export interface NpmConfig {
  registry: string;
  token?: string;
}

export class RegistryUtils {
  private logger: McpLogger;
  private registryMap: Map<string, NpmConfig>;

  constructor(logger: McpLogger) {
    this.logger = logger.child('RegistryUtils');
    this.registryMap = this.loadNpmConfig();
  }

  /**
   * Get registry configuration for a package
   */
  public getRegistryConfigForPackage(packageName: string, projectPath?: string): NpmConfig {
    // Load fresh config if project path is provided
    if (projectPath) {
      this.registryMap = this.loadNpmConfig(projectPath);
    }

    if (packageName.startsWith("@")) {
      const scope = packageName.split("/")[0];
      return this.registryMap.get(scope) || this.registryMap.get("default") || { registry: "https://registry.npmjs.org" };
    }
    return this.registryMap.get("default") || { registry: "https://registry.npmjs.org" };
  }

  /**
   * Load npm configuration from .npmrc files
   */
  private loadNpmConfig(projectPath?: string): Map<string, NpmConfig> {
    const registryMap = new Map<string, NpmConfig>();
    registryMap.set("default", { registry: "https://registry.npmjs.org" });

    const scopeToRegistry = new Map<string, string>();
    const registryToToken = new Map<string, string>();

    this.logger.info("Loading npm configuration...")
    this.logger.info("Project directory:", projectPath || "not specified");

    // First read global .npmrc as base configuration
    const globalNpmrcPath = pathJoin(homedir(), ".npmrc");
    this.logger.info("Checking global .npmrc at:", globalNpmrcPath);
    if (existsSync(globalNpmrcPath)) {
      this.logger.info("Found global .npmrc");
      try {
        const npmrcContent = readFileSync(globalNpmrcPath, "utf-8");
        this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
      } catch (error) {
        this.logger.error("Error reading global .npmrc:", error);
      }
    }

    // Then read from root to project directory, so local configs take precedence
    if (projectPath) {
      const paths: string[] = [];
      let currentDir = projectPath;
      const root = dirname(currentDir);

      // Collect all paths first
      while (currentDir !== root) {
        paths.push(currentDir);
        currentDir = dirname(currentDir);
      }
      paths.push(root);

      // Process paths in reverse order (root to local)
      for (const dir of paths.reverse()) {
        const localNpmrcPath = pathJoin(dir, ".npmrc");
        this.logger.info("Checking for .npmrc at:", localNpmrcPath);
        if (existsSync(localNpmrcPath)) {
          this.logger.info("Found .npmrc at:", localNpmrcPath);
          try {
            const npmrcContent = readFileSync(localNpmrcPath, "utf-8");
            this.parseNpmrcContent(npmrcContent, scopeToRegistry, registryToToken, registryMap);
          } catch (error) {
            this.logger.error(`Error reading local .npmrc at ${localNpmrcPath}:`, error);
          }
        }
      }
    }

    try {
      // Associate tokens with registries
      for (const [scope, registry] of scopeToRegistry.entries()) {
        const hostname = new URL(registry).host;
        const token = registryToToken.get(hostname);
        this.logger.info(`Setting config for scope ${scope}:`, { registry, token: token ? "[REDACTED]" : undefined });
        registryMap.set(scope, { registry, token });
      }

      // Ensure default registry has its token if available
      const defaultConfig = registryMap.get("default");
      if (defaultConfig) {
        const hostname = new URL(defaultConfig.registry).host;
        const token = registryToToken.get(hostname);
        if (token) {
          this.logger.info("Setting token for default registry");
          registryMap.set("default", { ...defaultConfig, token });
        }
      }

      this.logger.info("Final registry configurations:",
        Object.fromEntries(Array.from(registryMap.entries()).map(([k, v]) => [
          k,
          { registry: v.registry, token: v.token ? "[REDACTED]" : undefined }
        ]))
      );
    } catch (error) {
      this.logger.error("Error processing .npmrc configurations:", error);
    }

    return registryMap;
  }

  /**
   * Parse .npmrc content
   */
  private parseNpmrcContent(
    content: string,
    scopeToRegistry: Map<string, string>,
    registryToToken: Map<string, string>,
    registryMap: Map<string, NpmConfig>
  ): void {
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) continue;

      // Handle registry configurations
      // Match patterns like:
      // @scope:registry=https://registry.example.com
      // registry=https://registry.example.com
      const registryMatch = trimmedLine.match(/^(?:@([^:]+):)?registry=(.+)$/);
      if (registryMatch) {
        const [, scope, registry] = registryMatch;
        const cleanRegistry = registry.replace(/\/$/, "");
        if (scope) {
          scopeToRegistry.set(`@${scope}`, cleanRegistry);
        } else {
          registryMap.set("default", { registry: cleanRegistry });
        }
        continue;
      }

      // Handle authentication tokens
      // Match patterns like:
      // //registry.example.com/:_authToken=token
      // @scope:_authToken=token
      // _authToken=token
      const tokenMatch = trimmedLine.match(/^(?:\/\/([^/]+)\/:|@([^:]+):)?_authToken=(.+)$/);
      if (tokenMatch) {
        const [, registry, scope, token] = tokenMatch;
        if (registry) {
          // Store token for specific registry
          // Handle both protocol and non-protocol URLs
          registryToToken.set(registry, token);
          if (!registry.includes("://")) {
            registryToToken.set(`https://${registry}`, token);
            registryToToken.set(`http://${registry}`, token);
          }
        } else if (scope) {
          // Store token for scope, we'll resolve the registry later
          const scopeRegistry = scopeToRegistry.get(`@${scope}`);
          if (scopeRegistry) {
            try {
              // Try parsing as URL first
              const url = new URL(scopeRegistry);
              registryToToken.set(url.host, token);
            } catch {
              // If not a URL, treat as hostname
              registryToToken.set(scopeRegistry, token);
              registryToToken.set(`https://${scopeRegistry}`, token);
              registryToToken.set(`http://${scopeRegistry}`, token);
            }
          }
        } else {
          // Default token
          const defaultRegistry = registryMap.get("default")?.registry;
          if (defaultRegistry) {
            try {
              // Try parsing as URL first
              const url = new URL(defaultRegistry);
              registryToToken.set(url.host, token);
            } catch {
              // If not a URL, treat as hostname
              registryToToken.set(defaultRegistry, token);
              registryToToken.set(`https://${defaultRegistry}`, token);
              registryToToken.set(`http://${defaultRegistry}`, token);
            }
          }
        }
      }
    }
  }
}
