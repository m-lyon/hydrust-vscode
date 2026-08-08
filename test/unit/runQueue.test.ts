import { describe, expect, it } from 'vitest';

import { createRunQueue } from '../../src/common/runQueue';

/**
 * A job whose runs are finished by hand, so a test can hold one open and see
 * what the queue does with everything that arrives meanwhile.
 */
function controllableJob() {
    const settle: { resolve: () => void; reject: (err: Error) => void }[] = [];
    let started = 0;
    let active = 0;
    let peak = 0;

    const job = (): Promise<void> => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        return new Promise<void>((resolve, reject) => {
            settle.push({ resolve, reject });
        });
    };

    return {
        job,
        /** How many times the job has actually been entered. */
        starts: () => started,
        /** The most runs that were ever inside the job at the same time. */
        peakOverlap: () => peak,
        /** Finish the nth run, counting from zero. */
        finish: (index: number) => {
            active -= 1;
            settle[index].resolve();
        },
        /** Fail the nth run. */
        fail: (index: number, message = 'boom') => {
            active -= 1;
            settle[index].reject(new Error(message));
        },
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

    it('never overlaps two runs, whenever the next request lands', async () => {
        // A finished run frees its slot a few microtasks before the queued run
        // takes it over. A request arriving in that window used to see nothing
        // running and start straight away, so two jobs ran side by side — the
        // exact thing this module exists to prevent. The window is only a
        // handful of microtasks wide, so the request is tried at each offset.
        for (let ticks = 0; ticks <= 6; ticks += 1) {
            const worker = controllableJob();
            const run = createRunQueue(worker.job);

            run();
            await flush();
            run();

            worker.finish(0);
            for (let tick = 0; tick < ticks; tick += 1) {
                await Promise.resolve();
            }
            run();
            await flush();

            expect(worker.peakOverlap(), `request made ${ticks} microtasks after the first run finished`).toBe(1);
        }
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
