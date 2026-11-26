import type { GenerationProgress, GenerationStage } from './shared/types';

const labels: Record<GenerationStage, string> = {
  preparing: '연결·준비', concept: '컨셉 작성', image: '설계도 생성', extract: '이미지 분석',
  layout: '구조 설계', placement: '로컬 배치', validation: '조건 검증',
};
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const duration = (ms: number) => ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}초` : `${Math.floor(ms / 60000)}분 ${Math.floor(ms % 60000 / 1000)}초`;

/** Keep progress separate from full viewport renders and measure total wall time independently. */
export class GenerationMonitor {
  private events = new Map<string, { event: GenerationProgress; receivedAt: number }>();
  private startedAt?: number;
  private finishedAt?: number;
  private method: 'image' | 'direct' = 'image';
  private outcome: 'completed' | 'failed' | 'cancelled' = 'completed';
  constructor(private readonly now: () => number = () => performance.now()) {}
  get active(): boolean { return this.startedAt !== undefined && this.finishedAt === undefined; }
  begin(method: 'image' | 'direct'): void {
    this.events.clear(); this.method = method; this.startedAt = this.now(); this.finishedAt = undefined;
  }
  receive(event: GenerationProgress): void {
    if (!this.active || !Object.hasOwn(labels, event.stage)) return;
    const previous = this.events.get(event.id);
    if (previous && previous.event.state !== 'running') return;
    this.events.set(event.id, { event: structuredClone(event), receivedAt: this.now() });
  }
  finish(outcome: 'completed' | 'failed' | 'cancelled'): void {
    if (!this.active) return;
    this.finishedAt = this.now(); this.outcome = outcome;
    for (const entry of this.events.values()) if (entry.event.state === 'running') {
      entry.event.elapsedMs += this.finishedAt - entry.receivedAt;
      entry.event.state = outcome;
    }
  }
  render(): string {
    if (this.startedAt === undefined) return '';
    const now = this.finishedAt ?? this.now();
    const stages = new Map<GenerationStage, { elapsed: number; running: boolean; failed: boolean }>();
    let model: string | undefined, effort: string | undefined;
    for (const { event, receivedAt } of this.events.values()) {
      const aggregate = stages.get(event.stage) ?? { elapsed: 0, running: false, failed: false };
      aggregate.elapsed += event.elapsedMs + (event.state === 'running' ? Math.max(0, now - receivedAt) : 0);
      aggregate.running ||= event.state === 'running'; aggregate.failed ||= event.state === 'failed';
      stages.set(event.stage, aggregate);
      model = event.model ?? model; effort = event.reasoningEffort ?? effort;
    }
    const status = this.active ? '진행 중' : this.outcome === 'completed' ? '완료' : this.outcome === 'cancelled' ? '취소' : '실패';
    return `<details class="advanced generation-timings" open><summary>${this.method === 'direct' ? '빠른 생성' : '이미지 기반'} · ${status} · ${duration(Math.max(0, now - this.startedAt))}</summary>
      <dl>${[...stages].map(([stage, data]) => `<div><dt>${labels[stage]}${data.running ? ' · 진행 중' : data.failed ? ' · 실패' : ''}</dt><dd>${duration(data.elapsed)}</dd></div>`).join('')}</dl>
      ${model ? `<p class="caption">모델 ${escape(model)}${effort ? ` · 추론 ${escape(effort)}` : ''}</p>` : ''}
      <p class="caption">단계별 시간은 이번 작업의 합계입니다.</p></details>`;
  }
}
