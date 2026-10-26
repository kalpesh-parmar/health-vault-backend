const js = require("@eslint/js");
const prettierConfig = require("eslint-config-prettier");
const unusedImports = require("eslint-plugin-unused-imports");

let globalsPkg = {};
try {
  globalsPkg = require("globals");
} catch {
  // `globals` not installed; fall back to the manual lists below
}

const nodeGlobals = globalsPkg.node || {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Buffer: "readonly",
  console: "readonly",
  __dirname: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setTimeout: "readonly",
  setImmediate: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
};

const jestGlobals = globalsPkg.jest || {
  jest: "readonly",
  describe: "readonly",
  it: "readonly",
  expect: "readonly",
  beforeEach: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  afterAll: "readonly",
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "drizzle/**",
      "ai-service/**",
      "services/**/venv/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: nodeGlobals,
      sourceType: "commonjs",
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "consistent-return": "error",
      "no-console": "warn",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "unused-imports/no-unused-imports": "error",
    },
  },
  {
    files: ["**/*.test.js", "tests/**/*.js"],
    languageOptions: {
      globals: jestGlobals,
    },
  },
  prettierConfig,
];
