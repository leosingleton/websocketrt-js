import { AsyncEventWaitHandle } from './AsyncEventWaitHandle';

/**
 * Async version of .NET's System.Threading.AutoResetEvent
 */
export class AsyncAutoResetEvent extends AsyncEventWaitHandle {
  public constructor(initialState = false) {
    super(true, initialState);
  }
}
