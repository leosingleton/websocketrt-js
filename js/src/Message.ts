// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { MessageCallback, MessageCallbackEvents, MessageCallbackHandler } from './MessageCallbackHandler';

/** Holds one complete message. Messages are broken up into one or more frames while in transport. */
export class Message {
  /**
   * Constructor (Unlike the C# implementation, which has two overloaded constructors, TypeScript uses a union type to
   * implement both as a single constructor)
   * @param payloadLength Optional payload length. If set, a buffer will be automatically created for `payload`.
   *    For outgoing messages, the caller may also pass in a `Uint8Array` containing payload data.
   * @param outgoing `true` for outgoing messages; `false` for incoming
   */
  public constructor(payload?: Uint8Array | number, outgoing = true) {
    this.outgoing = outgoing;

    if (typeof payload === 'number' && payload > 0) {
      this._payload = new Uint8Array(payload);
    } else if (typeof payload === 'object') {
      if (!outgoing) {
        // Payload may only be specified when creating outgoing messages
        throw new Error('Payload on incoming');
      }
      this._payload = payload;
    }
  }

  /** `true` for outgoing messages; `false` for incoming */
  public readonly outgoing: boolean;

  /** Optional header (64 bytes max) */
  public getHeader(): Uint8Array {
    return this._header;
  }

  /**
   * Internal. Do not call outside the transport layer. Unfortunately set has to be public, as TypeScript doesn't have
   * the equivalent of C#'s internal scope.
   */
  public _setHeader(value: Uint8Array): void {
    if (this.outgoing) {
      // Cannot set Header on outgoing Message
      throw new Error('Header on outgoing');
    }
    this._header = value;
  }
  private _header: Uint8Array;

  /**
   * Payload data. Note that the size of the array is the expected length, not the actual length received.
   * Always check `getBytesReceived()` for the actual number received so far, and don't read past that
   * point in this array.
   */
  public getPayload(): Uint8Array {
    return this._payload;
  }
  private _payload: Uint8Array;

  /** Number of payload bytes received */
  public getBytesReceived(): number {
    return this.outgoing ? this._payload.length : this._bytesReceived;
  }

  /** Internal. Do not access outside the transport layer. */
  public _bytesReceived = 0;

  /** `true` if the payload has been fully received; `false` otherwise */
  public isComplete(): boolean {
    return this._payload.length === this.getBytesReceived();
  }

  /** `true` if the message has been cancelled and will never complete */
  public isCancelled(): boolean {
    return this._isCancelled;
  }

  /** Internal. Do not set outside the transport layer. */
  public _isCancelled = false;

  /** Reads the payload property as a JSON object */
  public getPayloadAsJson(): any {
    // Unpack the server's message
    const payloadString: string = String.fromCharCode.apply(null, this._payload);
    return JSON.parse(payloadString);
  }

  /** Writes the JSON notation for an object into the payload property */
  public setPayloadAsJson(obj: any): void {
    const payloadString = JSON.stringify(obj);

    // TODO: This part can probably be optimized. See: http://code.google.com/p/stringencoding/
    const payloadLength = payloadString.length;
    this._payload = new Uint8Array(payloadString.length);
    for (let n = 0; n < payloadLength; n++) {
      this._payload[n] = payloadString.charCodeAt(n);
    }
  }

  /**
   * Registers a callback to be executed on message events
   * @param callback Callback function
   * @param events Events that trigger the callback
   */
  public registerCallback(callback: MessageCallback, events = MessageCallbackEvents.Complete): void {
    if (this.outgoing) {
      // Cannot register callbacks on outgoing messages
      throw new Error('Callback on outgoing');
    }

    if (events === 0) {
      // Event mask is required
      throw new Error('Event mask');
    }

    if ((events & MessageCallbackEvents.NewMessage) !== 0) {
      // Cannot register for the NewMessage event at the message level
      throw new Error('New at message');
    }

    this._callbacks.registerCallback(callback, events);
  }

  /**
   * Internal. Invoked from the dispatch loop to execute registered callbacks.
   * @param callbacks Collection of registered callbacks. If `null`, the callbacks registered to this particular message
   *    are executed.
   * @returns Number of callback functions executed
   */
  public _executeCallbacks(callbacks: MessageCallbackHandler = null): number {
    if (this.outgoing) {
      throw new Error('Outgoing assert');
    }

    // Compute which events to send
    let events = MessageCallbackEvents.PayloadReceived;
    if (!this._sentNewMessageCallback) {
      if (callbacks) {
        // This is hacky, but we get called twice, once for message-level callbacks where
        // callbacks == null, followed by a second time for connection-level callbacks where
        // callbacks != null. To ensure we deliver to both, we only set the boolean on the second call to
        // this function. There are no race conditions, since the dispatch loop is single-threaded.
        this._sentNewMessageCallback = true;
      }
      events |= MessageCallbackEvents.NewMessage;
    }
    if (!this._sentCompleteCallback && this.isComplete()) {
      if (callbacks) {
        // Same hack as above, by for Complete events
        this._sentCompleteCallback = true;
      }
      events |= MessageCallbackEvents.Complete;
    }
    if (this.isCancelled()) {
      if ((events & MessageCallbackEvents.NewMessage) !== 0) {
        // If we never delivered the NewMessage event, and the message is already cancelled, let's just not
        // tell anyone...
        return 0;
      }

      // Likewise, no reason to deliver a PayloadReceived event if the message is never going to complete...
      events = MessageCallbackEvents.Cancelled;
    }

    // Send the callbacks
    if (!callbacks) {
      return this._callbacks.executeCallbacks(this, events);
    } else {
      return callbacks.executeCallbacks(this, events);
    }
  }

  private _callbacks = new MessageCallbackHandler();

  // The two booleans below ensure we only ever deliver one set of NewMessage and one set of Complete callbacks
  private _sentNewMessageCallback = false;
  private _sentCompleteCallback = false;
}
