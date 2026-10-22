/** A single HTTP byte range for local native video seeking; never broadens file access. */
export function byteRange(header: string | null, size: number): { start: number; end: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size <= 0) throw Error("Invalid byte range");
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw Error("Invalid byte range");
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
      throw Error("Invalid byte range");
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
