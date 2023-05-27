import actionsCore from "@actions/core";

import { ActionError } from "./error.mjs";

export class InputParameterError extends ActionError {
  parameterName: string;

  constructor(name: string, message?: string | undefined) {
    super(message);
    this.parameterName = name;
  }
}

export class MissingInputParameterError extends InputParameterError {
  constructor(name: string) {
    super(name, `input parameter '${name}' is required`);
  }
}

export class InvalidInputParameterValueError extends InputParameterError {
  constructor(name: string, value?: string) {
    if (value == null) {
      super(name, `invalid value supplied to input parameter '${name}'`);
    } else {
      super(
        name,
        `invalid value supplied to input parameter '${name}': ${JSON.stringify(
          value,
        )}`,
      );
    }
  }
}

export function setOutput(name: string, value: unknown): void {
  actionsCore.setOutput(name, value);
}

export function getInput(name: string, required: true, trim?: boolean): string;
export function getInput(
  name: string,
  required?: false,
  trim?: boolean,
): string | undefined;
export function getInput(
  name: string,
  required?: boolean,
  trim?: boolean,
): string | (string | undefined) {
  let value = getRawInput(name);
  if (!hasValue(required ?? false, name, value)) {
    return undefined;
  }

  if (trim ?? true) {
    value = value.trim();
  }

  return value;
}

export function getEnumInput<T extends string>(
  name: string,
  variants: T[],
  required: true,
  trim?: boolean,
): T;
export function getEnumInput<T extends string>(
  name: string,
  variants: T[],
  required?: false,
  trim?: boolean,
): T | undefined;
export function getEnumInput<T extends string>(
  name: string,
  variants: T[],
  required?: boolean,
  trim?: boolean,
): T | (T | undefined) {
  let value = getRawInput(name);
  if (!hasValue(required ?? false, name, value)) {
    return undefined;
  }

  if (trim ?? true) {
    value = value.trim();
  }

  if (variants.includes(value as T)) {
    return value as T;
  }
  throw new InvalidInputParameterValueError(name, value);
}

export function getBooleanInput(
  name: string,
  required?: boolean,
): boolean | undefined {
  const value = getRawInput(name);
  if (!hasValue(required ?? false, name, value)) {
    return undefined;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  throw new InvalidInputParameterValueError(name, value);
}

export function getMultilineInput(
  name: string,
  required?: boolean,
  trim?: boolean,
): string[] | undefined {
  const value = getRawInput(name);
  if (!hasValue(required ?? false, name, value)) {
    return undefined;
  }

  const entries = value.split(/\r?\n/)?.map((x) => (trim ? x.trim() : x));
  if (entries[entries.length - 1] === "") {
    entries.pop();
  }
  return entries;
}

function getRawInput(name: string): string | undefined {
  return process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] || "";
}

function hasValue(
  required: boolean,
  name: string,
  value: string | undefined,
): value is string {
  if (value == null || value === "") {
    if (required) {
      throw new MissingInputParameterError(name);
    } else {
      return false;
    }
  }

  return true;
}
