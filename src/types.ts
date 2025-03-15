/**
 * Types for docs.rs integration
 */

export interface CrateInfo {
	name: string;
	version: string;
	description?: string;
}

export interface CrateSearchResult {
	crates: CrateInfo[];
	totalCount: number;
}

export interface RustType {
	name: string;
	kind:
		| "struct"
		| "enum"
		| "trait"
		| "function"
		| "macro"
		| "type"
		| "module"
		| "other";
	path: string;
	description?: string;
	sourceUrl?: string;
	documentationUrl: string;
}

export interface FeatureFlag {
	name: string;
	description?: string;
	enabled: boolean;
}

export interface CrateVersion {
	version: string;
	isYanked: boolean;
	releaseDate?: string;
}

export interface SymbolDefinition {
	name: string;
	kind: string;
	path: string;
	sourceCode?: string;
	documentationHtml?: string;
}

export interface SearchOptions {
	query: string;
	page?: number;
	perPage?: number;
}

export interface RustDocArgs {
  crateName: string;
  version?: string;
}

export interface RustCrateSearchArgs {
	query: string;
	page?: number;
	perPage?: number;
}

export function isRustDocArgs(args: unknown): args is RustDocArgs {
  return typeof args === 'object' && args !== null &&
    typeof (args as RustDocArgs).crateName === 'string' &&
    ((args as RustDocArgs).version === undefined || typeof (args as RustDocArgs).version === 'string');
}

export function isRustCrateSearchArgs(args: unknown): args is RustCrateSearchArgs {
  return typeof args === 'object' && args !== null &&
    typeof (args as RustCrateSearchArgs).query === 'string' &&
    ((args as RustCrateSearchArgs).page === undefined || typeof (args as RustCrateSearchArgs).page === 'number') &&
    ((args as RustCrateSearchArgs).perPage === undefined || typeof (args as RustCrateSearchArgs).perPage === 'number');
}
