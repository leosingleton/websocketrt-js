import { FramedSocketSimulator } from './FramedSocketSimulator';
import { Connection } from './Connection';
import { IFramedSocket } from './IFramedSocket';
import { MessageCallbackEvents } from './MessageCallbackHandler';
import { Message } from './Message';
import { OutgoingMessage } from './OutgoingMessage';
import { AsyncAutoResetEvent, AsyncTimerEvent, AsyncEventWaitHandle, Queue, Stopwatch } from
  '@leosingleton/commonlibs';

/**
 * Helper class to build a test case using the FramedSocketSimulator
 */
export class ConnectionTestSimulator extends FramedSocketSimulator {
  public constructor(latency: number, throughput: number) {
    super(latency, throughput);
    this.connection1 = new SimulatedConnection(this.getSocket1(), 'Connection1');
    this.connection2 = new SimulatedConnection(this.getSocket2(), 'Connection2');
  }

  /** One simulated connection endpoint */
  public readonly connection1: SimulatedConnection;

  /** The other simulated connection endpoint */
  public readonly connection2: SimulatedConnection;

  /** Begins the dispatch loop on both sides of the connection */
  public beginDispatch(): void {
    this.connection1.beginDispatch();
    this.connection2.beginDispatch();
  }

  /** Gracefully close the connections. Used to end a test case. */
  public async closeGracefully(): Promise<void> {
    // Trigger the connnection close from c1's side
    await this.connection1.forceClose('Unit test is complete', true);

    // Wait for the connections to close
    await this.connection1.waitClose();
    await this.connection2.waitClose();
  }

  /**
   * Validates all messages received and throws XUnits asserts if they do not match the patterns of messages
   * created by SimulatedConnection.SendTestMessage(int, int)
   */
  public validateTestMessages(): void {
    this.connection1.validateTestMessages();
    this.connection2.validateTestMessages();
  }

  /**
   * Forwards all messages from one connection to another
   * @param srcConnection Source connection
   * @param destConnection Destination connection
   * @param notComplete If true, we ensure the message is not complete before forwarding. The simulated latency and
   *    throughput on the srcConnection must be set to ensure this happens for the given message size without race
   *    conditions.
   */
  public static forwardConnection(srcConnection: SimulatedConnection, destConnection: SimulatedConnection,
      notComplete = true) {
    srcConnection.registerCallback((msg: Message, _events: MessageCallbackEvents) => {
      if (notComplete) {
        expect(msg.isComplete()).toBeFalsy();
      }

      destConnection.send(msg, 0, msg.getHeader());
    }, MessageCallbackEvents.NewMessage);
  }
}

/**
 * Wrapper around the connection object to provide helper methods for unit tests
 */
export class SimulatedConnection extends Connection {
  public constructor(socket: IFramedSocket, connectionName: string) {
    super(socket, null, connectionName);

    this.registerCallback((message: Message, _events: MessageCallbackEvents) => {
      // We can't do asserts here, because it's not the main XUnit thread, so store the message and
      // header. The unit test can validate it later by calling ValidateTestMessages().
      this.messages.enqueue(message);

      this._messagesReceived++;
      this._messageBytesReceived += message._bytesReceived;
      this._messageReceivedEvent.setEvent();
    });

    this.registerCallback((_message: Message, _events: MessageCallbackEvents) => {
      this._newMessages++;
    }, MessageCallbackEvents.NewMessage);

    this.registerCallback((_message: Message, _events: MessageCallbackEvents) => {
      this._cancelledMessages++;
    }, MessageCallbackEvents.Cancelled);
  }

  /**
   * Messages received. The first element in the tuple is the message; the second the optional message header.
   */
  public messages = new Queue<Message>();

  /** The number of messages that have been fully received */
  public getMessagesReceived(): number {
    return this._messagesReceived;
  }
  private _messagesReceived = 0;

  /** The number of bytes belonging to messages that have been fully received */
  public getMessageBytesReceived(): number {
    return this._messageBytesReceived;
  }
  private _messageBytesReceived = 0;

  /** Event signalled whenever a message is fully received */
  private _messageReceivedEvent = new AsyncAutoResetEvent();

  /** Messages we begun to receive (but may later be cancelled before fully received) */
  public getNewMessages(): number {
    return this._newMessages;
  }
  private _newMessages = 0;

  /** Messages partially received then cancelled */
  public getCancelledMessages(): number {
    return this._cancelledMessages;
  }
  private _cancelledMessages = 0;

  /**
   * Sends a message of the requested size and priority. The payload is filled with a test pattern to ensure
   * that disassembly/reassembly of frames works correctly.
   * @param bytes Message size, in bytes
   * @param priority Message priority (0 = highest)
   * @returns OutgoingMessage which can be used to cancel or monitor progress
   */
  public sendTestMessage(bytes: number, priority = 0): Promise<OutgoingMessage> {
    const message = new Message(bytes);
    FramedSocketSimulator.fillBufferWithTestPattern(message.getPayload());
    const header = new Uint8Array(bytes % 61); // 64 byte max
    FramedSocketSimulator.fillBufferWithTestPattern(header);
    return this.send(message, priority, header);
  }

  /**
   * Expect the specified number of messages and bytes to be received
   * @param messageCount Expected number of messages
   * @param bytes Expected number of total bytes
   * @param minMilliseconds Minimum time to arrive, in milliseconds
   * @param maxMilliseconds Maximum time to arrive, in milliseconds
   */
  public async expectTestMessages(messageCount: number, bytes: number, minMilliseconds: number,
      maxMilliseconds: number): Promise<void> {
    const oneSecondTimer = new AsyncTimerEvent(1000, true);
    const start = Stopwatch.startNew();
    let elapsed = 0;

    do {
      // Wait for a message, or wake every 1 second
      await AsyncEventWaitHandle.whenAny([this._messageReceivedEvent, oneSecondTimer]);
      elapsed = start.getElapsedMilliseconds();

      if (this._messagesReceived >= messageCount || this._messageBytesReceived >= bytes) {
        expect(this._messagesReceived).toEqual(messageCount);
        expect(this._messageBytesReceived).toEqual(bytes);
        expect(elapsed).toBeGreaterThanOrEqual(minMilliseconds);
        expect(elapsed).toBeLessThanOrEqual(maxMilliseconds);

        // Success. Reset counters for future calls.
        this._messagesReceived = 0;
        this._messageBytesReceived = 0;
        return;
      }
    } while (elapsed < maxMilliseconds);
  }

  /**
   * Validates all messages received and throws XUnits asserts if they do not match the patterns of messages
   * created by sendTestMessage(int, int)
   */
  public validateTestMessages(): void {
    let message: Message;
    while ((message = this.messages.dequeue())) {
      expect(message).toBeDefined();
      expect(FramedSocketSimulator.validateBufferTestPattern(message.getPayload())).toBeTruthy();
      expect(message.getHeader()).toBeDefined();
      expect(message.getHeader().length).toEqual(message.getPayload().length % 61);
      expect(FramedSocketSimulator.validateBufferTestPattern(message.getHeader())).toBeTruthy();
    }
  }
}
