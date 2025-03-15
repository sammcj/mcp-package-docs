import { McpLogger } from './logger.js'

export interface DocResult {
  description?: string
  usage?: string
  example?: string
  error?: string
  searchResults?: SearchResults
  suggestInstall?: boolean // Flag to indicate if we should suggest package installation
}

export interface SearchResults {
  results: SearchResult[]
  totalResults: number
  error?: string
  suggestInstall?: boolean
}

export interface SearchResult {
  symbol?: string
  match: string
  context?: string // Make context optional to save space
  score: number
  type?: string // Type of the section (function, class, etc.)
}

export interface SearchDocArgs {
  package: string
  query: string
  language: "go" | "python" | "npm" | "swift" | "rust"
  fuzzy?: boolean
  projectPath?: string
}

export const isSearchDocArgs = (args: unknown): args is SearchDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as SearchDocArgs).package === "string" &&
    typeof (args as SearchDocArgs).query === "string" &&
    ["go", "python", "npm", "swift", "rust"].includes((args as SearchDocArgs).language) &&
    (typeof (args as SearchDocArgs).fuzzy === "boolean" ||
      (args as SearchDocArgs).fuzzy === undefined) &&
    (typeof (args as SearchDocArgs).projectPath === "string" ||
      (args as SearchDocArgs).projectPath === undefined)
  )
}

export interface GoDocArgs {
  package: string
  symbol?: string
  projectPath?: string
}

export interface PythonDocArgs {
  package: string
  symbol?: string
  projectPath?: string
}

export interface NpmDocArgs {
  package: string
  version?: string
  projectPath?: string
  section?: string
  maxLength?: number
  query?: string
}

export interface SwiftDocArgs {
  package: string
  symbol?: string
  projectPath?: string
}

export const isGoDocArgs = (args: unknown): args is GoDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as GoDocArgs).package === "string" &&
    (typeof (args as GoDocArgs).symbol === "string" ||
      (args as GoDocArgs).symbol === undefined) &&
    (typeof (args as GoDocArgs).projectPath === "string" ||
      (args as GoDocArgs).projectPath === undefined)
  )
}

export const isSwiftDocArgs = (args: unknown): args is SwiftDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as SwiftDocArgs).package === "string" &&
    (typeof (args as SwiftDocArgs).symbol === "string" ||
      (args as SwiftDocArgs).symbol === undefined) &&
    (typeof (args as SwiftDocArgs).projectPath === "string" ||
      (args as SwiftDocArgs).projectPath === undefined)
  )
}

export const isPythonDocArgs = (args: unknown): args is PythonDocArgs => {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as PythonDocArgs).package === "string" &&
    (typeof (args as PythonDocArgs).symbol === "string" ||
      (args as PythonDocArgs).symbol === undefined) &&
    (typeof (args as PythonDocArgs).projectPath === "string" ||
      (args as PythonDocArgs).projectPath === undefined)
  )
}

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
      (args as NpmDocArgs).query === undefined)
  )
}

export class SearchUtils {
  private logger: McpLogger

  constructor(logger: McpLogger) {
    this.logger = logger.child('SearchUtils')
  }

  /**
   * Simple fuzzy matching algorithm
   */
  public fuzzyMatch(text: string, pattern: string): boolean {
    const textLower = text.toLowerCase()
    const patternLower = pattern.toLowerCase()

    let textIndex = 0
    let patternIndex = 0

    while (textIndex < text.length && patternIndex < pattern.length) {
      if (textLower[textIndex] === patternLower[patternIndex]) {
        patternIndex++
      }
      textIndex++
    }

    return patternIndex === pattern.length
  }

  /**
   * Extract symbol from text based on language
   */
  public extractSymbol(text: string, language: string): string | undefined {
    const firstLine = text.split('\n')[0]
    switch (language) {
      case "go": {
        const goMatch = firstLine.match(/^(func|type|var|const)\s+(\w+)/)
        return goMatch?.[2]
      }
      case "python": {
        const pyMatch = firstLine.match(/^(class|def)\s+(\w+)/)
        return pyMatch?.[2]
      }
      case "npm": {
        // Extract symbol from markdown headings or code blocks
        const npmMatch = firstLine.match(/^#+\s*(?:`([^`]+)`|(\w+))/)
        return npmMatch?.[1] || npmMatch?.[2]
      }
      case "swift": {
        const swiftMatch = firstLine.match(/^(class|struct|enum|protocol|func|var|let)\s+(\w+)/)
        return swiftMatch?.[2]
      }
      case "rust": {
        const rustMatch = firstLine.match(/^(pub\s+)?(struct|enum|trait|impl|fn|mod|type)\s+(\w+)/)
        return rustMatch?.[3]
      }
      default:
        return undefined
    }
  }

  /**
   * Parse Go documentation into sections
   */
  public parseGoDoc(doc: string): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = []
    let currentSection = ''
    let currentType = 'description'

    const lines = doc.split('\n')
    for (const line of lines) {
      if (line.startsWith('func ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'function'
      } else if (line.startsWith('type ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'type'
      } else if (line.startsWith('var ') || line.startsWith('const ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'variable'
      } else {
        currentSection += '\n' + line
      }
    }

    if (currentSection) {
      sections.push({ content: currentSection.trim(), type: currentType })
    }

    return sections
  }

  /**
   * Parse Python documentation into sections
   */
  public parsePythonDoc(doc: string): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = []
    let currentSection = ''
    let currentType = 'description'

    const lines = doc.split('\n')
    for (const line of lines) {
      if (line.startsWith('class ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'class'
      } else if (line.startsWith('def ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'function'
      } else if (line.match(/^[A-Z_]+\s*=/)) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'constant'
      } else {
        currentSection += '\n' + line
      }
    }

    if (currentSection) {
      sections.push({ content: currentSection.trim(), type: currentType })
    }

    return sections
  }

  /**
   * Parse Swift documentation into sections
   */
  public parseSwiftDoc(doc: string): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = []
    let currentSection = ''
    let currentType = 'description'

    const lines = doc.split('\n')
    for (const line of lines) {
      if (line.startsWith('class ') || line.startsWith('struct ') || line.startsWith('enum ') || line.startsWith('protocol ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'type'
      } else if (line.startsWith('func ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'function'
      } else if (line.startsWith('var ') || line.startsWith('let ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'property'
      } else if (line.startsWith('extension ')) {
        if (currentSection) {
          sections.push({ content: currentSection.trim(), type: currentType })
        }
        currentSection = line
        currentType = 'extension'
      } else {
        currentSection += '\n' + line
      }
    }

    if (currentSection) {
      sections.push({ content: currentSection.trim(), type: currentType })
    }

    return sections
  }

  /**
   * Parse NPM documentation into sections
   */
  public parseNpmDoc(data: { description?: string; readme?: string }): Array<{ content: string; type: string }> {
    const sections: Array<{ content: string; type: string }> = []

    // Add package description
    if (data.description) {
      sections.push({
        content: data.description,
        type: 'description'
      })
    }

    // Parse README into sections
    if (data.readme) {
      const readmeSections = data.readme.split(/(?=^#+ )/m)
      for (const section of readmeSections) {
        const lines = section.split('\n')
        const heading = lines[0]
        const content = lines.slice(1).join('\n').trim()

        if (content) {
          // Skip sections that are likely not useful for coding
          const lowerHeading = heading.toLowerCase()
          if (
            lowerHeading.includes('sponsor') ||
            lowerHeading.includes('author') ||
            lowerHeading.includes('contributor') ||
            lowerHeading.includes('license') ||
            lowerHeading.includes('changelog') ||
            lowerHeading.includes('people') ||
            lowerHeading.includes('community') ||
            lowerHeading.includes('triager') ||
            lowerHeading.includes('tc ') ||
            lowerHeading.includes('committee') ||
            lowerHeading.includes('security') ||
            lowerHeading.includes('test') ||
            lowerHeading.includes('contributing')
          ) {
            continue
          }

          let type = 'general'
          if (lowerHeading.includes('install')) type = 'installation'
          else if (lowerHeading.includes('usage') || lowerHeading.includes('api')) type = 'usage'
          else if (lowerHeading.includes('example')) type = 'example'
          else if (lowerHeading.includes('config')) type = 'configuration'
          else if (lowerHeading.includes('method') || lowerHeading.includes('function')) type = 'api'
          else if (lowerHeading.includes('quick start')) type = 'quickstart'
          else if (lowerHeading.includes('getting started')) type = 'quickstart'

          sections.push({
            content: `${heading}\n${content}`,
            type
          })
        }
      }
    }

    return sections
  }

  /**
   * Extract documentation sections from README content
   * Identifies and extracts key sections like usage, API, examples, etc.
   */
  public extractDocSections(readme: string): {
    usage: string
    api: string
    examples: string
    configuration: string
    other: Record<string, string>
  } {
    const result = {
      usage: '',
      api: '',
      examples: '',
      configuration: '',
      other: {} as Record<string, string>
    }

    // Split the readme into sections based on headings
    const sections = readme.split(/(?=^#+\s+)/m)

    // Process each section
    for (const section of sections) {
      if (!section.trim()) continue

      const lines = section.split('\n')
      const heading = lines[0].toLowerCase()
      const content = lines.slice(1).join('\n').trim()

      if (!content) continue

      // Skip sections that are likely not useful for coding
      if (
        heading.includes('sponsor') ||
        heading.includes('author') ||
        heading.includes('contributor') ||
        heading.includes('license') ||
        heading.includes('changelog') ||
        heading.includes('people') ||
        heading.includes('community') ||
        heading.includes('triager') ||
        heading.includes('tc ') ||
        heading.includes('committee') ||
        heading.includes('security') ||
        heading.includes('test') ||
        heading.includes('contributing') ||
        heading.includes('badge') ||
        heading.includes('build status') ||
        heading.includes('coverage') ||
        heading.includes('donate')
      ) {
        continue
      }

      // Categorize the section based on its heading
      if (
        heading.includes('usage') ||
        heading.includes('getting started') ||
        heading.includes('quick start')
      ) {
        result.usage = content
      }
      else if (
        heading.includes('api') ||
        heading.includes('method') ||
        heading.includes('function') ||
        heading.includes('class') ||
        heading.includes('interface') ||
        heading.includes('request config') ||
        heading.includes('response schema') ||
        heading.includes('config defaults') ||
        heading.includes('interceptors')
      ) {
        // If we already have API content, append this section
        if (result.api) {
          result.api += '\n\n## ' + lines[0].replace(/^#+\s+/, '') + '\n\n' + content
        } else {
          result.api = content
        }
      }
      else if (
        heading.includes('example') ||
        heading.includes('demo')
      ) {
        // If we already have examples content, append this section
        if (result.examples) {
          result.examples += '\n\n## ' + lines[0].replace(/^#+\s+/, '') + '\n\n' + content
        } else {
          result.examples = content
        }
      }
      else if (
        heading.includes('config') ||
        heading.includes('option') ||
        heading.includes('setting')
      ) {
        result.configuration = content
      }
      // Store other potentially useful sections
      else if (
        heading.includes('feature') ||
        heading.includes('overview') ||
        heading.includes('guide') ||
        heading.includes('tutorial') ||
        heading.includes('how to') ||
        heading.includes('advanced') ||
        heading.includes('request') ||
        heading.includes('response') ||
        heading.includes('error') ||
        heading.includes('handling') ||
        heading.includes('interceptor') ||
        heading.includes('middleware') ||
        heading.includes('plugin')
      ) {
        // Extract section name from heading (remove # characters)
        const sectionName = lines[0].replace(/^#+\s+/, '')
        result.other[sectionName] = content
      }
    }

    // If we couldn't find API sections by heading, try to find them by content
    if (!result.api) {
      // Look for code blocks that might contain API usage
      const apiCodeBlocks = readme.match(/```(?:js|javascript)[\s\S]*?axios\.(?:get|post|put|delete|patch|request)[\s\S]*?```/g)
      if (apiCodeBlocks && apiCodeBlocks.length > 0) {
        result.api = "## API Usage Examples\n\n" + apiCodeBlocks.slice(0, 3).join('\n\n')
      }

      // Look for sections that might describe request/response objects
      if (readme.includes('axios.request(config)') || readme.includes('axios(config)')) {
        const configSection = readme.match(/(?:Request|Config) (?:Config|Options)[\s\S]*?```[\s\S]*?```/i)
        if (configSection) {
          result.api += "\n\n## Request Config\n\n" + configSection[0]
        }
      }
    }

    return result
  }

  /**
   * Extract only the most relevant content from a README for coding purposes
   */
  public extractRelevantContent(readme: string): string {
    this.logger.debug("Extracting relevant content from README")

    // First, remove all badge links and reference-style links
    const cleanedReadme = readme
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '') // Remove badge links
      .replace(/\[[^\]]*\]:\s*https?:\/\/[^\s]+/g, '')    // Remove reference links

    // Split the readme into sections
    const sections = cleanedReadme.split(/(?=^#+ )/m)
    this.logger.debug(`Found ${sections.length} sections in README`)

    // Always include the first code example if it exists
    const firstCodeExample = readme.match(/```[\s\S]*?```/)
    let hasIncludedCodeExample = false

    const relevantSections: string[] = []

    // Process the content before any headings (intro)
    if (sections.length > 0 && !sections[0].startsWith('#')) {
      // Include the intro section, but limit to first few paragraphs
      const introParagraphs = sections[0].split('\n\n')
      const introContent = introParagraphs.slice(0, Math.min(3, introParagraphs.length)).join('\n\n')
      if (introContent.trim()) {
        relevantSections.push(introContent.trim())
        this.logger.debug("Added intro section")
      }

      // If there's a code example in the intro, include it
      if (firstCodeExample && sections[0].includes(firstCodeExample[0])) {
        hasIncludedCodeExample = true
      }
    }

    // Define keywords for sections we want to keep
    const usefulKeywords = [
      'install', 'usage', 'api', 'example', 'quick start', 'getting started',
      'guide', 'method', 'function', 'config', 'option', 'feature', 'overview',
      'basic', 'tutorial', 'how to'
    ]

    // Define keywords for sections we want to skip
    const skipKeywords = [
      'sponsor', 'author', 'contributor', 'license', 'changelog', 'people',
      'community', 'triager', 'tc ', 'committee', 'security', 'test',
      'contributing', 'badge', 'build status', 'coverage', 'donate',
      'acknowledgement', 'credit', 'support', 'backers', 'funding'
    ]

    // Process each section with a heading
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]
      if (!section.startsWith('#')) continue

      const lines = section.split('\n')
      const heading = lines[0].toLowerCase()

      // Skip sections that are likely not useful for coding
      let shouldSkip = false
      for (const keyword of skipKeywords) {
        if (heading.includes(keyword)) {
          shouldSkip = true
          break
        }
      }
      if (shouldSkip) {
        this.logger.debug(`Skipping section: ${heading}`)
        continue
      }

      // Include sections that are likely useful for coding
      let shouldInclude = false
      for (const keyword of usefulKeywords) {
        if (heading.includes(keyword)) {
          shouldInclude = true
          this.logger.debug(`Including section due to keyword match: ${heading} (matched: ${keyword})`)
          break
        }
      }

      // Also include sections with code examples even if they don't match keywords
      if (!shouldInclude && section.includes('```')) {
        shouldInclude = true
        this.logger.debug(`Including section due to code example: ${heading}`)
      }

      // If this is a short section with a simple heading (likely important), include it
      if (!shouldInclude && section.length < 500 && heading.split(' ').length <= 3) {
        shouldInclude = true
        this.logger.debug(`Including short section with simple heading: ${heading}`)
      }

      if (shouldInclude) {
        relevantSections.push(section)
      }
    }

    // If we didn't find any relevant sections with headings, be less strict
    if (relevantSections.length <= 1) {
      this.logger.debug("Few relevant sections found, being less strict")

      // Include any section with a code example
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        if (!section.startsWith('#')) continue

        if (section.includes('```') && !relevantSections.includes(section)) {
          relevantSections.push(section)
          this.logger.debug(`Added section with code example`)
        }
      }

      // If still no sections, include the first few sections regardless
      if (relevantSections.length <= 1) {
        for (let i = 0; i < Math.min(3, sections.length); i++) {
          if (sections[i].startsWith('#') && !relevantSections.includes(sections[i])) {
            relevantSections.push(sections[i])
            this.logger.debug(`Added section ${i} as fallback`)
          }
        }
      }
    }

    // If we still don't have any code examples, add the first one we found
    if (!hasIncludedCodeExample && firstCodeExample) {
      relevantSections.push(`## Code Example\n\n${firstCodeExample[0]}`)
      this.logger.debug("Added first code example")
    }

    // If we still have nothing, just return a portion of the original README
    if (relevantSections.length === 0) {
      this.logger.debug("No relevant sections found, returning truncated README")
      // Return the first 2000 characters of the README
      return readme.substring(0, 2000) + "... (truncated)"
    }

    // Join the relevant sections
    let content = relevantSections.join('\n\n')

    // Remove any remaining badge links or reference links that might be in the content
    content = content
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
      .replace(/\[[^\]]*\]:\s*https?:\/\/[^\s]+/g, '')

    this.logger.debug(`Extracted ${content.length} characters of relevant content`)

    return content
  }
}
