import * as cheerio from "cheerio";
import turndown from "turndown";
import {
	CrateInfo,
	CrateSearchResult,
	CrateVersion,
	FeatureFlag,
	RustType,
	SearchOptions,
	SymbolDefinition,
} from "./types.js";
import rustHttpClient from "./utils/rust-http-client.js";
import { McpLogger } from './logger.js'

const turndownInstance = new turndown();

export class RustDocsHandler {
  private logger: McpLogger;

  constructor(logger: McpLogger) {
    this.logger = logger.child('RustDocs')
  }

  /**
   * Search for crates on crates.io
   */
  async searchCrates(
    options: SearchOptions,
  ): Promise<CrateSearchResult> {
    try {
      this.logger.info(`searching for crates with query: ${options.query}`);

      const response = await rustHttpClient.cratesIoFetch("crates", {
        params: {
          q: options.query,
          page: options.page || 1,
          per_page: options.perPage || 10,
        },
      });

      if (response.contentType !== "json") {
        throw new Error("Expected JSON response but got text");
      }

      const data = response.data as {
        crates: Array<{
          name: string;
          max_version: string;
          description?: string;
        }>;
        meta: {
          total: number;
        };
      };

      const crates: CrateInfo[] = data.crates.map((crate) => ({
        name: crate.name,
        version: crate.max_version,
        description: crate.description,
      }));

      return {
        crates,
        totalCount: data.meta.total,
      };
    } catch (error) {
      this.logger.error("error searching for crates", { error });
      throw new Error(`failed to search for crates: ${(error as Error).message}`);
    }
  }

  /**
   * Get detailed information about a crate from crates.io
   */
  async getCrateDetails(crateName: string): Promise<{
    name: string;
    description?: string;
    versions: CrateVersion[];
    downloads: number;
    homepage?: string;
    repository?: string;
    documentation?: string;
  }> {
    try {
      this.logger.info(`getting crate details for: ${crateName}`);

      const response = await rustHttpClient.cratesIoFetch(`crates/${crateName}`);

      if (response.contentType !== "json") {
        throw new Error("Expected JSON response but got text");
      }

      const data = response.data as {
        crate: {
          name: string;
          description?: string;
          downloads: number;
          homepage?: string;
          repository?: string;
          documentation?: string;
        };
        versions: Array<{
          num: string;
          yanked: boolean;
          created_at: string;
        }>;
      };

      return {
        name: data.crate.name,
        description: data.crate.description,
        downloads: data.crate.downloads,
        homepage: data.crate.homepage,
        repository: data.crate.repository,
        documentation: data.crate.documentation,
        versions: data.versions.map((v) => ({
          version: v.num,
          isYanked: v.yanked,
          releaseDate: v.created_at,
        })),
      };
    } catch (error) {
      this.logger.error(`error getting crate details for: ${crateName}`, { error });
      throw new Error(
        `failed to get crate details for ${crateName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get documentation for a specific crate from docs.rs
   */
  async getCrateDocumentation(
    crateName: string,
    version?: string,
  ): Promise<string> {
    try {
      this.logger.info(
        `getting documentation for crate: ${crateName}${version ? ` version ${version}` : ""}`,
      );

      const path = version
        ? `crate/${crateName}/${version}`
        : `crate/${crateName}/latest`;

      const response = await rustHttpClient.docsRsFetch(path);

      if (response.contentType !== "text") {
        throw new Error("Expected HTML response but got JSON");
      }

      return turndownInstance.turndown(response.data);
    } catch (error) {
      this.logger.error(`error getting documentation for crate: ${crateName}`, {
        error,
      });
      throw new Error(
        `failed to get documentation for crate ${crateName}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get type information for a specific item in a crate
   */
  async getTypeInfo(
    crateName: string,
    path: string,
    version?: string,
  ): Promise<RustType> {
    try {
      this.logger.info(`Getting type info for ${path} in crate: ${crateName}`);

      const versionPath = version || "latest";
      const fullPath = `${crateName}/${versionPath}/${crateName}/${path}`;

      const response = await rustHttpClient.docsRsFetch(fullPath);

      if (response.contentType !== "text") {
        throw new Error("Expected HTML response but got JSON");
      }

      const $ = cheerio.load(response.data);

      // Determine the kind of type
      let kind: RustType["kind"] = "other";
      if ($(".struct").length) kind = "struct";
      else if ($(".enum").length) kind = "enum";
      else if ($(".trait").length) kind = "trait";
      else if ($(".fn").length) kind = "function";
      else if ($(".macro").length) kind = "macro";
      else if ($(".typedef").length) kind = "type";
      else if ($(".mod").length) kind = "module";

      // Get description
      const description = $(".docblock").first().text().trim();

      // Get source URL if available
      const sourceUrl = $(".src-link a").attr("href");

      const name = path.split("/").pop() || path;

      return {
        name,
        kind,
        path,
        description: description || undefined,
        sourceUrl: sourceUrl || undefined,
        documentationUrl: `https://docs.rs${fullPath}`,
      };
    } catch (error) {
      this.logger.error(`Error getting type info for ${path} in crate: ${crateName}`, {
        error,
      });
      throw new Error(`Failed to get type info: ${(error as Error).message}`);
    }
  }

  /**
   * Get feature flags for a crate
   */
  async getFeatureFlags(
    crateName: string,
    version?: string,
  ): Promise<FeatureFlag[]> {
    try {
      this.logger.info(`Getting feature flags for crate: ${crateName}`);

      const versionPath = version || "latest";
      const response = await rustHttpClient.docsRsFetch(
        `/crate/${crateName}/${versionPath}/features`,
      );

      if (response.contentType !== "text") {
        throw new Error("Expected HTML response but got JSON");
      }

      const $ = cheerio.load(response.data);
      const features: FeatureFlag[] = [];

      $(".feature").each((_: number, element: any) => {
        const name = $(element).find(".feature-name").text().trim();
        const description = $(element).find(".feature-description").text().trim();
        const enabled = $(element).hasClass("feature-enabled");

        features.push({
          name,
          description: description || undefined,
          enabled,
        });
      });

      return features;
    } catch (error) {
      this.logger.error(`Error getting feature flags for crate: ${crateName}`, {
        error,
      });
      throw new Error(`Failed to get feature flags: ${(error as Error).message}`);
    }
  }

  /**
   * Get available versions for a crate from crates.io
   */
  async getCrateVersions(
    crateName: string,
  ): Promise<CrateVersion[]> {
    try {
      this.logger.info(`getting versions for crate: ${crateName}`);

      const response = await rustHttpClient.cratesIoFetch(`crates/${crateName}`);

      if (response.contentType !== "json") {
        throw new Error("Expected JSON response but got text");
      }

      const data = response.data as {
        versions: Array<{
          num: string;
          yanked: boolean;
          created_at: string;
        }>;
      };

      return data.versions.map((v) => ({
        version: v.num,
        isYanked: v.yanked,
        releaseDate: v.created_at,
      }));
    } catch (error) {
      this.logger.error(`error getting versions for crate: ${crateName}`, {
        error,
      });
      throw new Error(
        `failed to get crate versions: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Get source code for a specific item
   */
  async getSourceCode(
    crateName: string,
    path: string,
    version?: string,
  ): Promise<string> {
    try {
      this.logger.info(`Getting source code for ${path} in crate: ${crateName}`);

      const versionPath = version || "latest";
      const response = await rustHttpClient.docsRsFetch(
        `/crate/${crateName}/${versionPath}/src/${path}`,
      );

      if (typeof response.data !== "string") {
        throw new Error("Expected HTML response but got JSON");
      }

      const $ = cheerio.load(response.data);
      return $(".src").text();
    } catch (error) {
      this.logger.error(
        `Error getting source code for ${path} in crate: ${crateName}`,
        { error },
      );
      throw new Error(`Failed to get source code: ${(error as Error).message}`);
    }
  }

  /**
   * Search for symbols within a crate
   */
  async searchSymbols(
    crateName: string,
    query: string,
    version?: string,
  ): Promise<SymbolDefinition[]> {
    try {
      this.logger.info(
        `searching for symbols in crate: ${crateName} with query: ${query}`,
      );

      try {
        const versionPath = version || "latest";
        const response = await rustHttpClient.docsRsFetch(
          `/${crateName}/${versionPath}/${crateName}/`,
          {
            params: { search: query },
          },
        );

        if (typeof response.data !== "string") {
          throw new Error("Expected HTML response but got JSON");
        }

        const $ = cheerio.load(response.data);
        const symbols: SymbolDefinition[] = [];

        $(".search-results a").each((_: number, element: any) => {
          const name = $(element).find(".result-name path").text().trim();
          const kind = $(element).find(".result-name typename").text().trim();
          const path = $(element).attr("href") || "";

          symbols.push({
            name,
            kind,
            path,
          });
        });

        return symbols;
      } catch (innerError: unknown) {
        // If we get a 404, try a different approach - search in the main documentation
        if (innerError instanceof Error && innerError.message.includes("404")) {
          this.logger.info(
            `Search endpoint not found for ${crateName}, trying alternative approach`,
          );
        }

        // Re-throw other errors
        throw innerError;
      }
    } catch (error) {
      this.logger.error(`Error searching for symbols in crate: ${crateName}`, {
        error,
      });
      throw new Error(
        `Failed to search for symbols: ${(error as Error).message}`,
      );
    }
  }
}
