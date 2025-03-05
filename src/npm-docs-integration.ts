import { NpmDocsEnhancer, PackageApiDocumentation } from './npm-docs-enhancer.js';
import { logger } from './logger.js';
import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Enhanced version of NpmDocArgs interface
export interface NpmDocArgs {
  package: string;
  version?: string;
  projectPath?: string;
  section?: string;
  maxLength?: number;
  query?: string;
  includeTypes?: boolean; // Whether to include TypeScript type definitions
  includeExamples?: boolean; // Whether to include code examples
}

// Enhanced version of isNpmDocArgs function
export const isNpmDocArgs = (args: unknown): args is NpmDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as NpmDocArgs).package === "string" &&
    (typeof (args as NpmDocArgs).version === "string" ||
      (args as NpmDocArgs).version === undefined) &&
    (typeof (args as NpmDocArgs).projectPath === "string" ||
      (args as NpmDocArgs).projectPath === undefined) &&
    (typeof (args as NpmDocArgs).section === "string" ||
      (args as NpmDocArgs).section === undefined) &&
    (typeof (args as NpmDocArgs).maxLength === "number" ||
      (args as NpmDocArgs).maxLength === undefined) &&
    (typeof (args as NpmDocArgs).query === "string" ||
      (args as NpmDocArgs).query === undefined) &&
    (typeof (args as NpmDocArgs).includeTypes === "boolean" ||
      (args as NpmDocArgs).includeTypes === undefined) &&
    (typeof (args as NpmDocArgs).includeExamples === "boolean" ||
      (args as NpmDocArgs).includeExamples === undefined)
  );
};

// Interface for registry configuration
export interface NpmConfig {
  registry: string;
  token?: string;
}

// Interface for documentation result
export interface DocResult {
  description?: string;
  usage?: string;
  example?: string;
  error?: string;
  searchResults?: SearchResults;
  suggestInstall?: boolean;
  apiDocumentation?: PackageApiDocumentation;
}

// Interface for search results
export interface SearchResults {
  results: SearchResult[];
  totalResults: number;
  error?: string;
  suggestInstall?: boolean;
}

// Interface for search result
export interface SearchResult {
  symbol?: string;
  match: string;
  context?: string;
  score: number;
  type?: string;
}

// Class to handle NPM package documentation
export class NpmDocsHandler {
  private enhancer: NpmDocsEnhancer;

  constructor() {
    this.enhancer = new NpmDocsEnhancer(logger);
  }

  /**
   * Get documentation for an NPM package
   * Enhanced to return structured API documentation
   */
  public async describeNpmPackage(
    args: NpmDocArgs,
    getRegistryConfigForPackage: (packageName: string, projectPath?: string) => NpmConfig,
    isNpmPackageInstalledLocally: (packageName: string, projectPath?: string) => boolean,
    getLocalNpmDoc: (packageName: string, projectPath?: string) => DocResult
  ): Promise<DocResult> {
    const { package: packageName, version, projectPath, includeTypes = true, includeExamples = true } = args;
    logger.info(`Getting NPM documentation for ${packageName}${version ? `@${version}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = isNpmPackageInstalledLocally(packageName, projectPath);
      let packageInfo: any;
      let apiDocumentation: PackageApiDocumentation | undefined;
      let examples: string[] = [];

      if (isInstalled) {
        logger.info(`Using local documentation for ${packageName}`);
        const localDoc = getLocalNpmDoc(packageName, projectPath);

        // Try to extract TypeScript definitions from local installation
        if (includeTypes) {
          const basePath = projectPath || process.cwd();
          const packagePath = join(basePath, "node_modules", packageName);
          const packageJsonPath = join(packagePath, "package.json");

          if (existsSync(packageJsonPath)) {
            packageInfo = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

            // Check for TypeScript definitions
            if (packageInfo.types || packageInfo.typings) {
              const typesPath = join(packagePath, packageInfo.types || packageInfo.typings);

              if (existsSync(typesPath)) {
                const typesContent = readFileSync(typesPath, "utf-8");
                apiDocumentation = await this.enhancer.extractApiDocumentation(packageName, typesContent, true);

                // Add API documentation to the result
                if (apiDocumentation && apiDocumentation.exports.length > 0) {
                  const apiMarkdown = this.enhancer.formatApiDocumentationAsMarkdown(apiDocumentation);
                  localDoc.usage = localDoc.usage ? `${localDoc.usage}\n\n${apiMarkdown}` : apiMarkdown;
                }
              }
            }
          }
        }

        return localDoc;
      }

      // If not installed, fetch from npm registry
      logger.info(`Fetching NPM documentation for ${packageName} from registry`);

      try {
        const config = getRegistryConfigForPackage(packageName, projectPath);
        const headers: Record<string, string> = {};
        if (config.token) {
          headers.Authorization = `Bearer ${config.token}`;
        }

        const versionSuffix = version ? `/${version}` : "";
        const url = `${config.registry}/${packageName}${versionSuffix}`;

        const response = await axios.get(url, { headers });
        packageInfo = response.data;

        if (packageInfo) {
          const result: DocResult = {
            description: packageInfo.description || "No description available"
          };

          // Extract usage and examples from README if available
          if (packageInfo.readme) {
            // Convert HTML to Markdown if needed
            const readme = this.enhancer.convertHtmlToMarkdown(packageInfo.readme);
            const sections = readme.split(/#+\s/);

            for (const section of sections) {
              const lower = section.toLowerCase();
              if (lower.startsWith("usage") || lower.startsWith("getting started")) {
                // Truncate usage section to a reasonable length
                const usage = section.split("\n").slice(1).join("\n").trim();
                result.usage = usage.length > 1000
                  ? usage.substring(0, 1000) + "... (truncated)"
                  : usage;
              } else if (lower.startsWith("example")) {
                // Truncate example section to a reasonable length
                const example = section.split("\n").slice(1).join("\n").trim();
                result.example = example.length > 1000
                  ? example.substring(0, 1000) + "... (truncated)"
                  : example;
              }
            }
          }

          // Fetch TypeScript definitions from unpkg.com if requested
          if (includeTypes) {
            const typesContent = await this.enhancer.fetchTypeDefinition(packageName, version);

            if (typesContent) {
              apiDocumentation = await this.enhancer.extractApiDocumentation(packageName, typesContent);

              // Add API documentation to the result
              if (apiDocumentation && apiDocumentation.exports.length > 0) {
                const apiMarkdown = this.enhancer.formatApiDocumentationAsMarkdown(apiDocumentation);
                result.usage = result.usage ? `${result.usage}\n\n${apiMarkdown}` : apiMarkdown;
              }
            }
          }

          // Fetch examples from unpkg.com if requested
          if (includeExamples) {
            examples = await this.enhancer.fetchExamples(packageName, version);

            if (examples.length > 0) {
              const examplesMarkdown = examples.map((example, index) =>
                `### Example ${index + 1}\n\n\`\`\`javascript\n${example}\n\`\`\``
              ).join("\n\n");

              result.example = result.example ? `${result.example}\n\n${examplesMarkdown}` : examplesMarkdown;
            }
          }

          return result;
        } else {
          return {
            error: `No documentation found for ${packageName} in npm registry`,
            suggestInstall: true
          };
        }
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          return {
            error: `Package ${packageName} not found. Try installing it with 'npm install ${packageName}'`,
            suggestInstall: true
          };
        }
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error getting NPM documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch NPM documentation: ${errorMessage}`
      };
    }
  }

  /**
   * Get full documentation for an NPM package
   * Enhanced to provide comprehensive information for LLMs
   */
  public async getNpmPackageDoc(
    args: NpmDocArgs,
    getRegistryConfigForPackage: (packageName: string, projectPath?: string) => NpmConfig,
    isNpmPackageInstalledLocally: (packageName: string, projectPath?: string) => boolean,
    getLocalNpmDoc: (packageName: string, projectPath?: string) => DocResult
  ): Promise<DocResult> {
    const {
      package: packageName,
      version,
      projectPath,
      section,
      maxLength = 20000,
      query,
      includeTypes = true,
      includeExamples = true
    } = args;

    logger.info(`Getting full NPM documentation for ${packageName}${version ? `@${version}` : ""}`);

    try {
      // Check if package is installed locally first
      const isInstalled = isNpmPackageInstalledLocally(packageName, projectPath);
      let packageInfo: any;
      let apiDocumentation: PackageApiDocumentation | undefined;
      let examples: string[] = [];

      if (isInstalled) {
        logger.info(`Using local documentation for ${packageName}`);
        const localDoc = getLocalNpmDoc(packageName, projectPath);

        // Try to extract TypeScript definitions from local installation
        if (includeTypes) {
          const basePath = projectPath || process.cwd();
          const packagePath = join(basePath, "node_modules", packageName);
          const packageJsonPath = join(packagePath, "package.json");

          if (existsSync(packageJsonPath)) {
            packageInfo = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

            // Check for TypeScript definitions
            if (packageInfo.types || packageInfo.typings) {
              const typesPath = join(packagePath, packageInfo.types || packageInfo.typings);

              if (existsSync(typesPath)) {
                const typesContent = readFileSync(typesPath, "utf-8");
                apiDocumentation = await this.enhancer.extractApiDocumentation(packageName, typesContent, true);
                localDoc.apiDocumentation = apiDocumentation;
              }
            }
          }
        }

        return localDoc;
      }

      // If not installed, fetch from npm registry
      logger.info(`Fetching NPM documentation for ${packageName} from registry`);

      try {
        const config = getRegistryConfigForPackage(packageName, projectPath);
        const headers: Record<string, string> = {};
        if (config.token) {
          headers.Authorization = `Bearer ${config.token}`;
        }

        const versionSuffix = version ? `/${version}` : "";
        const url = `${config.registry}/${packageName}${versionSuffix}`;

        const response = await axios.get(url, { headers });
        packageInfo = response.data;

        if (!packageInfo) {
          return {
            error: `No documentation found for ${packageName}`,
            suggestInstall: !isInstalled
          };
        }

        // Build the result
        const result: DocResult = {
          description: packageInfo.description || "No description available"
        };

        // Create a comprehensive documentation format
        let formattedDoc = `# ${packageName}\n\n`;
        formattedDoc += `${result.description}\n\n`;

        // Add version, homepage, and keywords if available
        if (packageInfo.version) {
          formattedDoc += `**Version:** ${packageInfo.version}\n\n`;
        }

        if (packageInfo.homepage) {
          formattedDoc += `**Homepage:** ${packageInfo.homepage}\n\n`;
        }

        // Add installation instructions
        formattedDoc += `## Installation\n\n\`\`\`bash\nnpm install ${packageName}\n\`\`\`\n\n`;

        // Fetch TypeScript definitions if requested
        if (includeTypes) {
          const typesContent = await this.enhancer.fetchTypeDefinition(packageName, version);

          if (typesContent) {
            apiDocumentation = await this.enhancer.extractApiDocumentation(packageName, typesContent);
            result.apiDocumentation = apiDocumentation;

            // Add API documentation to the formatted doc
            if (apiDocumentation && (apiDocumentation.exports.length > 0 || apiDocumentation.types.length > 0)) {
              formattedDoc += `## API Documentation\n\n`;

              // Add exports
              if (apiDocumentation.exports.length > 0) {
                formattedDoc += `### Exports\n\n`;

                apiDocumentation.exports.slice(0, 10).forEach(item => {
                  formattedDoc += `#### ${item.name}\n\n`;

                  if (item.description) {
                    formattedDoc += `${item.description}\n\n`;
                  }

                  if (item.signature) {
                    formattedDoc += `\`\`\`typescript\n${item.signature}\n\`\`\`\n\n`;
                  }
                });
              }

              // Add types
              if (apiDocumentation.types.length > 0) {
                formattedDoc += `### Types\n\n`;

                apiDocumentation.types.slice(0, 10).forEach(item => {
                  formattedDoc += `#### ${item.name}\n\n`;

                  if (item.description) {
                    formattedDoc += `${item.description}\n\n`;
                  }

                  if (item.typeDefinition) {
                    formattedDoc += `\`\`\`typescript\n${item.typeDefinition}\n\`\`\`\n\n`;
                  }
                });
              }
            }
          }
        }

        // Fetch examples if requested
        if (includeExamples) {
          examples = await this.enhancer.fetchExamples(packageName, version);

          if (examples.length > 0) {
            formattedDoc += `## Examples\n\n`;

            examples.forEach((example, index) => {
              formattedDoc += `### Example ${index + 1}\n\n\`\`\`javascript\n${example}\n\`\`\`\n\n`;
            });
          }
        }

        // Process README content if available
        if (packageInfo.readme) {
          // Convert HTML to Markdown if needed
          const readme = this.enhancer.convertHtmlToMarkdown(packageInfo.readme);

          // If a specific section was requested
          if (section) {
            // Try different variations of the section name for better matching
            const sectionVariations = [
              section,
              section.toLowerCase(),
              section.toUpperCase(),
              section.charAt(0).toUpperCase() + section.slice(1),
              `${section} API`,
              `${section.toUpperCase()} API`,
              `${section} api`,
              `${packageName} ${section}`,
              `${packageName}.${section}`
            ];

            let found = false;
            for (const sectionVar of sectionVariations) {
              const sectionRegex = new RegExp(`#+\\s+.*${sectionVar}.*(?:\\s|$|:)([\\s\\S]*?)(?:#+\\s+|$)`, 'i');
              const match = readme ? readme.match(sectionRegex) : null;

              if (match && match[1]) {
                result.usage = match[1].trim();
                found = true;
                break;
              }
            }

            if (!found) {
              result.error = `Section '${section}' not found in documentation`;
              // Still provide the formatted doc as usage
              result.usage = formattedDoc;
            }
          }
          // If a search query was provided
          else if (query && readme) {
            const lines = readme.split('\n');
            const matchingLines: string[] = [];
            const matchedSections: Set<number> = new Set();

            // First pass: find all matching lines
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                matchedSections.add(i);
              }
            }

            // Second pass: extract sections around matches with more context
            for (const lineIndex of matchedSections) {
              // Find the start of the section (heading)
              let sectionStart = lineIndex;
              while (sectionStart > 0 && !lines[sectionStart].startsWith('#')) {
                sectionStart--;
              }

              // Find the end of the section (next heading or end of file)
              let sectionEnd = lineIndex;
              while (sectionEnd < lines.length - 1 && !lines[sectionEnd + 1].startsWith('#')) {
                sectionEnd++;
              }

              // Extract the section with context
              const contextStart = Math.max(sectionStart, lineIndex - 10);
              const contextEnd = Math.min(sectionEnd, lineIndex + 20);

              // Add section heading if available
              if (sectionStart >= 0 && lines[sectionStart].startsWith('#')) {
                matchingLines.push(lines[sectionStart]);
              }

              // Add context lines
              matchingLines.push(...lines.slice(contextStart, contextEnd + 1), "");
            }

            if (matchingLines.length > 0) {
              const content = matchingLines.join('\n');
              result.usage = content.length > maxLength
                ? content.substring(0, maxLength) + "... (truncated)"
                : content;
            } else {
              result.error = `No matches found for '${query}' in documentation`;
              // Still provide the formatted doc as usage
              result.usage = formattedDoc;
            }
          }
          // Otherwise use our formatted documentation
          else {
            result.usage = formattedDoc;
          }
        } else {
          // If no README, use our formatted documentation
          result.usage = formattedDoc;
        }

        // Truncate if necessary
        if (result.usage && result.usage.length > maxLength) {
          result.usage = result.usage.substring(0, maxLength) + "... (truncated)";
        }

        // Always include the full formatted documentation in the result
        result.example = formattedDoc;

        // Make sure usage is populated with at least the basic information if it's empty
        if (!result.usage || result.usage.trim() === '') {
          result.usage = formattedDoc;
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Error getting full NPM documentation for ${packageName}:`, error);
        return {
          error: `Failed to fetch NPM documentation: ${errorMessage}`
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error getting full NPM documentation for ${packageName}:`, error);
      return {
        error: `Failed to fetch NPM documentation: ${errorMessage}`
      };
    }
  }
}
