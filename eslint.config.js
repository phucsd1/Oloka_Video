import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.tmp/**",
      "playwright-report/**",
      "test-results/**",
      "third_party/hyperframes/v0.7.104/hyperframe.runtime.iife.js",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  prettier,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "playwright.config.ts",
            "playwright.preview.config.ts",
            "tests/e2e/*.ts",
            "tests/e2e-preview/*.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/server/**/*.ts", "scripts/**/*.mjs", "*.ts", "*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: [
      "apps/web/**/*.ts",
      "apps/web/**/*.tsx",
      "tests/preview-compat/**/*.ts",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
