import { Message } from './Message';

/**
 * Enumerated value indicated the reason a message callback is executed
 *
 * This enum is used as a bitmask. It is possible that all flags are set simultaneously if the payload was
 * delivered in one frame. The bitmask may also be used to filter which types of events to receive.
 */
export const enum MessageCallbackEvents {
  /** No bits are set */
  None = 0,

  /** Indicates the first callback for a given message. This may be sent before the payload is fully received. */
  NewMessage = 1,

  /** Indicates that more payload has been received. This flag is set on every callback. */
  PayloadReceived = 2,

  /** Indicates the payload is fully received, and there will be no more callbacks for this message. */
  Complete = 4,

  /** Indicates the message has been cancelled and will never complete. */
  Cancelled = 8,

  /** All bits are set */
  All = NewMessage | PayloadReceived | Complete | Cancelled
}

/**
 * Callback function for message events
 * @param message Message on which the events occurred
 * @param events Bitmask indicating which events occured on the message. At least one of these was requested by the
 *    callback registration, however, it may include additional events the callback did not register for.
 */
export type MessageCallback = (message: Message, events: MessageCallbackEvents) => void;

/** Helper class to register and execute callback functions */
export class MessageCallbackHandler {
  /**
   * Registers a callback to be executed on message events
   * @param callback Callback function
   * @param events Events that trigger the callback
   */
  public registerCallback(callback: MessageCallback, events: MessageCallbackEvents): void {
    this._callbacks.push({
      callback,
      events
    });
  }

  /**
   * Executes all registered message callbacks
   * @param message Message
   * @param events Events that occured on the message
   * @returns Number of callback functions executed
   */
  public executeCallbacks(message: Message, events: MessageCallbackEvents): number {
    let count = 0;

    this._callbacks.forEach(pair => {
      if ((pair.events & events) !== 0) {
        pair.callback(message, events);
        count++;
      }
    });

    return count;
  }

  private _callbacks: CallbackPair[] = [];
}

interface CallbackPair {
  callback: MessageCallback;
  events: MessageCallbackEvents;
}
