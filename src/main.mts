import { getOctokit } from "@actions/github";
import { glob } from "glob";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  getBooleanInput,
  getEnumInput,
  getInput,
  getMultilineInput,
  setOutput,
} from "./actions.mjs";
import { ActionError, isHttpError } from "./error.mjs";
import { createLogger } from "./logger.mjs";
import unreachable from "./unreachable.mjs";

const logger = createLogger();

async function getTitle(): Promise<string | undefined> {
  const source = getEnumInput("title-source", ["literal", "file", "env"], true);
  switch (source) {
    case "literal": {
      return getInput("title", false);
    }
    case "file": {
      const path = getInput("title", true);
      try {
        return await readFile(path, {
          encoding: "utf8",
        });
      } catch (err) {
        throw new ActionError(`failed to read title from file "${path}"`, err);
      }
    }
    case "env": {
      const varName = getInput("title", true);
      return process.env[varName];
    }
    default: {
      throw unreachable();
    }
  }
}

async function getBody(): Promise<string | undefined> {
  const source = getEnumInput("body-source", ["literal", "file", "env"], true);
  switch (source) {
    case "literal": {
      return getInput("body", false);
    }
    case "file": {
      const path = getInput("body", true);
      try {
        return await readFile(path, {
          encoding: "utf8",
        });
      } catch (err) {
        throw new ActionError(`failed to read title from file "${path}"`, err);
      }
    }
    case "env": {
      const varName = getInput("body", true);
      return process.env[varName];
    }
    default: {
      throw unreachable();
    }
  }
}

function getRepo(): [string, string] {
  const fullRepoPath = getInput("repository", true);
  const match = fullRepoPath.match(/^(.*)\/(.*)$/);
  if (match == null) {
    throw new ActionError(
      `repository is not in the <owner>/<repo> format: ${fullRepoPath}`,
    );
  }

  let [, owner, repo] = match;
  owner = owner.trim();
  repo = repo.trim();

  if (owner == null || owner === "") {
    throw new ActionError(`repository owner is invalid: ${owner}`);
  }

  if (repo == null || repo === "") {
    throw new ActionError(`repository name is invalid: ${repo}`);
  }

  return [owner, repo];
}

enum Strategy {
  Replace = "replace",
  FailFast = "fail-fast",
  UseExistingTag = "use-existing-tag",
}

interface Config {
  ref: string;
  owner: string;
  repo: string;
  tag: string;
  tagMessage: string;
  strategy: Strategy;
  title: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  discussionCategoryName?: string;
  files: string[];
}

async function getConfig(): Promise<Config> {
  const [owner, repo] = getRepo();
  const ref = getInput("ref", true);
  const tag = getInput("tag", true);

  // The user can set the message to an empty string.
  // If the input parameter is omitted, it defaults to the tag.
  const tagMessage = getInput("tag-message") || tag;

  const strategy = getEnumInput("strategy", Object.values(Strategy), true);
  const title = (await getTitle()) ?? "";
  const body = (await getBody()) ?? "";
  const prerelease = getBooleanInput("prerelease") ?? false;
  const draft = getBooleanInput("draft") ?? false;
  const files = getMultilineInput("files") ?? [];

  // If this is set but the repo doesn't have discussions enabled,
  // GitHub will reject our request.
  const discussionCategoryName = getInput("discussion-category-name");

  return {
    ref,
    owner,
    repo,
    tag,
    tagMessage,
    strategy,
    title,
    body,
    prerelease,
    draft,
    discussionCategoryName,
    files,
  };
}

async function run(): Promise<void> {
  const octokit = getOctokit(getInput("token", true), {
    request: {
      timeout: 30000,
    },
  });
  const config = await getConfig();

  logger.info(`config: ${JSON.stringify(config, null, 2)}`);

  let existingTag;
  try {
    logger.info(`checking if tag "${config.tag}" already exists`);
    existingTag = await octokit.rest.git.getRef({
      owner: config.owner,
      repo: config.repo,
      ref: `tags/${config.tag}`,
    });

    if (config.strategy === Strategy.FailFast) {
      logger.error(`tag "${config.tag}" already exists`);
      process.exit(1);
    }
  } catch (err) {
    if (isHttpError(err)) {
      if (err.status !== 404) {
        logger.error("failed to verify if tag already exist", {
          error: err,
        });
        process.exit(1);
      }
    } else {
      logger.error("failed to verify if tag already exists (unknown error)", {
        error: err,
      });
      process.exit(1);
    }
  }

  const releases = await octokit.rest.repos.listReleases({
    owner: config.owner,
    repo: config.repo,
  });
  logger.debug(
    `checking for existing releases associated with tag "${config.tag}"`,
  );
  for (const release of releases.data) {
    if (release.tag_name !== config.tag) {
      continue;
    }
    const releaseId = release.id;
    logger.debug(`deleting release id ${releaseId}`);
    await octokit.rest.repos.deleteRelease({
      owner: config.owner,
      repo: config.repo,
      release_id: releaseId,
    });
  }

  let undoTag;
  const existingTagSha = existingTag?.data?.object?.sha;
  if (config.strategy === Strategy.UseExistingTag) {
    undoTag = async function (): Promise<void> {
      /* no-op */
    };
  } else if (existingTagSha != null) {
    try {
      logger.info("attempting to update existing tag");
      await octokit.rest.git.updateRef({
        owner: config.owner,
        repo: config.repo,
        ref: `tags/${config.tag}`,
        sha: config.ref,
        force: true,
      });
      undoTag = async (): Promise<void> => {
        await octokit.rest.git.updateRef({
          owner: config.owner,
          repo: config.repo,
          ref: `tags/${config.tag}`,
          sha: existingTagSha,
        });
      };
      logger.info("successfully updated tag");
    } catch (err) {
      logger.error("failed to update existing tag", {
        error: err,
      });
      process.exit(1);
    }
  } else {
    logger.info("creating tag");
    try {
      await octokit.rest.git.createTag({
        owner: config.owner,
        repo: config.repo,
        tag: config.tag,
        message: config.tagMessage,
        object: config.ref,
        type: "commit",
      });
      await octokit.rest.git.createRef({
        owner: config.owner,
        repo: config.repo,
        ref: `refs/tags/${config.tag}`,
        sha: config.ref,
      });
      undoTag = async (): Promise<void> => {
        await octokit.rest.git.deleteRef({
          owner: config.owner,
          repo: config.repo,
          ref: `refs/tags/${config.tag}`,
        });
      };
      logger.info("successfully created tag");
    } catch (err) {
      logger.error("failed to create tag", {
        error: err,
      });
      process.exit(1);
    }
  }

  let release;
  try {
    logger.info("creating release");
    release = await octokit.rest.repos.createRelease({
      owner: config.owner,
      repo: config.repo,
      name: config.title,
      body: config.body,
      tag_name: config.tag,
      target_commitish: config.ref,
      discussion_category_name: config.discussionCategoryName,
      prerelease: config.prerelease,
      draft: config.draft,
    });
    logger.info(`created release (id ${release.data.id})`);
  } catch (err) {
    logger.error("failed to create release", {
      error: err,
    });

    try {
      await undoTag();
    } catch (err) {
      logger.error("failed to undo tag changes", err);
    }

    process.exit(1);
  }

  const releaseId = release.data.id;
  const releaseUploadUrl = release.data.upload_url;

  for (const file of await glob(config.files)) {
    const stats = await stat(file);
    const name = basename(file);

    logger.info(`uploading file: ${file}`);
    const success = await runWithRetry(
      4,
      4000,
      async () => {
        // We can't overwrite assets, so remove existing ones from previous the attempt.
        const assets = await octokit.rest.repos.listReleaseAssets({
          owner: config.owner,
          repo: config.repo,
          release_id: releaseId,
        });
        for (const asset of assets.data) {
          if (asset.name === name) {
            logger.debug(
              `deleting existing asset from previous attempt: ${name}`,
            );
            await octokit.rest.repos.deleteReleaseAsset({
              owner: config.owner,
              repo: config.repo,
              asset_id: asset.id,
            });
          }
        }

        const headers = {
          "content-length": stats.size,
          "content-type": "application/octet-stream",
        };
        const data = createReadStream(file);
        await octokit.rest.repos.uploadReleaseAsset({
          // @ts-expect-error: if only they could get their types right...
          data,
          headers,
          name,
          url: releaseUploadUrl,
        });
      },
      async (err) => {
        logger.error(`failed to upload file: ${file}`, err);
      },
    );
    if (!success) {
      logger.info(`exceed upload retry limit; deleting release`);
      try {
        await octokit.rest.repos.deleteRelease({
          owner: config.owner,
          repo: config.repo,
          release_id: releaseId,
        });
      } catch (err) {
        logger.error("failed to delete release", err);
      }

      try {
        await undoTag();
      } catch (err) {
        logger.error("failed to undo tag changes", err);
      }
      process.exit(1);
    }
  }

  setOutput("release-id", releaseId);
}

/**
 * Run and retry a function until it succeeds, using truncated
 * exponential backoff.
 * @param attempts the maximum number of attempts
 * @param maxDelay the maximum backoff delay
 * @param f the function to run
 * @param onError a function called when an error is caught
 */
async function runWithRetry(
  attempts: number,
  maxDelay: number,
  f: () => Promise<void>,
  onError: (err: unknown) => Promise<void>,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      await f();
      return true;
    } catch (err) {
      await onError(err);
      if (i === attempts - 1) {
        break;
      }

      const delay = Math.min(
        Math.round((Math.pow(2, i) + Math.random()) * 1000),
        maxDelay,
      );
      logger.info(`trying again in ${delay}ms`);
      await sleep(delay);
    }
  }
  return false;
}

try {
  await run();
} catch (err) {
  logger.error("unhandled error", {
    error: err,
  });
  process.exit(1);
}
