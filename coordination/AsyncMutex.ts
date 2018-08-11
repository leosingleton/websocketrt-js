import { AsyncAutoResetEvent } from './AsyncAutoResetEvent';

/**
 * Async version of .NET's System.Threading.ManualResetEvent
 */
export class AsyncMutex {
  /** Boolean set to true when the mutex is locked */
  private isLocked = false;

  /** Event signalled whenever the mutex is unlocked */
  private unlockedEvent = new AsyncAutoResetEvent();

  /** Acquires the mutex. Blocks until the lock is acquired. */
  async lock(): Promise<void> {
    while (this.isLocked) {
      await this.unlockedEvent.waitAsync();
    }

    this.isLocked = true;
  }

  unlock(): void {
    this.isLocked = false;
    this.unlockedEvent.set();
  }
}
