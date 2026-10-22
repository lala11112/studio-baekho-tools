import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const DEFAULT_UNITY_ENDPOINT = 'http://127.0.0.1:8080/mcp';
export const UNITY_BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** This session is owned by the desktop bridge; it never shares AI tool routing. */
export interface UnityMcpClient {
  readResource(uri: string): Promise<unknown>;
  callTool(name: string, parameters: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void> | void;
}

export function validatedUnityEndpoint(value: unknown = DEFAULT_UNITY_ENDPOINT): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Unity MCP 주소를 입력해 주세요.');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('올바른 Unity MCP 주소가 아닙니다.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash)
    throw new Error('Unity MCP는 이 컴퓨터의 HTTP 주소만 사용할 수 있습니다. 예: http://127.0.0.1:8080/mcp');
  return url.href;
}

function decodedResult(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const response = value as Record<string, unknown>;
  if (response.isError) {
    const text = Array.isArray(response.content) ? response.content.map(item => (item as { text?: string }).text ?? '').join('\n') : '';
    throw new Error(text || 'Unity MCP 요청이 실패했습니다.');
  }
  if (response.structuredContent) return response.structuredContent;
  const blocks = response.contents ?? response.content;
  if (Array.isArray(blocks)) {
    const text = blocks.map(block => (block as { text?: string }).text ?? '').join('\n');
    if (text) {
      try { return JSON.parse(text); } catch { throw new Error('Unity MCP가 올바른 JSON 응답을 반환하지 않았습니다.'); }
    }
  }
  return value;
}

export async function connectUnityMcp(endpoint: string): Promise<UnityMcpClient> {
  const url = new URL(validatedUnityEndpoint(endpoint));
  const transport = new StreamableHTTPClientTransport(url, {
    // No automatic request replay: a dropped build response must be recovered by request ID.
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  const client = new Client({ name: 'baekho-map-forge-unity', version: '1.0.0' });
  try { await client.connect(transport, { timeout: 10_000 }); }
  catch (error) { await client.close().catch(() => undefined); throw error; }
  return {
    async readResource(uri) { return decodedResult(await client.readResource({ uri }, { timeout: 15_000 })); },
    async callTool(name, parameters, timeoutMs = 30_000) {
      return decodedResult(await client.callTool({ name, arguments: parameters }, undefined,
        { timeout: timeoutMs, maxTotalTimeout: timeoutMs, resetTimeoutOnProgress: false }));
    },
    async close() { await client.close(); },
  };
}
