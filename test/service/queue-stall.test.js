import { describe, it, expect, vi } from 'vitest';
import { ServiceController } from '../../src/Service/ServiceController.js';
import { TaskStatus } from '../../src/Service/TaskStatus.js';

/**
 * The job queue must never wedge.
 *
 * _processQueue() guards re-entry with `_isProcessing`. That flag used to be
 * cleared by a plain assignment after the loop, while the inner try/catch
 * covered only `job.run()` — so a throw from the bookkeeping around it, or
 * from the loop itself, skipped the assignment and left the flag true forever.
 * Every subsequent call then returned at the guard, the queue stopped draining,
 * and the shop could not print again until the service was restarted. Nothing
 * logged a reason.
 *
 * Nothing on that path throws today. This test injects a throw to hold the
 * invariant anyway, because this method is the chokepoint every fiscal
 * operation passes through and the natural place to hang new work.
 */
function controller() {
  const c = Object.create(ServiceController.prototype);
  c._tasks = {};
  c._taskQueue = [];
  c._isProcessing = false;
  return c;
}

const job = (taskId, run) => ({ taskId, run: run || (async () => ({ ok: true })) });

describe('ServiceController job queue cannot wedge', () => {
  it('drains normally', async () => {
    const c = controller();
    c._tasks.a = { status: TaskStatus.Enqueued, result: null };
    c._taskQueue.push(job('a'));

    await c._processQueue();

    expect(c._tasks.a.status).toBe(TaskStatus.Finished);
    expect(c._isProcessing).toBe(false);
  });

  it('releases the guard when a job throws', async () => {
    const c = controller();
    c._tasks.a = { status: TaskStatus.Enqueued, result: null };
    c._taskQueue.push(job('a', async () => { throw new Error('device on fire'); }));

    await c._processQueue();

    expect(c._tasks.a.result).toEqual({ error: 'device on fire' });
    expect(c._isProcessing).toBe(false);
  });

  it('releases the guard when the bookkeeping AROUND the job throws', async () => {
    // The real defect. The inner try/catch does not cover this, so before the
    // finally the flag stayed true and the queue was dead for good.
    const c = controller();
    let poisoned = false;
    c._tasks.a = {
      status: TaskStatus.Enqueued,
      result: null,
      set finishedAt(_v) { if (poisoned) throw new Error('bookkeeping blew up'); },
      get finishedAt() { return 0; },
    };
    poisoned = true;
    c._taskQueue.push(job('a'));

    await expect(c._processQueue()).rejects.toThrow('bookkeeping blew up');

    // The guard must be clear regardless of how the method exited...
    expect(c._isProcessing).toBe(false);

    // ...and the queue must still work afterwards. This is the assertion that
    // actually matters: a stuck flag means the till never prints again.
    c._tasks.b = { status: TaskStatus.Enqueued, result: null };
    c._taskQueue.push(job('b'));
    await c._processQueue();
    expect(c._tasks.b.status).toBe(TaskStatus.Finished);
  });

  it('a failing processor cannot become an unhandled rejection', async () => {
    // Both call sites invoke _processQueue() without awaiting it. Under Node 20
    // an unhandled rejection terminates the process — the entire print server.
    const c = controller();
    c._processQueue = async () => { throw new Error('boom'); };
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);

    ServiceController.prototype._startTaskProcessor.call(c);
    await new Promise(r => setTimeout(r, 20));

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
