/**
 * Serialises repeated calls to one async job, so two of them never overlap.
 *
 * The extension restarts the language server from several places at once — a
 * settings change, a Python interpreter change, the restart command — and two
 * overlapping restarts would leave a client running that nothing holds a
 * reference to. Kept apart from extension.ts, and free of any vscode import, so
 * the queueing rules can be tested on their own.
 */

/**
 * Wrap `job` so that at most one call runs at a time and at most one waits
 * behind it.
 *
 * A call made while nothing is running starts straight away. A call made while
 * one is running is queued behind it, and any further call made while that one
 * is still waiting joins the same queued run rather than adding another: what a
 * caller wants is "a run that starts after now", and one waiting run gives
 * everybody that. Each caller gets the promise for the run it joined.
 *
 * A run that rejects still frees the slot, so one failure cannot wedge the
 * queue, and it does not stop the run queued behind it.
 */
export function createRunQueue(job: () => Promise<void>): () => Promise<void> {
    let activeRun: Promise<void> | undefined;
    let queuedRun: Promise<void> | undefined;

    // Chain one run onto `previous`, keeping the two variables above honest as
    // it moves from queued, to running, to finished. The queue slot is freed at
    // the moment the run actually begins rather than when it ends, so a request
    // arriving mid-run queues behind it instead of joining it.
    const chain = (previous: Promise<void>): Promise<void> => {
        const run: Promise<void> = previous.then(() => {
            if (queuedRun === run) {
                queuedRun = undefined;
            }
            activeRun = run;
            return job();
        });
        const clear = () => {
            if (activeRun === run) {
                activeRun = undefined;
            }
        };
        // Also marks the rejection as handled, so a failing run on its own is
        // not an unhandled rejection.
        void run.then(clear, clear);
        return run;
    };

    return (): Promise<void> => {
        if (activeRun) {
            if (!queuedRun) {
                // The catch keeps a failed run from cancelling the next one.
                queuedRun = chain(activeRun.catch(() => undefined));
            }
            return queuedRun;
        }
        activeRun = chain(Promise.resolve());
        return activeRun;
    };
}
