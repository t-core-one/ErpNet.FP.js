import { describe, it, expect } from 'vitest';
import { ServiceController } from '../../src/Service/ServiceController.js';
import { ServiceOptions } from '../../src/Configuration/ServiceOptions.js';
import { TaskStatus } from '../../src/Service/TaskStatus.js';

// Fix A: a finished task's result must survive being read, so a client that
// lost the poll response can re-issue the same taskId and rejoin it instead of
// re-running the job (which would print a duplicate fiscal document).

function svc() {
  return new ServiceController(new ServiceOptions());
}

describe('ServiceController task retention (idempotent retry safety)', () => {
  it('retains a finished task across repeated reads (no delete-on-read)', () => {
    const s = svc();
    s._tasks['T1'] = { status: TaskStatus.Finished, result: { taskId: 'T1', ok: true }, finishedAt: Date.now() };
    expect(s.getTaskInfo('T1').taskStatus).toBe(TaskStatus.Finished);
    // Second read (the retry) must STILL find it — this is what prevents a
    // re-run + duplicate print after a lost response.
    const again = s.getTaskInfo('T1');
    expect(again.taskStatus).toBe(TaskStatus.Finished);
    expect(again.result.ok).toBe(true);
  });

  it('runAsync returns the cached result for a re-issued finished taskId (no re-run)', async () => {
    const s = svc();
    s._tasks['T2'] = { status: TaskStatus.Finished, result: { taskId: 'T2' }, finishedAt: Date.now() };
    // A print job whose run() would throw if executed — proves it is NOT re-run.
    const job = { taskId: 'T2', asyncTimeout: 100, run: async () => { throw new Error('must not run again'); } };
    const res = await s.runAsync(job);
    expect(res).toEqual({ taskId: 'T2' });
  });

  it('sweeps a finished task only after the retention TTL', () => {
    const s = svc();
    s._tasks['fresh'] = { status: TaskStatus.Finished, result: {}, finishedAt: Date.now() };
    s._tasks['stale'] = { status: TaskStatus.Finished, result: {}, finishedAt: Date.now() - 11 * 60 * 1000 };
    s.getTaskInfo('fresh'); // triggers a sweep
    expect(s.getTaskInfo('fresh').taskStatus).toBe(TaskStatus.Finished);
    expect(s.getTaskInfo('stale').taskStatus).toBe(TaskStatus.Unknown);
  });
});
