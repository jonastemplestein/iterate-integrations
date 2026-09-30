import { defineConfig } from "vite-plus";

// The repo's one toolchain config: `vp check` formats (oxfmt), lints (oxlint) and type-checks
// (tsgolint, each file against its package's tsconfig); `vp staged` runs it on a commit's files.
// Each package's own vite.config.ts holds its build (`vp pack`).
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // iterate/iterate's .oxfmtrc.json, so code moves between the two repos unchanged
  fmt: {
    printWidth: 100,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    arrowParens: "always",
    endOfLine: "lf",
    sortPackageJson: false,
    ignorePatterns: ["dist/", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".github/workflows/"],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    categories: { correctness: "error" },
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    ignorePatterns: ["dist/"],
    options: { typeAware: true, typeCheck: true },
  },
});
