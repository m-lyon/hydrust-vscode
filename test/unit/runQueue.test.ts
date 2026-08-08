import { describe, expect, it } from 'vitest';

import { createRunQueue } from '../../src/common/runQueue';

/**
 * A job whose runs are finished by hand, so a test can hold one open and see
 * what the queue does with everything that arrives meanwhile.
 */
function controllableJob() {
    const settle: { resolve: () => void; reject: (err: Error) => void }[] = [];
    let started = 0;

    const job = (): Promise<void> => {
        started += 1;
        return new Promise<void>((resolve, reject) => {
            settle.push({ resolve, reject });
        });
    };

    return {
        job,
        /** How many times the job has actually been entered. */
        starts: () => started,
        /** Finish the nth run, counting from zero. */
        finish: (index: number) => settle[index].resolve(),
        /** Fail the nth run. */
        fail: (index: number, message = 'boom') => settle[index].reject(new Error(message)),
    };
}

/** Let every pending microtask run, so chained promises get their turn. */
async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
    }
}

describe('createRunQueue', () => {
    it('starts the first run straight away', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        const first = run();
        await flush();

        expect(worker.starts()).toBe(1);

        worker.finish(0);
        await expect(first).resolves.toBeUndefined();
    });

    it('holds a second request back until the first has finished', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        const first = run();
        await flush();
        const second = run();
        await flush();

        // Still only the first run: the second is waiting, not running.
        expect(worker.starts()).toBe(1);

        worker.finish(0);
        await flush();
        expect(worker.starts()).toBe(2);

        worker.finish(1);
        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
    });

    it('folds further requests into the one already waiting', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        run();
        await flush();
        const second = run();
        const third = run();
        const fourth = run();

        // All three joined the same queued run, and get its promise.
        expect(second).toBe(third);
        expect(third).toBe(fourth);

        worker.finish(0);
        await flush();
        expect(worker.starts()).toBe(2);

        worker.finish(1);
        await flush();

        // Nothing else was left queued behind them.
        expect(worker.starts()).toBe(2);
    });

    it('queues a request that arrives once the waiting run has started', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        const first = run();
        await flush();
        const second = run();

        worker.finish(0);
        await flush();
        // The queued run is now the running one, so its slot is free again.
        const third = run();
        expect(third).not.toBe(second);
        await flush();
        expect(worker.starts()).toBe(2);

        worker.finish(1);
        await flush();
        expect(worker.starts()).toBe(3);

        worker.finish(2);
        await expect(first).resolves.toBeUndefined();
        await expect(third).resolves.toBeUndefined();
    });

    it('still runs the queued request when the one before it fails', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        const first = run();
        await flush();
        const second = run();

        worker.fail(0);
        await expect(first).rejects.toThrow('boom');
        await flush();

        expect(worker.starts()).toBe(2);
        worker.finish(1);
        await expect(second).resolves.toBeUndefined();
    });

    it('is not wedged by a failed run', async () => {
        const worker = controllableJob();
        const run = createRunQueue(worker.job);

        const first = run();
        await flush();
        worker.fail(0);
        await expect(first).rejects.toThrow('boom');
        await flush();

        // The slot was freed, so the next request runs rather than waiting on a
        // run that will never finish.
        const second = run();
        await flush();
        expect(worker.starts()).toBe(2);

        worker.finish(1);
        await expect(second).resolves.toBeUndefined();
    });
});
