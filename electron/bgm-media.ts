import fs from "node:fs";
import { Readable } from "node:stream";

/** Resolve only a known candidate; renderer paths never enter the filesystem. */
export async function serveBgmMedia(request: Request, localFile: (id: string) => string): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "bgm-media:" || url.hostname !== "track" || url.search ||
      !/^\/[a-zA-Z0-9_-]{1,100}$/.test(url.pathname) || !["GET", "HEAD"].includes(request.method)) {
      return new Response(null, { status: 404 });
    }
    const file = localFile(url.pathname.slice(1));
    const size = fs.statSync(file).size;
    let start = 0, end = size - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
    }
    const headers: Record<string, string> = {
      "Content-Type": "audio/mpeg", "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    const stream = fs.createReadStream(file, { start, end });
    await new Promise<void>((resolve, reject) => { stream.once("open", () => resolve()); stream.once("error", reject); });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch { return new Response(null, { status: 404 }); }
}
