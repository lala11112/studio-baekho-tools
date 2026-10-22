import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  BGM_GENRES, BGM_MOODS, BGM_MODEL, BGM_PRICE_USD, BGM_PRICE_CHECKED,
  type BgmCandidate, type BgmInput, type BgmState, type BgmStatus,
} from "../shared/bgm";

const QUEUE = `https://queue.fal.run/${BGM_MODEL}`;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const COST_CENTS = Math.round(BGM_PRICE_USD * 100);
const STATUSES: BgmStatus[] = ["submitting", "queued", "generating", "download-pending", "ready", "failed", "uncertain"];

function rejectionMessage(status: number): string {
  if (status === 401 || status === 403) return "fal.ai 인증을 확인해 주세요. FAL_KEY와 계정 권한을 확인한 뒤 직접 재시도할 수 있습니다. 예약 금액은 유지됩니다.";
  if (status === 402) return "fal.ai 계정 잔액을 확인해 주세요. 충전 후 직접 재시도할 수 있습니다. 예약 금액은 유지됩니다.";
  if (status === 400 || status === 422) return "프롬프트 또는 안전 필터로 요청이 거절되었습니다. 내용을 확인해 주세요. 예약 금액은 유지됩니다.";
  if (status === 429) return "fal.ai 요청 제한에 도달했습니다. 잠시 후 직접 재시도할 수 있습니다. 예약 금액은 유지됩니다.";
  return "fal.ai에서 요청을 거절했습니다. 모델 이용 가능 여부를 확인해 주세요. 예약 금액은 유지됩니다.";
}

interface RecordEntry extends BgmCandidate {
  revision: number;
  statusUrl?: string;
  responseUrl?: string;
  audioUrl?: string;
  retryOf?: string;
}
interface Ledger {
  version: 1;
  totalReservedUsd: number;
  candidates: RecordEntry[];
  selectedId?: string;
}
export interface BgmServiceOptions {
  root: string;
  getKey: () => string | undefined;
  fetch?: typeof fetch;
  budgetUsd?: number;
}

class StorageError extends Error {
  constructor() { super("BGM storage could not be saved safely. No further requests were submitted."); }
}

/** Only supported toggles reach the prompt; the provider receives no invented API fields. */
export function buildBgmPrompt(input: BgmInput): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid BGM input.");
  const choices = (value: unknown, allowed: readonly string[]) => {
    if (!Array.isArray(value) || value.length > allowed.length || value.some((x) => typeof x !== "string" || !allowed.includes(x)) || new Set(value).size !== value.length) {
      throw new Error("Invalid BGM genre or mood choices.");
    }
    return value as string[];
  };
  const genres = choices(input.genres, BGM_GENRES), moods = choices(input.moods, BGM_MOODS);
  if (typeof input.description !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.description)) throw new Error("Invalid BGM description.");
  const description = input.description.trim();
  if (!genres.length && !moods.length && !description) throw new Error("Choose a genre, mood, or music description.");
  const prompt = [
    "Create instrumental background music. No vocals, singing, or spoken words.",
    genres.length ? `Genres: ${genres.join(", ")}.` : "",
    moods.length ? `Moods: ${moods.join(", ")}.` : "",
    description,
  ].filter(Boolean).join("\n");
  if (prompt.length > 5000) throw new Error("The combined BGM prompt must be at most 5000 characters.");
  return prompt;
}

function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value); }
function queueUrl(value: unknown, requestId: string, status: boolean): string {
  const expected = `${QUEUE}/requests/${requestId}${status ? "/status" : ""}`;
  if (value === undefined) return expected;
  if (typeof value !== "string") throw new Error("Invalid queue address.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "queue.fal.run" || url.port || url.username || url.password || url.hash || url.search || url.href !== expected) throw new Error("Invalid queue address.");
  return expected;
}
function audioUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Invalid audio address.");
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "fal.media" && !url.hostname.endsWith(".fal.media")) || url.port || url.username || url.password || url.hash) throw new Error("Invalid audio address.");
  return url.href;
}

/** Validate an MPEG Layer III frame after an optional ID3v2 tag, not just a filename. */
function isMp3(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.length >= 10 && bytes.subarray(0, 3).toString("ascii") === "ID3") {
    if (![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.subarray(6, 10).some((b) => b > 127)) return false;
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10;
  }
  if (offset + 4 > bytes.length) return false;
  const a = bytes[offset], b = bytes[offset + 1], c = bytes[offset + 2];
  const version = (b >> 3) & 3, layer = (b >> 1) & 3, bitrateIndex = c >> 4, sampleIndex = (c >> 2) & 3;
  if (a !== 255 || (b & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return false;
  const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const frequency = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameSize = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrateIndex] / frequency) + ((c >> 1) & 1);
  return offset + frameSize <= bytes.length;
}

function writeAtomic(file: string, data: string | Buffer): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    // Windows does not allow fsync on directory handles. File contents are flushed above.
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Already closed. */ } }
    try { fs.unlinkSync(temporary); } catch { /* Preserve the previous atomic file. */ }
    throw new StorageError();
  }
}

async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) throw new Error("Response is too large.");
  if (!response.body) throw new Error("Response is empty.");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error("Response is too large.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** Main-process-only service. Construction/state reads never perform network requests. */
export class BgmService {
  private readonly root: string;
  private readonly mediaRoot: string;
  private readonly journalRoot: string;
  private readonly getKey: () => string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly budgetCents: number;
  private ledger: Ledger = { version: 1, totalReservedUsd: 0, candidates: [] };
  private generating?: Promise<BgmState>;
  private readonly refreshing = new Map<string, Promise<BgmState>>();
  private readonly retrying = new Map<string, Promise<BgmState>>();
  private storageFailed = false;

  constructor(options: BgmServiceOptions) {
    this.root = path.resolve(options.root);
    this.getKey = options.getKey;
    this.fetcher = options.fetch ?? globalThis.fetch;
    const budget = options.budgetUsd ?? 4.99;
    if (!Number.isFinite(budget) || budget < 0 || budget > 100_000) throw new Error("Invalid BGM budget.");
    this.budgetCents = Math.floor(budget * 100 + 1e-8);
    fs.mkdirSync(this.root, { recursive: true });
    this.root = fs.realpathSync(this.root);
    this.mediaRoot = path.join(this.root, "media");
    this.journalRoot = path.join(this.root, "submissions");
    for (const dir of [this.mediaRoot, this.journalRoot]) {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.lstatSync(dir).isSymbolicLink() || path.dirname(fs.realpathSync(dir)) !== this.root) throw new Error("Invalid BGM storage directory.");
    }
    this.load();
  }

  state(): BgmState {
    let configured = false;
    try { configured = Boolean(this.getKey()?.trim()); } catch { /* Credential values/errors never enter state. */ }
    return {
      configured, credentialSource: configured ? "FAL_KEY environment" : "Not configured",
      storageRoot: this.root, model: BGM_MODEL, priceUsd: BGM_PRICE_USD,
      priceCheckedAt: BGM_PRICE_CHECKED, totalReservedUsd: this.ledger.totalReservedUsd,
      budgetUsd: this.budgetCents / 100, selectedId: this.ledger.selectedId,
      candidates: this.ledger.candidates.map((record) => ({
        id: record.id, batchId: record.batchId, index: record.index, prompt: record.prompt,
        status: record.status, requestId: record.requestId, error: record.error,
        createdAt: record.createdAt, estimatedCostUsd: record.estimatedCostUsd,
        canRetry: record.status === "failed" && !this.ledger.candidates.some(c => c.retryOf === record.id),
        ...(record.status === "ready" ? { previewUrl: `bgm-media://track/${record.id}` } : {}),
      })),
    };
  }

  async generate(input: BgmInput): Promise<BgmState> {
    if (this.generating) return this.generating;
    const prompt = buildBgmPrompt(input);
    const key = this.key();
    const batchId = randomUUID();
    const records = [1, 2, 3].map((index) => this.newRecord(prompt, batchId, index));
    this.reserve(records);
    const operation = this.submitBatch(records, key);
    this.generating = operation;
    try { return await operation; } finally { this.generating = undefined; }
  }

  async retry(id: string): Promise<BgmState> {
    const pending = this.retrying.get(id);
    if (pending) return pending;
    const original = this.find(id);
    if (original.status !== "failed") throw new Error("Only a definitively failed BGM candidate can be retried.");
    if (this.ledger.candidates.some((c) => c.retryOf === id)) throw new Error("This failed candidate already has a retry. Use its new candidate.");
    const key = this.key();
    const record = this.newRecord(original.prompt, original.batchId, original.index, id);
    this.reserve([record]);
    const operation = this.submitBatch([record], key);
    this.retrying.set(id, operation);
    try { return await operation; } finally { this.retrying.delete(id); }
  }

  async refresh(id: string): Promise<BgmState> {
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const record = this.find(id);
    if (record.status === "ready") {
      try { this.checkedFile(record.id); return this.state(); }
      catch {
        record.status = "download-pending";
        if (this.ledger.selectedId === id) delete this.ledger.selectedId;
        this.checkpoint(record);
      }
    }
    if (["failed", "submitting"].includes(record.status) || !record.requestId) return this.state();
    const operation = this.refreshRecord(record);
    this.refreshing.set(id, operation);
    try { return await operation; } finally { this.refreshing.delete(id); }
  }

  select(id: string): BgmState {
    this.localFile(id);
    this.ledger.selectedId = id;
    this.saveLedger();
    return this.state();
  }

  localFile(id: string): string {
    const record = this.find(id);
    if (record.status !== "ready") throw new Error("This BGM candidate has no ready local MP3.");
    return this.checkedFile(record.id);
  }

  private key(): string {
    let key: string | undefined;
    try { key = this.getKey()?.trim(); } catch { /* Do not expose credential-provider errors. */ }
    if (!key) throw new Error("FAL_KEY credentials are not configured.");
    return key;
  }
  private find(id: string): RecordEntry {
    if (!safeId(id)) throw new Error("Invalid BGM candidate ID.");
    const record = this.ledger.candidates.find((candidate) => candidate.id === id);
    if (!record) throw new Error("Unknown BGM candidate.");
    return record;
  }
  private newRecord(prompt: string, batchId: string, index: number, retryOf?: string): RecordEntry {
    return { id: randomUUID(), batchId, index, prompt, status: "submitting", createdAt: new Date().toISOString(), estimatedCostUsd: BGM_PRICE_USD, revision: 0, ...(retryOf ? { retryOf } : {}) };
  }
  private reserve(records: RecordEntry[]): void {
    if (this.storageFailed) throw new StorageError();
    const cents = Math.round(this.ledger.totalReservedUsd * 100) + records.length * COST_CENTS;
    if (cents > this.budgetCents) throw new Error("The BGM budget cannot cover this request.");
    this.ledger.candidates.push(...records);
    this.ledger.totalReservedUsd = cents / 100;
    // A single atomic ledger reserves the whole batch before the first paid request.
    this.saveLedger();
  }
  private saveLedger(): void {
    if (this.storageFailed) throw new StorageError();
    try { writeAtomic(path.join(this.root, "ledger.json"), JSON.stringify(this.ledger, null, 2)); }
    catch { this.storageFailed = true; throw new StorageError(); }
  }
  private checkpoint(record: RecordEntry): void {
    if (this.storageFailed) throw new StorageError();
    record.revision++;
    try {
      // Journal first: an accepted request ID survives a failed ledger update.
      writeAtomic(path.join(this.journalRoot, `${record.id}.json`), JSON.stringify(record, null, 2));
      this.saveLedger();
    } catch { this.storageFailed = true; throw new StorageError(); }
  }

  private async request(url: string, init: RequestInit, maximum: number, timeoutMs: number): Promise<{ status: number; ok: boolean; body: Buffer }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("BGM request timed out.")); }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(url, { ...init, redirect: "error", signal: controller.signal });
          return { status: response.status, ok: response.ok, body: await readBounded(response, maximum) };
        })(),
        timeout,
      ]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  private async queueRequest(url: string, key: string, prompt?: string) {
    return this.request(url, {
      method: prompt === undefined ? "GET" : "POST",
      headers: { Authorization: `Key ${key}`, ...(prompt === undefined ? {} : { "Content-Type": "application/json", "X-Fal-No-Retry": "1" }) },
      ...(prompt === undefined ? {} : { body: JSON.stringify({ prompt, enable_safety_checker: true }) }),
    }, MAX_JSON_BYTES, REQUEST_TIMEOUT_MS);
  }

  private async submitBatch(records: RecordEntry[], key: string): Promise<BgmState> {
    for (const record of records) {
      this.checkpoint(record);
      let response: Awaited<ReturnType<BgmService["queueRequest"]>>;
      try { response = await this.queueRequest(QUEUE, key, record.prompt); }
      catch {
        record.status = "uncertain";
        record.error = "요청 접수 여부를 확인할 수 없습니다. 중복 결제를 막기 위해 자동으로 다시 제출하지 않습니다.";
        this.checkpoint(record);
        continue;
      }
      if (!response.ok) {
        // 408/5xx can follow an accepted request. Only known rejection codes permit retry.
        record.status = [400, 401, 402, 403, 404, 422, 429].includes(response.status) ? "failed" : "uncertain";
        record.error = record.status === "failed" ? rejectionMessage(response.status) : "요청 접수 여부를 확인할 수 없습니다. 중복 결제를 막기 위해 자동으로 다시 제출하지 않습니다.";
        this.checkpoint(record);
        continue;
      }
      let data: any;
      try { data = JSON.parse(response.body.toString("utf8")); } catch { /* Unknown accepted response. */ }
      if (!safeId(data?.request_id)) {
        record.status = "uncertain";
        record.error = "유효한 요청 ID를 받지 못했습니다. 접수 여부가 불확실하므로 이 후보를 다시 제출하지 마세요.";
        this.checkpoint(record);
        continue;
      }
      record.requestId = data.request_id;
      // Persist the ID before handling any optional provider URLs/status fields.
      this.checkpoint(record);
      try {
        record.statusUrl = queueUrl(data.status_url, record.requestId!, true);
        record.responseUrl = queueUrl(data.response_url, record.requestId!, false);
        record.status = data.status === "IN_PROGRESS" ? "generating" : "queued";
        delete record.error;
      } catch {
        record.statusUrl = queueUrl(undefined, record.requestId!, true);
        record.responseUrl = queueUrl(undefined, record.requestId!, false);
        record.status = "uncertain";
        record.error = "올바르지 않은 처리 주소를 받았습니다. 새로고침은 저장된 원래 요청 ID만 확인합니다.";
      }
      this.checkpoint(record);
    }
    return this.state();
  }

  private async refreshRecord(record: RecordEntry): Promise<BgmState> {
    const key = this.key();
    try {
      const status = await this.queueRequest(queueUrl(record.statusUrl, record.requestId!, true), key);
      if (!status.ok) throw new Error("Status unavailable.");
      const data = JSON.parse(status.body.toString("utf8"));
      if (["FAILED", "CANCELLED", "CANCELED"].includes(data.status) || (data.status === "COMPLETED" && (data.error || data.error_type))) {
        record.status = "failed";
        record.error = "fal.ai에서 음악 생성 실패를 확인했습니다. 직접 재시도하면 새 유료 요청이 생성됩니다.";
        this.checkpoint(record);
        return this.state();
      }
      if (data.status === "IN_QUEUE" || data.status === "IN_PROGRESS") {
        record.status = data.status === "IN_QUEUE" ? "queued" : "generating";
        delete record.error;
        this.checkpoint(record);
        return this.state();
      }
      if (data.status !== "COMPLETED") throw new Error("Unknown status.");
      record.status = "download-pending";
      this.checkpoint(record);
      const result = await this.queueRequest(queueUrl(record.responseUrl, record.requestId!, false), key);
      if (!result.ok) {
        if (result.status === 422) {
          record.status = "failed";
          record.error = "프롬프트 또는 안전 필터로 음악 생성이 실패했습니다. 직접 재시도하면 새 유료 요청이 생성됩니다.";
          this.checkpoint(record);
          return this.state();
        }
        throw new Error("Result unavailable.");
      }
      const output = JSON.parse(result.body.toString("utf8"));
      const remote = audioUrl(typeof output.audio === "string" ? output.audio : output.audio?.url);
      record.audioUrl = remote;
      this.checkpoint(record);
      const download = await this.request(remote, { method: "GET" }, MAX_AUDIO_BYTES, DOWNLOAD_TIMEOUT_MS);
      if (!download.ok || !isMp3(download.body)) throw new Error("Invalid MP3 download.");
      writeAtomic(path.join(this.mediaRoot, `${record.id}.mp3`), download.body);
      this.checkedFile(record.id);
      record.status = "ready";
      delete record.error;
      this.checkpoint(record);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      record.error = record.status === "download-pending" ? "MP3를 아직 저장하지 못했습니다. 새로고침은 음악을 다시 생성하지 않고 원래 요청의 파일을 복구합니다." : "요청 상태를 확인하지 못했습니다. 새로고침은 음악을 다시 생성하지 않고 원래 요청만 확인합니다.";
      this.checkpoint(record);
    }
    return this.state();
  }

  private checkedFile(id: string): string {
    const file = path.join(this.mediaRoot, `${id}.mp3`);
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_AUDIO_BYTES || path.dirname(fs.realpathSync(file)) !== this.mediaRoot || !isMp3(fs.readFileSync(file))) throw new Error("Invalid file.");
      return file;
    } catch { throw new Error("The saved BGM MP3 is missing or invalid. Refresh the existing request to recover it."); }
  }

  private load(): void {
    const file = path.join(this.root, "ledger.json");
    try {
      const journals = fs.readdirSync(this.journalRoot).filter((name) => name.endsWith(".json"));
      if (!fs.existsSync(file)) {
        if (journals.length) throw new Error("Missing ledger with existing submissions.");
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.candidates) || !Number.isFinite(parsed.totalReservedUsd) || parsed.totalReservedUsd < 0) throw new Error("Invalid ledger.");
      const records = new Map<string, RecordEntry>();
      for (const value of parsed.candidates) {
        const record = this.validateRecord(value);
        if (records.has(record.id)) throw new Error("Duplicate candidate.");
        records.set(record.id, record);
      }
      if (Math.round(parsed.totalReservedUsd * 100) !== records.size * COST_CENTS) throw new Error("Invalid reservation total.");
      for (const name of journals) {
        if (!safeId(name.slice(0, -5))) throw new Error("Invalid journal.");
        const record = this.validateRecord(JSON.parse(fs.readFileSync(path.join(this.journalRoot, name), "utf8")));
        const previous = records.get(record.id);
        if (!previous || record.id !== name.slice(0, -5) || previous.batchId !== record.batchId || previous.prompt !== record.prompt) throw new Error("Invalid journal identity.");
        if (record.revision > previous.revision) records.set(record.id, record);
      }
      if (parsed.selectedId !== undefined && (!safeId(parsed.selectedId) || !records.has(parsed.selectedId))) throw new Error("Invalid selection.");
      this.ledger = { version: 1, totalReservedUsd: records.size * COST_CENTS / 100, candidates: [...records.values()], selectedId: parsed.selectedId };
      for (const record of this.ledger.candidates) {
        if (record.status === "submitting") {
          record.status = record.requestId ? "queued" : "uncertain";
          record.error = record.requestId ? "새로고침으로 저장된 요청의 상태를 확인할 수 있습니다." : "접수 중 앱이 종료되어 요청 결과가 불확실합니다. 자동으로 다시 제출하지 않습니다.";
        }
        // A crash after media rename but before its ready checkpoint must not strand audio.
        if (record.requestId && !["ready", "failed"].includes(record.status)) {
          try { this.checkedFile(record.id); record.status = "ready"; delete record.error; }
          catch { /* No valid committed MP3 yet; preserve the request's recoverable state. */ }
        }
        if (record.status === "ready") {
          try { this.checkedFile(record.id); } catch {
            record.status = "download-pending";
            record.error = "저장된 MP3가 없거나 손상되었습니다. 새로고침으로 원래 요청의 파일을 복구할 수 있습니다.";
          }
        }
      }
      if (this.ledger.selectedId && this.find(this.ledger.selectedId).status !== "ready") delete this.ledger.selectedId;
      this.saveLedger();
    } catch { throw new Error("The BGM ledger or storage is invalid. Existing reservations were preserved; no requests were submitted."); }
  }

  private validateRecord(value: any): RecordEntry {
    if (!value || !safeId(value.id) || !safeId(value.batchId) || !Number.isInteger(value.index) || value.index < 1 || value.index > 3 || typeof value.prompt !== "string" || !value.prompt.length || value.prompt.length > 5000 || !STATUSES.includes(value.status) || !Number.isInteger(value.revision) || value.revision < 0 || value.estimatedCostUsd !== BGM_PRICE_USD || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || (value.requestId !== undefined && !safeId(value.requestId)) || (value.retryOf !== undefined && !safeId(value.retryOf))) throw new Error("Invalid candidate record.");
    if (["queued", "generating", "download-pending", "ready"].includes(value.status) && !value.requestId) throw new Error("Missing request ID.");
    if (value.statusUrl !== undefined) queueUrl(value.statusUrl, value.requestId, true);
    if (value.responseUrl !== undefined) queueUrl(value.responseUrl, value.requestId, false);
    if (value.audioUrl !== undefined) audioUrl(value.audioUrl);
    if (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 500)) throw new Error("Invalid candidate error.");
    return { id: value.id, batchId: value.batchId, index: value.index, prompt: value.prompt, status: value.status, requestId: value.requestId, error: value.error, createdAt: value.createdAt, estimatedCostUsd: BGM_PRICE_USD, revision: value.revision, statusUrl: value.statusUrl, responseUrl: value.responseUrl, audioUrl: value.audioUrl, retryOf: value.retryOf };
  }
}
