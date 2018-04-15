/**
 * Async version of .NET's System.Threading.EventWaitHandle
 */
export abstract class AsyncEventWaitHandle {
  protected constructor(autoReset: boolean, initialState: boolean) {
    this._autoReset = autoReset;
    this._isSet = initialState;
    this._waiters = [];
  }

  public getIsSet(): boolean {
    return this._isSet;
  }

  public set(): void {
    let waiter: Waiter;
    while (waiter = this._waiters.shift()) {
      // For auto-reset, abort after the first Task is released. For manual-reset, release all Tasks.
      if (waiter.trySetComplete() && this._autoReset) {
        return;
      }
    }

    this._isSet = true;
  }

  public reset(): void {
    this._isSet = false;
  }

  private _waitInternal(waiter: Waiter, createWaiter = false): Promise<void> {
    if (this._isSet) {
      if (this._autoReset) {
        this._isSet = false;
      }

      if (waiter) {
        waiter.trySetComplete();
        return waiter.getPromise();
      } else {
        return Promise.resolve();
      }
    }

    if (createWaiter) {
      let w = new Waiter();
      this._waiters.push(w);
      return w.getPromise();
    }

    if (waiter) {
      this._waiters.push(waiter);
    }

    return undefined;
  }

  public waitAsync() {
    return this._waitInternal(null, true);
  }

  public static whenAny(events: AsyncEventWaitHandle[]): Promise<void> {
    // Before creating a Task and enqueing it, which results in unnecessary heap allocations and garbage collection,
    // make a quick pass through all events to check if any are already set
    for (var n = 0; n < events.length; n++) {
      let e = events[n];
      let promise = e._waitInternal(null);
      if (promise) {
        return promise;
      }
    }

    let waiter = new Waiter();

    for (var n = 0; n < events.length; n++) {
      let e = events[n];
      let promise = e._waitInternal(waiter);
      if (promise) {
        return promise;
      }
    }

    return waiter.getPromise();
  }

  private _autoReset: boolean;
  private _isSet: boolean;
  private _waiters: Waiter[];
}

/**
 * Wraps a Promise waiting on an AsyncEventWaitHandle
 */
class Waiter {
  public constructor() {
    this._isComplete = false;
    this._promise = new Promise<void>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  public getPromise(): Promise<void> {
    return this._promise;
  }

  public trySetComplete(): boolean {
    if (this._isComplete) {
      return false;
    }

    this._isComplete = true;
    setTimeout(() => this._resolve());
    return true;
  }

  public trySetCanceled(): boolean {
    if (this._isComplete) {
      return false;
    }

    this._isComplete = true;
    setTimeout(() => this._reject('Operation cancelled'));
    return true;
  }

  private _isComplete: boolean;
  private _resolve: (value?: void) => void;
  private _reject: (reason?: any) => void;
  private _promise: Promise<void>; 
}
