import actionsCore from "@actions/core";
import lodash from "lodash";
import winston from "winston";
import WinstonTransport from "winston-transport";

import { ActionError, INNER_ERROR } from "./error.mjs";

const NEWLINE = Symbol("New line");
const INDENT = Symbol("Increase indent");
const DEDENT = Symbol("Decrease indent");

type MessagePart = unknown;

class MessageBuilder {
  parts: MessagePart[];

  constructor(initial?: MessagePart[]) {
    this.parts = initial ?? [];
  }

  push(...parts: MessagePart[]): void {
    this.parts.push(...parts);
  }

  pushLine(...parts: MessagePart[]): void {
    this.parts.push(...parts, NEWLINE);
  }

  indent(): void {
    this.parts.push(INDENT);
  }

  dedent(): void {
    this.parts.push(DEDENT);
  }

  build(): string {
    let indentLevel = 0;
    const indent = (): string => {
      return "  ".repeat(indentLevel);
    };
    for (let i = 0; i < this.parts.length; i++) {
      switch (this.parts[i]) {
        case NEWLINE: {
          if (i != this.parts.length - 1) {
            this.parts[i] = indent() + "\n";
          } else {
            this.parts[i] = undefined;
          }
          break;
        }
        case INDENT: {
          this.parts[i] = undefined;
          indentLevel++;
          break;
        }
        case DEDENT: {
          this.parts[i] = undefined;
          indentLevel--;
          if (indentLevel < 0) {
            throw new Error("indentation can't be negative");
          }
          break;
        }
        default: {
          let part = this.parts[i];
          const toStringFn = (part as { [key: string]: unknown })["toString"];
          if (toStringFn === Object.prototype.toString) {
            part = JSON.stringify(part);
          } else if (typeof toStringFn === "function") {
            part = toStringFn.call(part);
          }

          if (typeof part !== "string") {
            throw new Error(`failed to stringify message part: ${part}`);
          }

          part = indent() + part.split("\n").join("\n" + indent());
          this.parts[i] = part;
          break;
        }
      }
    }
    return this.parts.join("");
  }
}

const formatter = winston.format((info) => {
  const builder = new MessageBuilder();
  const processError = (error: unknown): void => {
    if (error == null) return;
    if (!(error instanceof Error)) {
      builder.pushLine(`unknown error: ${JSON.stringify(error)}`);
      return;
    }

    if (error.stack) {
      builder.pushLine(error.stack);
    } else {
      builder.pushLine(error.toString());
    }

    const metadata = lodash.omit(error, ["name", "message", "stack"]);
    if (Object.keys(metadata).length > 0) {
      builder.push("Metadata:");
      builder.push(JSON.stringify(metadata, undefined, 2));
      builder.pushLine();
    }

    if (error instanceof ActionError) {
      if (error[INNER_ERROR] != null) {
        builder.pushLine("Caused by:");
        builder.indent();
        processError(error[INNER_ERROR]);
        builder.dedent();
      }
    }
  };

  if (info.message != null) {
    builder.pushLine(info.message);
  }
  processError(info.error);

  info.message = builder.build();
  return info;
})();

enum LogLevel {
  Info,
  Warn,
  Error,
  Debug,
}

const LEVELS = Object.fromEntries(
  Object.values(LogLevel)
    .filter((x) => typeof x === "string")
    .map((x) => {
      const level = x as keyof typeof LogLevel;
      const levelName = level.toLowerCase() as Lowercase<keyof typeof LogLevel>;
      const levelPriority = LogLevel[level];
      return [levelName, levelPriority];
    }),
) as unknown as {
  [P in Lowercase<keyof typeof LogLevel>]: number;
};

class GitHubTransport extends WinstonTransport {
  constructor(opts?: WinstonTransport.TransportStreamOptions) {
    super(opts);
  }

  log(
    info: { level: keyof typeof LEVELS; message: string },
    next: () => void,
  ): void {
    switch (info.level) {
      case "debug": {
        actionsCore.debug(info.message);
        break;
      }
      case "info": {
        actionsCore.info(info.message);
        break;
      }
      case "warn": {
        actionsCore.warning(info.message);
        break;
      }
      case "error": {
        actionsCore.error(info.message);
        break;
      }
    }
    next();
  }
}

export function createLogger(): winston.Logger {
  return winston.createLogger({
    transports: [new GitHubTransport()],
    format: winston.format.combine(formatter, winston.format.simple()),
    levels: LEVELS,
    level: "debug",
  });
}
