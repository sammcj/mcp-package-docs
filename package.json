{
  "name": "mcp-package-docs",
  "version": "0.1.26",
  "description": "An MCP server that provides LLMs with efficient access to package documentation across multiple programming languages",
  "main": "build/index.js",
  "type": "module",
  "bin": {
    "mcp-package-docs": "build/index.js"
  },
  "files": [
    "build",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc && chmod +x build/index.js",
    "watch": "tsc -w",
    "serve": "node build/index.js",
    "format": "prettier --write \"src/**/*.ts\"",
    "inspector": "npx @modelcontextprotocol/inspector build/index.js",
    "bump": "npx -y standard-version --skip.tag && git add . ; git commit -m 'chore: bump version' ; git push",
    "prepublishOnly": "npm run build",
    "test": "node test-npm-docs.js"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/sammcj/mcp-package-docs.git"
  },
  "keywords": [
    "mcp",
    "documentation",
    "llm",
    "ai",
    "package",
    "docs",
    "go",
    "python",
    "npm",
    "sammcj",
    "smcleod"
  ],
  "author": {
    "name": "Sam McLeod",
    "url": "https://smcleod.net"
  },
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/sammcj/mcp-package-docs/issues"
  },
  "homepage": "https://github.com/sammcj/mcp-package-docs#readme",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.7.0",
    "axios": "^1.8.3",
    "fuse.js": "7.1.0",
    "node-html-markdown": "1.3.0",
    "typescript": "5.8.2",
    "typescript-language-server": "^4.3.4",
    "vscode-languageserver-protocol": "^3.17.5"
  },
  "devDependencies": {
    "@eslint/js": "10.0.0",
    "@types/node": "^22.13.10",
    "@types/turndown": "5.0.5",
    "@typescript-eslint/eslint-plugin": "8.26.1",
    "@typescript-eslint/parser": "8.26.1",
    "eslint": "9.22.0",
    "globals": "16.0.0",
    "prettier": "^3.5.3",
    "typescript-eslint": "8.26.1"
  },
  "engines": {
    "node": ">=20"
  },
  "publishConfig": {
    "access": "public"
  },
  "packageManager": "pnpm@10.7.0+sha512.6b865ad4b62a1d9842b61d674a393903b871d9244954f652b8842c2b553c72176b278f64c463e52d40fff8aba385c235c8c9ecf5cc7de4fd78b8bb6d49633ab6"
}
