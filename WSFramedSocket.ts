import { AsyncAutoResetEvent } from './coordination/AsyncAutoResetEvent';
import { AsyncEventWaitHandle } from './coordination/AsyncEventWaitHandle';
import { AsyncManualResetEvent } from './coordination/AsyncManualResetEvent';
import { Connection } from './Connection';
import { FramedSocketError, IFramedSocket } from './IFramedSocket';
import { Message } from './Message';
import { Queue } from './Queue';

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
  /**
   * Creates a Connection object backed by an underlying WebSocket
   * @param url URL to connect to
   * @param onMessageReceived Callback handler
   * @returns Established Connection object
   */
  public static async connect(url: string, onMessageReceived: (message: Message) => Promise<void>):
      Promise<Connection> {
    // Create a client WebSocket
    let ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    // Create the WSFramedSocket and wait for it to connect
    let wsfs = new WSFramedSocket(ws);
    await wsfs.waitForOpen();

    return new Connection(wsfs, onMessageReceived);
  }
  
  private constructor(ws: WebSocket) {
    this._ws = ws;
    this._isOpen = new AsyncManualResetEvent();
    this._isClosed = new AsyncManualResetEvent();
    this._receiveQueue = new Queue<MessageEvent>();
    this._receiveEvent = new AsyncAutoResetEvent();

    ws.onmessage = e => { this._onServerMessage(e); }
    ws.onopen = () => { this._isOpen.set(); }
    ws.onerror = () => { this._isClosed.set(); }
    ws.onclose = () => { this._isClosed.set(); }
  }

  /**
   * Waits for the WebSocket to enter the open state. Throws an exception if it fails to open.
   */
  private async waitForOpen(): Promise<void> {
    // Wait for either open or closed, whichever happens first
    await AsyncEventWaitHandle.whenAny([this._isOpen, this._isClosed]);

    // The WebSocket must be open before calling this constructor
    if (this._ws.readyState !== WS_OPEN) {
      throw 'Failed to established WebSocket. State=' + this._ws.readyState;
    }
  }

  private _onServerMessage(e: MessageEvent): void {
    this._receiveQueue.enqueue(e);
    this._receiveEvent.set();
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
      let e = this._receiveQueue.dequeue();
      if (e) {
        let data = new Uint8Array(e.data);

        // If the client has exceeded the maximum messsage size set below, terminate its connection
        let bytesReceived = data.length;
        if (bytesReceived > buffer.byteLength) {
          return FramedSocketError.FrameTooLarge;
        }

        // Copy the data into the destination buffer
        let arr = new Uint8Array(buffer.buffer);
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
