import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
export class Vault {
  private session = "";
  private storage = "none";
  private file: string;
  constructor(root: string) {
    this.file = path.join(root, "tripo.key");
    if (fs.existsSync(this.file) && safeStorage.isEncryptionAvailable()) {
      try {
        this.session = safeStorage.decryptString(fs.readFileSync(this.file));
        this.storage = "Windows DPAPI";
      } catch {
        this.storage = "복호화 실패 · 키를 다시 입력하세요.";
      }
    }
  }
  get() {
    return this.session;
  }
  info() {
    return { configured: !!this.session, storage: this.storage };
  }
  save(value: string) {
    if (value.length < 12 || value.length > 512 || /[\r\n\s]/.test(value))
      throw new Error("API 키 형식을 확인하세요.");
    this.session = value;
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(this.file + ".tmp", safeStorage.encryptString(value));
      fs.renameSync(this.file + ".tmp", this.file);
      this.storage = "Windows DPAPI";
    } else {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      this.storage = "세션 한정 · 종료하면 삭제";
    }
    return this.info();
  }
  delete() {
    this.session = "";
    this.storage = "none";
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    return this.info();
  }
}
