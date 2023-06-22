/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  ignorePatterns: ["dist/**"],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  rules: {
    "@typescript-eslint/explicit-function-return-type": "error",
    "@typescript-eslint/ban-ts-comment": [
      "error",
      {
        "ts-expect-error": "allow-with-description",
      },
    ],
    "consistent-return": "error",
    eqeqeq: ["error", "always", { null: "ignore" }],
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
  },
  overrides: [
    {
      files: ["**/*.cjs"],
      rules: {
        // require() is the only way to import modules in in CJS files...
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
  env: {
    browser: false,
    node: true,
  },
};
