import * as esbuild from "esbuild";
import * as Eta from "eta";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chdir } from "node:process";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
chdir(projectRoot);

const srcDir = path.join(projectRoot, "src");
const distDir = path.join(projectRoot, "dist");

await rm(distDir, {
  recursive: true,
  force: true,
});
await mkdir(distDir);

await copyFile(path.join(projectRoot, "LICENSE"), "dist/LICENSE");
await copyFile(path.join(srcDir, "action.yml"), "dist/action.yml");

const version = process.env["PROJECT_VERSION"] ?? "0.0.0";
const readmeTemplate = await readFile(path.join(srcDir, "README.md.eta"), {
  encoding: "utf8",
});
const actionMetadata = yaml.parse(
  await readFile(path.join(srcDir, "action.yml"), {
    encoding: "utf8",
  }),
);
const renderedReadme = Eta.render(readmeTemplate, { meta: actionMetadata, version });
await writeFile(path.join(distDir, "README.md"), renderedReadme);

await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: [path.join(srcDir, "main.mts")],
  bundle: true,
  outfile: path.join(distDir, "action.mjs"),
  format: "esm",
  target: "node16",
  platform: "node",
  treeShaking: true,
  banner: {
    // https://github.com/evanw/esbuild/issues/1921#issuecomment-1439609735
    js: `
      const { require, __filename, __dirname } = await (async () => {
        const { createRequire } = await import("node:module");
        const { fileURLToPath } = await import("node:url");

        return {
          require: createRequire(import.meta.url),
          __filename: fileURLToPath(import.meta.url),
          __dirname: fileURLToPath(new URL(".", import.meta.url)),
        };
      })();
    `,
  },
});
