import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiPreferences } from '../../src/shared/types';
import type { CodexService } from './codex';
import type { ClaudeCodeService } from './claude-code';
import { atomicWrite } from './projects';

export const DEFAULT_AI_PREFERENCES: AiPreferences = { analysisProvider: 'codex', claudeModel: '' };

export function parseAiPreferences(value: unknown): AiPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (input.analysisProvider !== 'codex' && input.analysisProvider !== 'claude') throw new Error('분석 담당 AI는 Codex 또는 Claude Code만 선택할 수 있습니다.');
  const claudeModel = typeof input.claudeModel === 'string' ? input.claudeModel.trim() : '';
  if (claudeModel && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(claudeModel)) throw new Error('Claude 모델 이름을 확인해 주세요. 예: opus, sonnet, claude-opus-5-5');
  return { analysisProvider: input.analysisProvider, claudeModel };
}

/**
 * Image generation always goes to Codex (native image_generation tool).
 * Concept writing, blueprint analysis and direct layout design follow the user's provider preference.
 */
export class AiRouter {
  private preferences: AiPreferences = { ...DEFAULT_AI_PREFERENCES };
  private readonly file: string;
  constructor(readonly codex: CodexService, readonly claude: ClaudeCodeService, dataDirectory: string) {
    this.file = path.join(dataDirectory, 'ai-preferences.json');
  }

  async load(): Promise<void> {
    try { this.preferences = parseAiPreferences(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch { this.preferences = { ...DEFAULT_AI_PREFERENCES }; }
  }

  getPreferences(): AiPreferences { return { ...this.preferences }; }
  claudeModel(): string | undefined { return this.preferences.claudeModel || undefined; }

  async setPreferences(value: unknown): Promise<AiPreferences> {
    const next = parseAiPreferences(value);
    await mkdir(path.dirname(this.file), { recursive: true });
    await atomicWrite(this.file, JSON.stringify(next, null, 2));
    this.preferences = next;
    return this.getPreferences();
  }

  private analysis(): CodexService | ClaudeCodeService { return this.preferences.analysisProvider === 'claude' ? this.claude : this.codex; }

  generateConcept(settings: unknown, catalog?: unknown, context?: unknown) { return this.analysis().generateConcept(settings, catalog, context); }
  generateImage(settings: unknown, region?: unknown, catalog?: unknown, context?: unknown) { return this.codex.generateImage(settings, region, catalog, context); }
  extractLayout(settings: unknown, image: unknown, region?: unknown, catalog?: unknown) { return this.analysis().extractLayout(settings, image, region, catalog); }
  generateLayout(settings: unknown, region?: unknown, catalog?: unknown, context?: unknown) { return this.analysis().generateLayout(settings, region, catalog, context); }
  cancel(): void { this.codex.cancel(); this.claude.cancel(); }
  close(): void { this.codex.close(); this.claude.close(); }
}
