import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { McpLogger } from './logger.js';

// Initialize HTML to Markdown converter with custom options
const nhm = new NodeHtmlMarkdown({
  useInlineLinks: true,
  maxConsecutiveNewlines: 2,
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
  keepDataImages: false
});

// Interface for structured API documentation
export interface ApiDocumentation {
  name: string;
  description?: string;
  type: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'namespace' | 'enum' | 'unknown';
  signature?: string;
  parameters?: ApiParameter[];
  returnType?: string;
  examples?: string[];
  properties?: ApiProperty[];
  methods?: ApiMethod[];
  typeDefinition?: string;
  isExported: boolean;
}

export interface ApiParameter {
  name: string;
  type?: string;
  description?: string;
  optional?: boolean;
  defaultValue?: string;
}

export interface ApiProperty {
  name: string;
  type?: string;
  description?: string;
  optional?: boolean;
}

export interface ApiMethod {
  name: string;
  description?: string;
  signature?: string;
  parameters?: ApiParameter[];
  returnType?: string;
}

// Interface for package API documentation
export interface PackageApiDocumentation {
  packageName: string;
  version?: string;
  description?: string;
  mainExport?: string;
  exports: ApiDocumentation[];
  types: ApiDocumentation[];
  examples?: string[];
}

export interface DocResult {
  description?: string;
  usage?: string;
  example?: string;
  error?: string;
  apiDocumentation?: PackageApiDocumentation;
}

export class NpmDocsEnhancer {
  private logger: McpLogger;

  constructor(logger: McpLogger) {
    this.logger = logger.child('NpmDocsEnhancer');
  }

  /**
   * Convert HTML content to Markdown
   */
  public convertHtmlToMarkdown(html: string): string {
    try {
      // Check if the content is HTML by looking for common HTML tags
      const hasHtmlTags = /<\/?[a-z][\s\S]*>/i.test(html);
      if (!hasHtmlTags) {
        return html; // Return as-is if it doesn't appear to be HTML
      }

      // Convert HTML to Markdown
      return nhm.translate(html);
    } catch (error) {
      this.logger.error('Error converting HTML to Markdown:', error);
      return html; // Return original content if conversion fails
    }
  }

  /**
   * Extract structured API documentation from TypeScript definition files
   */
  public async extractApiDocumentation(
    packageName: string,
    typesContent: string,
    isLocal: boolean = false
  ): Promise<PackageApiDocumentation> {
    this.logger.debug(`Extracting API documentation for ${packageName}`);

    const result: PackageApiDocumentation = {
      packageName,
      exports: [],
      types: []
    };

    try {
      // Create a virtual TypeScript program to analyze the .d.ts file
      const fileName = `${packageName}.d.ts`;
      const sourceFile = ts.createSourceFile(
        fileName,
        typesContent,
        ts.ScriptTarget.Latest,
        true
      );

      // Extract exported declarations
      this.extractDeclarations(sourceFile, result);

      return result;
    } catch (error) {
      this.logger.error(`Error extracting API documentation for ${packageName}:`, error);
      return result;
    }
  }

  /**
   * Extract declarations from TypeScript source file
   */
  private extractDeclarations(sourceFile: ts.SourceFile, result: PackageApiDocumentation): void {
    // Visit each node in the source file
    ts.forEachChild(sourceFile, (node) => {
      // Check if the node is exported
      const isExported = this.isNodeExported(node);

      if (ts.isFunctionDeclaration(node)) {
        // Extract function declaration
        const funcDoc = this.extractFunctionDeclaration(node, isExported);
        if (funcDoc) {
          if (isExported) {
            result.exports.push(funcDoc);
          } else {
            result.types.push(funcDoc);
          }
        }
      } else if (ts.isClassDeclaration(node)) {
        // Extract class declaration
        const classDoc = this.extractClassDeclaration(node, isExported);
        if (classDoc) {
          if (isExported) {
            result.exports.push(classDoc);
          } else {
            result.types.push(classDoc);
          }
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        // Extract interface declaration
        const interfaceDoc = this.extractInterfaceDeclaration(node, isExported);
        if (interfaceDoc) {
          result.types.push(interfaceDoc);
        }
      } else if (ts.isTypeAliasDeclaration(node)) {
        // Extract type alias declaration
        const typeDoc = this.extractTypeAliasDeclaration(node, isExported);
        if (typeDoc) {
          result.types.push(typeDoc);
        }
      } else if (ts.isVariableStatement(node)) {
        // Extract variable declarations
        const varDocs = this.extractVariableDeclarations(node, isExported);
        if (varDocs.length > 0) {
          if (isExported) {
            result.exports.push(...varDocs);
          } else {
            result.types.push(...varDocs);
          }
        }
      } else if (ts.isModuleDeclaration(node)) {
        // Extract namespace/module declarations
        const namespaceDoc = this.extractNamespaceDeclaration(node, isExported);
        if (namespaceDoc) {
          if (isExported) {
            result.exports.push(namespaceDoc);
          } else {
            result.types.push(namespaceDoc);
          }
        }
      } else if (ts.isEnumDeclaration(node)) {
        // Extract enum declarations
        const enumDoc = this.extractEnumDeclaration(node, isExported);
        if (enumDoc) {
          if (isExported) {
            result.exports.push(enumDoc);
          } else {
            result.types.push(enumDoc);
          }
        }
      }
    });
  }

  /**
   * Check if a node is exported
   */
  private isNodeExported(node: ts.Node): boolean {
    return (
      (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
      (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
    );
  }

  /**
   * Extract function declaration
   */
  private extractFunctionDeclaration(node: ts.FunctionDeclaration, isExported: boolean): ApiDocumentation | undefined {
    if (!node.name) return undefined;

    const name = node.name.text;
    const signature = node.getText().split('{')[0].trim();
    const parameters = node.parameters.map(param => this.extractParameter(param));
    const returnType = node.type ? node.type.getText() : 'any';

    // Extract JSDoc comments if available
    const description = this.extractJSDocComment(node);

    return {
      name,
      description,
      type: 'function',
      signature,
      parameters,
      returnType,
      isExported
    };
  }

  /**
   * Extract class declaration
   */
  private extractClassDeclaration(node: ts.ClassDeclaration, isExported: boolean): ApiDocumentation | undefined {
    if (!node.name) return undefined;

    const name = node.name.text;
    const description = this.extractJSDocComment(node);
    const methods: ApiMethod[] = [];
    const properties: ApiProperty[] = [];

    // Extract methods and properties
    node.members.forEach(member => {
      if (ts.isMethodDeclaration(member)) {
        if (member.name) {
          const methodName = member.name.getText();
          const methodSignature = member.getText().split('{')[0].trim();
          const methodParams = member.parameters.map(param => this.extractParameter(param));
          const methodReturnType = member.type ? member.type.getText() : 'any';
          const methodDescription = this.extractJSDocComment(member);

          methods.push({
            name: methodName,
            description: methodDescription,
            signature: methodSignature,
            parameters: methodParams,
            returnType: methodReturnType
          });
        }
      } else if (ts.isPropertyDeclaration(member)) {
        if (member.name) {
          const propName = member.name.getText();
          const propType = member.type ? member.type.getText() : 'any';
          const propDescription = this.extractJSDocComment(member);
          const optional = member.questionToken !== undefined;

          properties.push({
            name: propName,
            type: propType,
            description: propDescription,
            optional
          });
        }
      }
    });

    return {
      name,
      description,
      type: 'class',
      methods,
      properties,
      isExported
    };
  }

  /**
   * Extract interface declaration
   */
  private extractInterfaceDeclaration(node: ts.InterfaceDeclaration, isExported: boolean): ApiDocumentation | undefined {
    const name = node.name.text;
    const description = this.extractJSDocComment(node);
    const properties: ApiProperty[] = [];

    // Extract properties
    node.members.forEach(member => {
      if (ts.isPropertySignature(member)) {
        if (member.name) {
          const propName = member.name.getText();
          const propType = member.type ? member.type.getText() : 'any';
          const propDescription = this.extractJSDocComment(member);
          const optional = member.questionToken !== undefined;

          properties.push({
            name: propName,
            type: propType,
            description: propDescription,
            optional
          });
        }
      } else if (ts.isMethodSignature(member)) {
        if (member.name) {
          const methodName = member.name.getText();
          const methodSignature = member.getText().trim();
          const methodParams = member.parameters.map(param => this.extractParameter(param));
          const methodReturnType = member.type ? member.type.getText() : 'any';
          const methodDescription = this.extractJSDocComment(member);

          properties.push({
            name: `${methodName}()`,
            type: `(${methodParams.map(p => `${p.name}: ${p.type}`).join(', ')}) => ${methodReturnType}`,
            description: methodDescription,
            optional: false
          });
        }
      }
    });

    return {
      name,
      description,
      type: 'interface',
      properties,
      typeDefinition: node.getText(),
      isExported
    };
  }

  /**
   * Extract type alias declaration
   */
  private extractTypeAliasDeclaration(node: ts.TypeAliasDeclaration, isExported: boolean): ApiDocumentation | undefined {
    const name = node.name.text;
    const description = this.extractJSDocComment(node);
    const typeDefinition = node.getText();

    return {
      name,
      description,
      type: 'type',
      typeDefinition,
      isExported
    };
  }

  /**
   * Extract variable declarations
   */
  private extractVariableDeclarations(node: ts.VariableStatement, isExported: boolean): ApiDocumentation[] {
    const result: ApiDocumentation[] = [];
    const description = this.extractJSDocComment(node);

    node.declarationList.declarations.forEach(declaration => {
      if (declaration.name && ts.isIdentifier(declaration.name)) {
        const name = declaration.name.text;
        const type = declaration.type ? declaration.type.getText() : 'any';

        result.push({
          name,
          description,
          type: 'variable',
          typeDefinition: type,
          isExported
        });
      }
    });

    return result;
  }

  /**
   * Extract namespace declaration
   */
  private extractNamespaceDeclaration(node: ts.ModuleDeclaration, isExported: boolean): ApiDocumentation | undefined {
    if (!node.name || !ts.isIdentifier(node.name)) return undefined;

    const name = node.name.text;
    const description = this.extractJSDocComment(node);

    return {
      name,
      description,
      type: 'namespace',
      isExported
    };
  }

  /**
   * Extract enum declaration
   */
  private extractEnumDeclaration(node: ts.EnumDeclaration, isExported: boolean): ApiDocumentation | undefined {
    const name = node.name.text;
    const description = this.extractJSDocComment(node);
    const properties: ApiProperty[] = [];

    // Extract enum members
    node.members.forEach(member => {
      if (member.name) {
        const memberName = member.name.getText();
        const memberDescription = this.extractJSDocComment(member);

        properties.push({
          name: memberName,
          description: memberDescription,
          optional: false
        });
      }
    });

    return {
      name,
      description,
      type: 'enum',
      properties,
      isExported
    };
  }

  /**
   * Extract parameter information
   */
  private extractParameter(param: ts.ParameterDeclaration): ApiParameter {
    const name = param.name.getText();
    const type = param.type ? param.type.getText() : 'any';
    const optional = param.questionToken !== undefined || param.initializer !== undefined;
    const defaultValue = param.initializer ? param.initializer.getText() : undefined;

    return {
      name,
      type,
      optional,
      defaultValue
    };
  }

  /**
   * Extract JSDoc comments
   */
  private extractJSDocComment(node: ts.Node): string | undefined {
    const jsDocTags = ts.getJSDocTags(node);
    if (jsDocTags.length === 0) return undefined;

    const comments: string[] = [];

    jsDocTags.forEach(tag => {
      if (tag.comment) {
        const tagName = tag.tagName ? tag.tagName.text : '';
        const comment = typeof tag.comment === 'string' ? tag.comment : tag.comment.map(c => c.text).join(' ');

        if (tagName) {
          comments.push(`@${tagName} ${comment}`);
        } else {
          comments.push(comment);
        }
      }
    });

    return comments.join('\n');
  }

  /**
   * Fetch TypeScript definition file from unpkg.com
   */
  public async fetchTypeDefinition(packageName: string, version?: string): Promise<string | undefined> {
    try {
      this.logger.debug(`Fetching TypeScript definition for ${packageName}${version ? `@${version}` : ""}`);

      // First, try to get package.json to find the types field
      const packageJsonUrl = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/package.json`;
      const packageJsonResponse = await axios.get(packageJsonUrl);

      if (packageJsonResponse.data) {
        const typesField = packageJsonResponse.data.types || packageJsonResponse.data.typings;

        if (typesField) {
          // Fetch the types file
          const typesUrl = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/${typesField}`;
          const typesResponse = await axios.get(typesUrl);

          if (typesResponse.data) {
            return typesResponse.data;
          }
        }
      }

      // If no types field, try common locations
      const commonTypesPaths = [
        'index.d.ts',
        'dist/index.d.ts',
        'lib/index.d.ts',
        'types/index.d.ts',
        `${packageName}.d.ts`
      ];

      for (const path of commonTypesPaths) {
        try {
          const url = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/${path}`;
          const response = await axios.get(url);

          if (response.data) {
            return response.data;
          }
        } catch (error) {
          // Continue to next path
        }
      }

      // If still not found, try to get the @types package
      try {
        const typesPackageUrl = `https://unpkg.com/@types/${packageName}/index.d.ts`;
        const typesPackageResponse = await axios.get(typesPackageUrl);

        if (typesPackageResponse.data) {
          return typesPackageResponse.data;
        }
      } catch (error) {
        // No @types package found
      }

      return undefined;
    } catch (error) {
      this.logger.error(`Error fetching TypeScript definition for ${packageName}:`, error);
      return undefined;
    }
  }

  /**
   * Fetch example code from unpkg.com
   */
  public async fetchExamples(packageName: string, version?: string): Promise<string[]> {
    try {
      this.logger.debug(`Fetching examples for ${packageName}${version ? `@${version}` : ""}`);

      const examples: string[] = [];

      // Try to fetch examples from common locations
      const commonExamplePaths = [
        'examples/',
        'example/',
        'docs/examples/',
        'demo/'
      ];

      for (const path of commonExamplePaths) {
        try {
          const url = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/${path}`;
          const response = await axios.get(url);

          if (response.data) {
            // If it's a directory listing, try to find JavaScript or TypeScript files
            if (typeof response.data === 'string' && response.data.includes('<html>')) {
              // This is likely a directory listing, try to extract file links
              const fileLinks = response.data.match(/href="([^"]+\.(js|ts))"/g);

              if (fileLinks && fileLinks.length > 0) {
                // Get up to 3 example files
                for (let i = 0; i < Math.min(3, fileLinks.length); i++) {
                  const fileMatch = fileLinks[i].match(/href="([^"]+)"/);
                  if (fileMatch && fileMatch[1]) {
                    const fileName = fileMatch[1];
                    const fileUrl = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/${path}${fileName}`;

                    try {
                      const fileResponse = await axios.get(fileUrl);
                      if (fileResponse.data) {
                        examples.push(`// Example: ${fileName}\n${fileResponse.data}`);
                      }
                    } catch (error) {
                      // Skip this file
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          // Continue to next path
        }
      }

      // If no examples found in dedicated directories, try to extract from README
      if (examples.length === 0) {
        try {
          const readmeUrl = `https://unpkg.com/${packageName}${version ? `@${version}` : ""}/README.md`;
          const readmeResponse = await axios.get(readmeUrl);

          if (readmeResponse.data) {
            const readme = readmeResponse.data;
            const codeBlocks = readme.match(/```(?:js|javascript|typescript)[\s\S]*?```/g);

            if (codeBlocks && codeBlocks.length > 0) {
              // Get up to 3 code examples
              for (let i = 0; i < Math.min(3, codeBlocks.length); i++) {
                const codeBlock = codeBlocks[i].replace(/```(?:js|javascript|typescript)\n/, '').replace(/```$/, '');
                examples.push(`// Example ${i + 1} from README\n${codeBlock}`);
              }
            }
          }
        } catch (error) {
          // No README found
        }
      }

      return examples;
    } catch (error) {
      this.logger.error(`Error fetching examples for ${packageName}:`, error);
      return [];
    }
  }

  /**
   * Format API documentation as markdown
   */
  public formatApiDocumentationAsMarkdown(apiDoc: PackageApiDocumentation): string {
    let markdown = `# ${apiDoc.packageName} API Documentation\n\n`;

    if (apiDoc.description) {
      markdown += `${apiDoc.description}\n\n`;
    }

    if (apiDoc.version) {
      markdown += `**Version:** ${apiDoc.version}\n\n`;
    }

    // Add exported items
    if (apiDoc.exports.length > 0) {
      markdown += `## Exports\n\n`;

      apiDoc.exports.forEach(item => {
        markdown += this.formatApiItemAsMarkdown(item);
      });
    }

    // Add types
    if (apiDoc.types.length > 0) {
      markdown += `## Types\n\n`;

      apiDoc.types.forEach(item => {
        markdown += this.formatApiItemAsMarkdown(item);
      });
    }

    // Add examples
    if (apiDoc.examples && apiDoc.examples.length > 0) {
      markdown += `## Examples\n\n`;

      apiDoc.examples.forEach((example, index) => {
        markdown += `### Example ${index + 1}\n\n\`\`\`javascript\n${example}\n\`\`\`\n\n`;
      });
    }

    return markdown;
  }

  /**
   * Format API item as markdown
   */
  private formatApiItemAsMarkdown(item: ApiDocumentation): string {
    let markdown = `### ${item.name}\n\n`;

    if (item.description) {
      markdown += `${item.description}\n\n`;
    }

    if (item.type === 'function') {
      markdown += `**Type:** Function\n\n`;

      if (item.signature) {
        markdown += `**Signature:**\n\`\`\`typescript\n${item.signature}\n\`\`\`\n\n`;
      }

      if (item.parameters && item.parameters.length > 0) {
        markdown += `**Parameters:**\n\n`;

        item.parameters.forEach(param => {
          markdown += `- \`${param.name}${param.optional ? '?' : ''}: ${param.type || 'any'}\``;
          if (param.defaultValue) {
            markdown += ` (default: ${param.defaultValue})`;
          }
          if (param.description) {
            markdown += ` - ${param.description}`;
          }
          markdown += `\n`;
        });

        markdown += `\n`;
      }

      if (item.returnType) {
        markdown += `**Returns:** \`${item.returnType}\`\n\n`;
      }
    } else if (item.type === 'class') {
      markdown += `**Type:** Class\n\n`;

      if (item.properties && item.properties.length > 0) {
        markdown += `**Properties:**\n\n`;

        item.properties.forEach(prop => {
          markdown += `- \`${prop.name}${prop.optional ? '?' : ''}: ${prop.type || 'any'}\``;
          if (prop.description) {
            markdown += ` - ${prop.description}`;
          }
          markdown += `\n`;
        });

        markdown += `\n`;
      }

      if (item.methods && item.methods.length > 0) {
        markdown += `**Methods:**\n\n`;

        item.methods.forEach(method => {
          markdown += `#### ${method.name}\n\n`;

          if (method.description) {
            markdown += `${method.description}\n\n`;
          }

          if (method.signature) {
            markdown += `**Signature:**\n\`\`\`typescript\n${method.signature}\n\`\`\`\n\n`;
          }

          if (method.parameters && method.parameters.length > 0) {
            markdown += `**Parameters:**\n\n`;

            method.parameters.forEach(param => {
              markdown += `- \`${param.name}${param.optional ? '?' : ''}: ${param.type || 'any'}\``;
              if (param.defaultValue) {
                markdown += ` (default: ${param.defaultValue})`;
              }
              if (param.description) {
                markdown += ` - ${param.description}`;
              }
              markdown += `\n`;
            });

            markdown += `\n`;
          }

          if (method.returnType) {
            markdown += `**Returns:** \`${method.returnType}\`\n\n`;
          }
        });
      }
    } else if (item.type === 'interface' || item.type === 'type') {
      markdown += `**Type:** ${item.type === 'interface' ? 'Interface' : 'Type'}\n\n`;

      if (item.typeDefinition) {
        markdown += `**Definition:**\n\`\`\`typescript\n${item.typeDefinition}\n\`\`\`\n\n`;
      }

      if (item.properties && item.properties.length > 0) {
        markdown += `**Properties:**\n\n`;

        item.properties.forEach(prop => {
          markdown += `- \`${prop.name}${prop.optional ? '?' : ''}: ${prop.type || 'any'}\``;
          if (prop.description) {
            markdown += ` - ${prop.description}`;
          }
          markdown += `\n`;
        });

        markdown += `\n`;
      }
    } else if (item.type === 'enum') {
      markdown += `**Type:** Enum\n\n`;

      if (item.properties && item.properties.length > 0) {
        markdown += `**Values:**\n\n`;

        item.properties.forEach(prop => {
          markdown += `- \`${prop.name}\``;
          if (prop.description) {
            markdown += ` - ${prop.description}`;
          }
          markdown += `\n`;
        });

        markdown += `\n`;
      }
    }

    return markdown;
  }
}
