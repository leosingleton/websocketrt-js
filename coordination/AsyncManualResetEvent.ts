import { AsyncEventWaitHandle } from './AsyncEventWaitHandle';

/**
 * Async version of .NET's System.Threading.ManualResetEvent
 */
export class AsyncManualResetEvent extends AsyncEventWaitHandle {
  public constructor(initialState = false) {
    super(false, initialState);
  }
}
