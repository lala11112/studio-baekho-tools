import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AiRouter, parseAiPreferences } from '../electron/services/ai-router';
import type { CodexService } from '../electron/services/codex';
import type { ClaudeCodeService } from '../electron/services/claude-code';

function fakes() {
  const calls: string[] = [];
  const service = (name: string) => ({
    generateConcept: async () => { calls.push(`${name}:concept`); return 'c'; },
    generateImage: async () => { calls.push(`${name}:image`); return 'i'; },
    extractLayout: async () => { calls.push(`${name}:extract`); return {}; },
    generateLayout: async () => { calls.push(`${name}:layout`); return {}; },
    cancel: () => { calls.push(`${name}:cancel`); },
    close: () => { calls.push(`${name}:close`); },
  });
  return { calls, codex: service('codex') as unknown as CodexService, claude: service('claude') as unknown as ClaudeCodeService };
}

test('AI preferences accept only known providers and safe Claude model names', () => {
  assert.deepEqual(parseAiPreferences({ analysisProvider: 'claude', claudeModel: ' opus ' }), { analysisProvider: 'claude', claudeModel: 'opus' });
  assert.deepEqual(parseAiPreferences({ analysisProvider: 'codex' }), { analysisProvider: 'codex', claudeModel: '' });
  assert.throws(() => parseAiPreferences({ analysisProvider: 'gemini' }));
  assert.throws(() => parseAiPreferences({ analysisProvider: 'claude', claudeModel: 'opus --dangerously' }));
});

test('image generation always uses Codex while analysis follows the saved provider', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'baekho-router-'));
  try {
    const { calls, codex, claude } = fakes();
    const router = new AiRouter(codex, claude, directory);
    await router.load();
    await router.generateConcept({}); await router.generateImage({}); await router.extractLayout({}, ''); await router.generateLayout({});
    assert.deepEqual(calls.splice(0), ['codex:concept', 'codex:image', 'codex:extract', 'codex:layout']);

    await router.setPreferences({ analysisProvider: 'claude', claudeModel: 'sonnet' });
    assert.equal(router.claudeModel(), 'sonnet');
    await router.generateConcept({}); await router.generateImage({}); await router.extractLayout({}, ''); await router.generateLayout({});
    assert.deepEqual(calls.splice(0), ['claude:concept', 'codex:image', 'claude:extract', 'claude:layout']);

    router.cancel();
    assert.deepEqual(calls.splice(0), ['codex:cancel', 'claude:cancel']);

    const reloaded = new AiRouter(codex, claude, directory);
    await reloaded.load();
    assert.deepEqual(reloaded.getPreferences(), { analysisProvider: 'claude', claudeModel: 'sonnet' });
    assert.match(await readFile(path.join(directory, 'ai-preferences.json'), 'utf8'), /"claude"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
