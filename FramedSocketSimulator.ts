import { BinaryConverter } from './BinaryConverter';
import { IFramedSocket, FramedSocketError } from './IFramedSocket';
import { Message } from './Message';
import { Queue } from './Queue';
import { AsyncAutoResetEvent, AsyncEventWaitHandle, AsyncManualResetEvent, AsyncTimerEvent } from
  '../common/coordination';

/** Simulates a WebSocket with latency for unit testing */
export class FramedSocketSimulator {
  /**
   * Initializes the simulator
   * @param latency Simulated latency (one direction), in milliseconds
   * @param throughput Simulated throughput (each direction), in bytes/sec
   */
  public constructor(latency: number, throughput: number) {
    this._isClosed = new AsyncManualResetEvent();

    this._socket1 = new SocketSim(this, this._socket1ToSocket2, this._socket2ToSocket1, latency, throughput);
    this._socket2 = new SocketSim(this, this._socket2ToSocket1, this._socket1ToSocket2, latency, throughput);
  }

  public getSocket1(): IFramedSocket {
    return this._socket1;
  }
  private _socket1: IFramedSocket;

  public getSocket2(): IFramedSocket {
    return this._socket2;
  }
  private _socket2: IFramedSocket;

  /** Whether the simulator should drop all incoming and outgoing messages to simulate a lost connection */
  public dropMessages: boolean;

  /** When closed, indicates whether the WebSocket was closed gracefully using waitForRemote */
  private _gracefulClose: boolean;

  private _socket1ToSocket2 = new SimQueue();
  private _socket2ToSocket1 = new SimQueue();

  public getIsClosed(): AsyncManualResetEvent {
    return this._isClosed;
  }
  private _isClosed: AsyncManualResetEvent;

  public close(waitForRemote: boolean): void {
    if (!this._isClosed.getIsSet()) {
      this._isClosed.set();
      this._gracefulClose = waitForRemote;

      // Wake any receivers so they return a closing error code
      this._socket1ToSocket2.event.set();
      this._socket2ToSocket1.event.set();
    }
  }

  /**
   * Fills a message's payload with a specific test pattern that can be validated to ensure the payload was
   * properly split and reassembled.
   * @param message Message to fill with a test pattern
   */
  public static fillMessageWithTestPattern(message: Message): void {
    let length = message.payload.byteLength;

    // Write the payload length to the first four bytes
    BinaryConverter.writeInt32(message.payload, 0, length);

    // Fill the rest of the bytes with the byte count, mod 256
    for (let n = 4; n < length; n++) {
      message.payload[n] = n % 256;
    }
  }

  /**
   * Validates a message's payload matches the test pattern created by FillMessageWithTestPattern()
   * @param message Message to validate
   * @returns True if it matches; false if not
   */
  public static validateMessageTestPattern(message: Message): boolean {
    let length = message.payload.byteLength;

    // The first four bytes contain the payload length
    let validateLength = BinaryConverter.readInt32(message.payload, 0);
    if (length !== validateLength) {
      return false;
    }

    // The rest of the bytes contain the byte count, mod 256
    for (let n = 4; n < length; n++) {
      if (message.payload[n] !== (n % 256)) {
        return false;
      }
    }

    return true;
  }
}

class SocketSim implements IFramedSocket {
  public constructor(sim: FramedSocketSimulator, sendQueue: SimQueue, receiveQueue: SimQueue, latency: number,
      throughput: number) {
    this._sim = sim;
    this._sendQueue = sendQueue;
    this._receiveQueue = receiveQueue;
    this._latency = latency;
    this._throughput = throughput;
  }

  private _sim: FramedSocketSimulator;
  private _sendQueue: SimQueue;
  private _receiveQueue: SimQueue;
  private _latency: number;
  private _throughput: number;

  public async receiveFrameAsync(buffer: DataView): Promise<number> {
    while (true) {
      if (this._sim.getIsClosed().getIsSet()) {
        return FramedSocketError.Closing;
      }

      let frame = this._receiveQueue.queue.dequeue();
      if (frame) {
        // Simulate latency
        let timeRemaining = frame.deliveryTime - Date.now();
        if (timeRemaining > 0) {
          await AsyncTimerEvent.delay(timeRemaining);
        }

        // Simulate throughput
        if (this._throughput > 0) {
          let throughputDelay = frame.payload.byteLength * 1000 / this._throughput;
          if (throughputDelay > 0) {
            await AsyncTimerEvent.delay(throughputDelay);
          }
        }

        if (frame.payload.byteLength > buffer.byteLength) {
          return FramedSocketError.FrameTooLarge;
        }

        new Uint8Array(buffer.buffer).set(frame.payload);
        return frame.payload.byteLength;
      }

      await AsyncEventWaitHandle.whenAny([this._receiveQueue.event, this._sim.getIsClosed()]);
    }
  }

  public async sendFrameAsync(buffer: DataView): Promise<void> {
    if (this._sim.dropMessages || this._sim.getIsClosed().getIsSet()) {
      // Simulate a connection failure or closed socket by dropping all messages
      return;
    }

    let frame = new SimFrame();
    frame.payload = new Uint8Array(buffer.buffer);
    frame.deliveryTime = Date.now() + this._latency;

    this._sendQueue.queue.enqueue(frame);
    this._sendQueue.event.set();
  }

  public async closeAsync(closeReason: string, waitForRemote: boolean): Promise<void> {
    this._sim.close(waitForRemote);
  }
}

class SimQueue {
  public queue = new Queue<SimFrame>();
  public event = new AsyncAutoResetEvent();
}

class SimFrame {
  public payload: Uint8Array;
  public deliveryTime: number;
}
