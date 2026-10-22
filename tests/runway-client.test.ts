import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayUploadDeadline } from "../engine/runway-client";

function clockFixture() {
  let time = 0, sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = {
    now: () => time,
    set: (callback: () => void, delay: number): unknown => { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id; },
    clear: (id: unknown) => { timers.delete(id as number); },
  };
  return { clock, advance(amount: number) {
    const end = time + amount;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    time = end;
  }, count: () => timers.size };
}

test("upload deadline excludes human approval waiting but resumes only its remaining network budget", () => {
  const f = clockFixture(); let expired = 0;
  const deadline = createRunwayUploadDeadline(() => { expired++; }, 180000, f.clock);
  f.advance(90000); deadline.pause();
  f.advance(1800000); assert.equal(expired, 0); assert.equal(f.count(), 0);
  deadline.resume(); f.advance(89999); assert.equal(expired, 0);
  f.advance(1); assert.equal(expired, 1);
  deadline.resume(); f.advance(180000); assert.equal(expired, 1);
});

test("nested approval waits and cancellation cannot restart a stopped upload deadline", () => {
  const f = clockFixture(); let expired = 0;
  const deadline = createRunwayUploadDeadline(() => { expired++; }, 180000, f.clock);
  f.advance(30000); deadline.pause(); deadline.pause();
  deadline.resume(); f.advance(900000); assert.equal(f.count(), 0); assert.equal(expired, 0);
  deadline.resume(); assert.equal(f.count(), 1); f.advance(1000);
  deadline.pause(); deadline.stop(); deadline.resume(); f.advance(900000);
  assert.equal(expired, 0); assert.equal(f.count(), 0);
});

test("without a permission wait the existing upload deadline still expires", () => {
  const f = clockFixture(); let expired = 0;
  createRunwayUploadDeadline(() => { expired++; }, 180000, f.clock);
  f.advance(179999); assert.equal(expired, 0); f.advance(1); assert.equal(expired, 1);
});
