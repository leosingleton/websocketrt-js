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
}
