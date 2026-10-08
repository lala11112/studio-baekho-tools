import fs from "node:fs";

/** Windows tools may write a UTF-8 BOM; only remove that prefix, never repair malformed JSON. */
export function parseJsonText(text: string): any {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

export function readJsonFile(file: string): any {
  return parseJsonText(fs.readFileSync(file, "utf8"));
}
