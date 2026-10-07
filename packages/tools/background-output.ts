/** At most one IPC packet plus 64K pending characters, even with a stalled owner. */
export class BufferedOutput {
  private pending = '';
  private dropped = 0;
  private active = false;
  private waiters: (() => void)[] = [];
  private send: (message: { text: string; dropped: number }, done: () => void) => void;
  constructor(send: (message: { text: string; dropped: number }, done: () => void) => void) {
    this.send = send;
  }
  write(text: string): void {
    this.pending += text;
    if (this.pending.length > 65536) {
      this.dropped += this.pending.length - 65536;
      this.pending = this.pending.slice(-65536);
    }
  }
  flush(): void {
    if (this.active) return;
    if (!this.pending && !this.dropped) {
      for (const resolve of this.waiters.splice(0)) resolve();
      return;
    }
    const message = { text: this.pending, dropped: this.dropped };
    this.pending = '';
    this.dropped = 0;
    this.active = true;
    this.send(message, () => {
      this.active = false;
      this.flush();
    });
  }
  async drain(): Promise<void> {
    if (!this.active && !this.pending && !this.dropped) return;
    const done = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.flush();
    await done;
  }
}
