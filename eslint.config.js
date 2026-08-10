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
          allowDefaultProject: ["playwright.config.ts", "tests/e2e/*.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/server/**/*.ts", "*.ts", "*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
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
