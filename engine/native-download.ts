import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Collect only a new native file after an observed export click; never fetch URLs. */
export class NativeDownloadCollector {
  private pending?: {
    id: string;
    phase: string;
    url: string;
    before: Map<string, string>;
    startedAt: string;
  };
  constructor(
    private downloads: string,
    private workspace: string,
    private media: "model" | "video" = "model",
  ) {}
  private snapshot() {
    const found = new Map<string, string>();
    for (const name of fs.readdirSync(this.downloads)) {
      if (!(this.media === "video" ? /\.mp4$/i : /\.(fbx|zip)$/i).test(name)) continue;
      const file = path.join(this.downloads, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      found.set(name, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    }
    return found;
  }
  prepare(phase: string, url: string) {
    if (this.pending) throw Error("이미 다운로드 회수를 기다리고 있습니다.");
    this.pending = {
      id: randomUUID(),
      phase,
      url,
      before: this.snapshot(),
      startedAt: new Date().toISOString(),
    };
    return {
      id: this.pending.id,
      status: "ready",
      instruction:
        "이제 확인한 내보내기 버튼을 한 번 누르세요. 생성 버튼은 누르지 마세요.",
    };
  }
  collect(id: string) {
    const ticket = this.pending;
    if (!ticket || ticket.id !== id)
      throw Error("현재 다운로드 예약과 일치하지 않습니다.");
    const changed = [...this.snapshot()].filter(
      ([name, stamp]) => ticket.before.get(name) !== stamp,
    );
    if (!changed.length) return { status: "pending" };
    if (changed.length !== 1)
      throw Error(
        "새 파일이 여러 개입니다. 출처가 불명확하므로 자동 회수하지 않습니다.",
      );
    const [name, stamp] = changed[0],
      source = path.join(this.downloads, name),
      stat = fs.lstatSync(source);
    if (stat.size < 27 || stat.size > 200 * 1024 * 1024)
      throw Error("다운로드 크기를 확인하세요.");
    const bytes = fs.readFileSync(source);
    if (this.snapshot().get(name) !== stamp || bytes.length !== stat.size)
      return { status: "pending" };
    const valid = this.media === "video" ? bytes.toString("ascii", 4, 8) === "ftyp" : /\.fbx$/i.test(name)
      ? bytes
          .subarray(0, 23)
          .equals(Buffer.from("Kaydara FBX Binary  \x00\x1a\x00")) ||
        /^; FBX/.test(bytes.subarray(0, 100).toString())
      : bytes.readUInt32LE(0) === 0x04034b50;
    if (!valid) throw Error("파일 내용이 요청한 원본 형식과 다릅니다.");
    const relative = `outputs/native-downloads/${id}/${name}`;
    const destination = path.join(this.workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: "wx" });
    const receipt = {
      status: "collected",
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      phase: ticket.phase,
      pageUrl: ticket.url,
      startedAt: ticket.startedAt,
      collectedAt: new Date().toISOString(),
      provenance: "native-export-directory-delta",
      sourceName: name,
    };
    fs.writeFileSync(
      path.join(path.dirname(destination), "download-receipt.json"),
      JSON.stringify(receipt, null, 2),
      { flag: "wx" },
    );
    this.pending = undefined;
    return receipt;
  }
}
