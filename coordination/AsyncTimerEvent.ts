import { AsyncEventWaitHandle } from './AsyncEventWaitHandle';

/** 
 * Timer that behaves line an EventWaitHandle. Useful for the AsyncEventWaitHandle.WhenAny() method.
 */
export class AsyncTimerEvent extends AsyncEventWaitHandle {
  public constructor(millisecondsDelay: number, repeat = false) {
    super(repeat, false);

    this._millisecondsDelay = millisecondsDelay;
    this._repeat = repeat;

    setTimeout(() => this._timerLoop(), millisecondsDelay);
  }

  private _timerLoop(): void {
    this.set();

    if (this._repeat) {
      setTimeout(() => this._timerLoop(), this._millisecondsDelay);
    }
  }

  private _millisecondsDelay: number;
  private _repeat: boolean;

  /**
   * Blocks the current execution for the specified number of milliseconds. Equivalent to Task.Delay() in C#.
   * @param millisecondsDelay Number of milliseconds to delay
   */
  public static delay(millisecondsDelay: number): Promise<void> {
    let event = new AsyncTimerEvent(millisecondsDelay);
    return event.waitAsync();
  }
}
