/** Retry failed resource cleanup from its last confirmed boundary, sharing concurrent attempts. */
export class RetryableCleanup {
  private completed = new Set<string>();
  private pending: Promise<void> | undefined;

  run(steps: readonly { id: string; run: () => Promise<void> }[]): Promise<void> {
    if (this.pending) return this.pending;
    const pending = (async () => {
      for (const step of steps) {
        if (this.completed.has(step.id)) continue;
        await step.run();
        this.completed.add(step.id);
      }
    })();
    this.pending = pending;
    const settled = () => {
      if (this.pending === pending) this.pending = undefined;
    };
    void pending.then(settled, settled);
    return pending;
  }
}
