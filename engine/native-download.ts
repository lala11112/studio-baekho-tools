import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Collect only a new native file after an observed export click; never fetch URLs. */
export class NativeDownloadCollector {
  private collected: any[] = [];
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
    private media: "model" | "video" | "image" = "model",
    private stateFile?: string,
  ) {
    if (stateFile && fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (saved.workspace !== path.resolve(workspace) || saved.downloads !== path.resolve(downloads) || saved.media !== media)
        throw Error("다운로드 기록의 작업 위치가 다릅니다.");
      this.collected = saved.collected;
      if (saved.pending) this.pending = {...saved.pending, before:new Map(saved.pending.before)};
    }
  }
  status() {
    return {pending:this.pending ? {id:this.pending.id,phase:this.pending.phase,url:this.pending.url} : undefined,
      collected:structuredClone(this.collected)};
  }
  private persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile),{recursive:true});
    const fd=fs.openSync(this.stateFile+".tmp","w");
    try { fs.writeFileSync(fd,JSON.stringify({workspace:path.resolve(this.workspace),downloads:path.resolve(this.downloads),media:this.media,
      pending:this.pending ? {...this.pending,before:[...this.pending.before]} : undefined,collected:this.collected}));fs.fsyncSync(fd); }
    finally {fs.closeSync(fd);}
    fs.renameSync(this.stateFile+".tmp",this.stateFile);
  }
  private snapshot() {
    const found = new Map<string, string>();
    for (const name of fs.readdirSync(this.downloads)) {
      if (!(this.media === "image" ? /\.(png|jpe?g|webp)$/i : this.media === "video" ? /\.mp4$/i : /\.(fbx|zip)$/i).test(name)) continue;
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
    this.persist();
    return {
      id: this.pending.id,
      status: "ready",
      instruction:
        "이제 확인한 내보내기 버튼을 한 번 누르세요. 생성 버튼은 누르지 마세요.",
    };
  }
  collect(id: string) {
    const saved = this.stateFile && this.collected.find(r=>r.id===id);
    if(saved) {
      const file=path.resolve(this.workspace,saved.path);
      if(!file.startsWith(path.resolve(this.workspace)+path.sep) ||
        !fs.realpathSync(file).startsWith(fs.realpathSync(this.workspace)+path.sep) ||
        createHash("sha256").update(fs.readFileSync(file)).digest("hex")!==saved.sha256)
        throw Error("저장된 다운로드 원본이 변경됐습니다.");
      return structuredClone(saved);
    }
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
    const valid = this.media === "image" ?
      (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
       (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) ||
       (bytes.toString("ascii",0,4)==="RIFF" && bytes.toString("ascii",8,12)==="WEBP")) :
      this.media === "video" ? bytes.toString("ascii", 4, 8) === "ftyp" : /\.fbx$/i.test(name)
      ? bytes
          .subarray(0, 23)
          .equals(Buffer.from("Kaydara FBX Binary  \x00\x1a\x00")) ||
        /^; FBX/.test(bytes.subarray(0, 100).toString())
      : bytes.readUInt32LE(0) === 0x04034b50;
    if (!valid) throw Error("파일 내용이 요청한 원본 형식과 다릅니다.");
    const relative = `outputs/native-downloads/${id}/${name}`;
    const destination = path.join(this.workspace, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if(!fs.realpathSync(path.dirname(destination)).startsWith(fs.realpathSync(this.workspace)+path.sep))
      throw Error("작업 폴더 밖 연결 파일을 거부했습니다.");
    if(fs.existsSync(destination)) {
      if(!fs.readFileSync(destination).equals(bytes)) throw Error("기존 수집 원본과 다른 파일입니다.");
    } else fs.writeFileSync(destination, bytes, { flag: "wx" });
    const receipt = {
      status: "collected",
      id,
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
      { flag: "w" },
    );
    this.pending = undefined;
    this.collected.push(receipt);
    this.persist();
    return receipt;
  }
}
