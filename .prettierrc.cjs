/** @type {import("prettier").Config} */
module.exports = {
  plugins: [require("@trivago/prettier-plugin-sort-imports")],
  editorconfig: true,
  singleQuote: false,
  jsxSingleQuote: false,
  arrowParens: "always",
  trailingComma: "all",
  bracketSameLine: false,
  importOrder: ["^node:", "^(?![./]).*$", "^[./]"],
  importOrderSeparation: true,
  importOrderSortSpecifiers: true,
};
