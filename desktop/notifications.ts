interface NotificationHandle {
  show(): void;
  close(): void;
  on(event: 'click' | 'failed', listener: () => void): unknown;
}
interface NotificationOptions {
  title: string;
  body: string;
  silent: boolean;
}

/** Generic lock-screen-safe text, bounded frequency, and navigation only—never approval. */
export class ApprovalNotifications {
  #notification: NotificationHandle | undefined;
  #lastShown = -Infinity;
  constructor(
    private readonly desktop: {
      supported(): boolean;
      create(options: NotificationOptions): NotificationHandle;
      openApprovals(): void;
      flash(): void;
    },
  ) {}
  notify(): void {
    this.desktop.flash();
    if (Date.now() - this.#lastShown < 5000) return;
    this.#lastShown = Date.now();
    try {
      if (!this.desktop.supported()) return;
      this.close();
      const notification = this.desktop.create({
        title: 'AgentKey approval needed',
        body: 'A new request is waiting. Open AgentKey to review it.',
        silent: false,
      });
      this.#notification = notification;
      notification.on('click', () => {
        if (this.#notification !== notification) return;
        this.close();
        this.desktop.openApprovals();
      });
      notification.on('failed', () => {
        if (this.#notification === notification) this.#notification = undefined;
      });
      notification.show();
    } catch {
      this.close();
    }
  }
  private close(): void {
    const previous = this.#notification;
    this.#notification = undefined;
    try {
      previous?.close();
    } catch {
      /* Notification support is optional. */
    }
  }
  clear(): void {
    this.close();
    this.#lastShown = -Infinity;
  }
}
