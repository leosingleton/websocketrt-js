// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { AsyncAutoResetEvent, AsyncEventWaitHandle, AsyncManualResetEvent, Queue } from '@leosingleton/commonlibs';
import { FramedSocketError, IFramedSocket } from './IFramedSocket';

/* eslint-disable @typescript-eslint/no-unused-vars */

// React Native doesn't like any require statement whatsoever to the 'ws' library, at it depends on Node's 'util'
// library. The majority of references are in the Simulator/ directory, which we can completely exclude from the React
// Native build, but the code below needs access to the constants, so we simply duplicate their definitions here.
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * Maps a WebSocket to the IFramedSocket interface
 */
export class WSFramedSocket implements IFramedSocket {
  public constructor(ws: WebSocket) {
    this._ws = ws;
    this._isOpen = new AsyncManualResetEvent();
    this._isClosed = new AsyncManualResetEvent();
    this._receiveQueue = new Queue<MessageEvent>();
    this._receiveEvent = new AsyncAutoResetEvent();

    ws.onmessage = e => { this._onServerMessage(e); };
    ws.onopen = () => { this._isOpen.setEvent(); };
    ws.onerror = () => { this._isClosed.setEvent(); };
    ws.onclose = () => { this._isClosed.setEvent(); };
  }

  /**
   * Waits for the WebSocket to enter the open state. Throws an exception if it fails to open.
   */
  public async waitForOpen(): Promise<void> {
    // Wait for either open or closed, whichever happens first
    await AsyncEventWaitHandle.whenAny([this._isOpen, this._isClosed]);

    // The WebSocket must be open before calling this constructor
    if (this._ws.readyState !== WS_OPEN) {
      throw new Error('Failed to establish WebSocket. State=' + this._ws.readyState);
    }
  }

  private _onServerMessage(e: MessageEvent): void {
    this._receiveQueue.enqueue(e);
    this._receiveEvent.setEvent();
  }

  public async receiveFrameAsync(buffer: DataView): Promise<number> {
    // This implementation differs substantially from the equivalent .NET version. JavaScript's WebSocket
    // implementation never returns partial frames, whereas .NET's does. Here, it's just a typical producer/consumer
    // queue pattern.

    while (true) {
      // Handle the connection closing
      if (this._isClosed.getIsSet()) {
        return FramedSocketError.Closing;
      }

      // Get a frame from the receive queue
      const e = this._receiveQueue.dequeue();
      if (e) {
        const data = new Uint8Array(e.data);

        // If the client has exceeded the maximum messsage size set below, terminate its connection
        const bytesReceived = data.length;
        if (bytesReceived > buffer.byteLength) {
          return FramedSocketError.FrameTooLarge;
        }

        // Copy the data into the destination buffer
        const arr = new Uint8Array(buffer.buffer);
        arr.set(data, buffer.byteOffset);

        return bytesReceived;
      }

      await AsyncEventWaitHandle.whenAny([this._receiveEvent, this._isClosed]);
    }
  }

  public sendFrameAsync(buffer: DataView): void {
    if (!this._isClosed.getIsSet()) {
      this._ws.send(buffer);
    }
  }

  public closeAsync(closeReason: string, waitForRemote: boolean): void {
    this._ws.close(1000, closeReason);
  }

  private _ws: WebSocket;
  private _isOpen: AsyncManualResetEvent;
  private _isClosed: AsyncManualResetEvent;
  private _receiveQueue: Queue<MessageEvent>;
  private _receiveEvent: AsyncAutoResetEvent;
}
