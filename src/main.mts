import { getOctokit } from "@actions/github";
import { glob } from "glob";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  InputParameterIncompatibleStrategyError,
  InputParameterRequiredError,
  getBooleanInput,
  getEnumInput,
  getInput,
  getMultilineInput,
  setOutput,
} from "./actions.mts";
import { ActionError, INNER_ERROR, isHttpError } from "./error.mts";
import { createLogger } from "./logger.mts";
import { Strategy } from "./strategy.mts";
import unreachable from "./unreachable.mts";

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

interface ConfigBase {
  owner: string;
  repo: string;
  tag: string;
  tagMessage: string;
  title: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  discussionCategoryName?: string;
  files: string[];
}

type Config =
  | (ConfigBase & {
      strategy: Strategy.UseExistingTag;
    })
  | (ConfigBase & {
      strategy: Strategy;
      targetSha: string;
    });

async function init(): Promise<[ReturnType<typeof getOctokit>, Config]> {
  const github = getOctokit(getInput("token", true), {
    request: {
      timeout: 30000,
    },
  });

  const [owner, repo] = getRepo();
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

  const target = getInput("target");
  let targetSha;
  if (target?.includes("/")) {
    logger.debug("assuming target is a git ref");

    const targetRefName = target.replace(/^refs\//, "");
    logger.info(`resolving target ref: ${targetRefName}`);

    try {
      targetSha = (
        await github.rest.git.getRef({
          owner,
          repo,
          ref: targetRefName,
        })
      ).data.object.sha;
    } catch (err) {
      throw new ActionError("failed to resolve target ref", err);
    }
  } else {
    logger.debug("assuming target is a SHA");
    targetSha = target;
  }

  const config = {
    owner,
    repo,
    tag,
    tagMessage,
    title,
    body,
    prerelease,
    draft,
    discussionCategoryName,
    files,
  };

  if (targetSha == null) {
    if (strategy !== Strategy.UseExistingTag) {
      throw new InputParameterRequiredError("target");
    }

    return [
      github,
      {
        ...config,
        strategy,
      },
    ];
  }

  if (strategy === Strategy.UseExistingTag) {
    throw new InputParameterIncompatibleStrategyError("target", strategy);
  }

  return [
    github,
    {
      ...config,
      strategy,
      targetSha,
    },
  ];
}

async function run(): Promise<void> {
  const [github, config] = await init();
  logger.info("initialized", {
    config,
  });

  let existingTag;
  try {
    logger.info("checking if tag already exists");
    existingTag = await github.rest.git.getRef({
      owner: config.owner,
      repo: config.repo,
      ref: `tags/${config.tag}`,
    });
  } catch (err) {
    if (isHttpError(err)) {
      if (err.status !== 404) {
        throw new ActionError("failed to verify if tag already exists", err);
      }
    } else {
      throw new ActionError(
        "failed to verify if tag already exists (unknown error)",
        err,
      );
    }
  }

  if (existingTag != null && config.strategy === Strategy.FailFast) {
    throw new ActionError("tag already exists");
  }

  const releases = await github.rest.repos.listReleases({
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
    await github.rest.repos.deleteRelease({
      owner: config.owner,
      repo: config.repo,
      release_id: releaseId,
    });
  }

  let undoTag;
  const existingTagSha = existingTag?.data.object.sha;
  if (config.strategy === Strategy.UseExistingTag) {
    undoTag = async function (): Promise<void> {
      /* no-op */
    };
  } else {
    if (existingTagSha != null) {
      try {
        logger.info("attempting to update existing tag");
        await github.rest.git.updateRef({
          owner: config.owner,
          repo: config.repo,
          ref: `tags/${config.tag}`,
          sha: config.targetSha,
          force: true,
        });
        undoTag = async (): Promise<void> => {
          await github.rest.git.updateRef({
            owner: config.owner,
            repo: config.repo,
            ref: `tags/${config.tag}`,
            sha: existingTagSha,
          });
        };
        logger.info("successfully updated tag");
      } catch (err) {
        throw new ActionError("failed to update existing tag", err);
      }
    } else {
      try {
        logger.info("creating tag");
        const tag = await github.rest.git.createTag({
          owner: config.owner,
          repo: config.repo,
          tag: config.tag,
          message: config.tagMessage,
          object: config.targetSha,
          type: "commit",
        });
        logger.debug("created tag", {
          tag,
        });

        logger.info("creating tag ref");
        // FIXME: for some reason GitHub refuses to create tag refs for
        // anything that isn't the latest commit. Maybe I'm missing something
        // but who knows...
        const tagRef = await github.rest.git.createRef({
          owner: config.owner,
          repo: config.repo,
          ref: `refs/tags/${config.tag}`,
          sha: config.targetSha,
        });
        logger.debug("created tag ref", {
          tagRef,
        });

        undoTag = async (): Promise<void> => {
          await github.rest.git.deleteRef({
            owner: config.owner,
            repo: config.repo,
            ref: `refs/tags/${config.tag}`,
          });
        };

        logger.info("successfully created tag");
      } catch (err) {
        throw new ActionError("failed to create tag", err);
      }
    }
  }

  let release;
  try {
    logger.info("creating release");
    release = await github.rest.repos.createRelease({
      owner: config.owner,
      repo: config.repo,
      name: config.title,
      body: config.body,
      tag_name: config.tag,
      discussion_category_name: config.discussionCategoryName,
      prerelease: config.prerelease,
      draft: config.draft,
    });
    logger.info(`created release (id ${release.data.id})`);
  } catch (err) {
    try {
      await undoTag();
    } catch (err) {
      logger.error("failed to undo tag changes", err);
    }

    throw new ActionError("failed to create release", err);
  }

  const releaseId = release.data.id;
  const releaseUploadUrl = release.data.upload_url;

  for (const file of await glob(config.files)) {
    const stats = await stat(file);
    const name = basename(file);

    logger.info(`uploading file: ${file}`);
    const [success, err] = await runWithRetry(4, 4000, async () => {
      // We can't overwrite assets, so remove existing ones from previous the attempt.
      const assets = await github.rest.repos.listReleaseAssets({
        owner: config.owner,
        repo: config.repo,
        release_id: releaseId,
      });
      for (const asset of assets.data) {
        if (asset.name === name) {
          logger.debug(
            `deleting existing asset from previous attempt: ${name}`,
          );
          await github.rest.repos.deleteReleaseAsset({
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
      await github.rest.repos.uploadReleaseAsset({
        // @ts-expect-error: if only they could get their types right...
        data,
        headers,
        name,
        url: releaseUploadUrl,
      });
    });

    if (!success) {
      logger.info(`exceeded upload retry limit; deleting release`);

      try {
        await github.rest.repos.deleteRelease({
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

      throw new ActionError(`failed to upload file: ${file}`, err);
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
): Promise<[boolean, unknown]> {
  for (let i = 0; i < attempts; i++) {
    try {
      await f();
      return [true, undefined];
    } catch (err) {
      if (i === attempts - 1) {
        return [false, err];
      }

      const delay = Math.min(
        Math.round((Math.pow(2, i) + Math.random()) * 1000),
        maxDelay,
      );
      logger.info(`trying again in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw unreachable();
}

try {
  await run();
} catch (err) {
  if (err instanceof ActionError) {
    logger.error(err.message, {
      error: err[INNER_ERROR],
    });
  } else {
    logger.error("unhandled error", {
      error: err,
    });
  }

  process.exit(1);
}
