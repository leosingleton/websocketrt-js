import { BandwidthEstimator } from './BandwidthEstimator';
import { ControlFrame, DataFrameControl } from './ControlFrame';
import { AsyncAutoResetEvent } from './Coordination/AsyncAutoResetEvent';
import { AsyncManualResetEvent } from './Coordination/AsyncManualResetEvent';
import { AsyncTimerEvent } from './Coordination/AsyncTimerEvent';
import { IFramedSocket } from './IFramedSocket';
import { Message } from './Message';
import { Queue } from './Queue';
import { SendQueue, OutgoingMessage } from './SendQueue';
import { TransportConfig } from './TransportConfig';
import { AsyncEventWaitHandle } from './Coordination/AsyncEventWaitHandle';

export class Connection {
  public constructor(socket: IFramedSocket, onMessageReceived: (message: Message) => Promise<void>,
      config?: TransportConfig, connectionName = 'Connection') {
    this._socket = socket;
    this._onMessageReceived = onMessageReceived;
    this._config = config ? config : new TransportConfig(); // Use defaults if null
    this._connectionName = connectionName;

    this._bandwidthEstimator = new BandwidthEstimator(this._config);

    this._isClosing = new AsyncManualResetEvent();

    // 16 is the max value for _Config.MaxConcurrentMessages. The transport layer on the other side might have
    // a different configuration than us, so we always assume the max supported value when receiving.
    this._receivedMessages = new Array<Message>(16);
    this._dispatchQueue = new Queue<Message>();
    this._dispatchEvent = new AsyncAutoResetEvent();

    this._sendQueue = new SendQueue(this._config.priorityLevels);

    this._ackCount = 0;
    this._acksReadyEvent = new AsyncAutoResetEvent();

    this._sendMessageNumbers = new Queue<number>();
    for (let n = 0; n < this._config.maxConcurrentMessages; n++) {
      this._sendMessageNumbers.enqueue(n);
    }
    this._messageNumberEvent = new AsyncAutoResetEvent();

    // Start the worker threads
    this._tasks = [];
    setTimeout(() => this._tasks[0] = this._receiveLoop(), 0);
    setTimeout(() => this._tasks[1] = this._dispatchLoop(), 0);
    setTimeout(() => this._tasks[2] = this._sendLoop(), 0);
  }

  /**
   * Closes the connection
   * @param reason String describing the reason for closing
   */
  public forceClose(reason: string): void {
    // Ignore multiple calls to this function
    if (!this._closeReason) {
      this._closeReason = reason;
      this._isClosing.set();

      this._socket.closeAsync(reason, true);
    }
  }

  /**
   * Waits for the connection to close
   * @returns String describing the reason for closing
   */
  public async waitClose(): Promise<string> {
    this._tasks.forEach(async task => { await task });
    return this._closeReason;
  }

  private async _receiveLoop(): Promise<void> {
    // When we receive a control frame, it contains information about the upcoming data frames, which is stored
    // in this FIFO queue.
    let expectedDataFrames = new Queue<DataFrameControl>();

    while (true) {
      // Determine the next expected frame and where the data should be stored
      let expectedDataFrame: DataFrameControl;
      let segment: DataView;
      if (expectedDataFrame = expectedDataFrames.dequeue()) {
        // We are expecting a data frame
        let buffer = this._receivedMessages[expectedDataFrame.messageNumber].payload;
        let offset = expectedDataFrame.offset;
        segment = new DataView(buffer.buffer, offset, buffer.byteLength - offset);
      } else {
        // We are expecting a control frame
        segment = new DataView(new ArrayBuffer(ControlFrame.maxLength));
      }

      // Receive a frame from the WebSocket
      let bytes = await this._socket.receiveFrameAsync(segment);
      if (bytes === -1) {
        this.forceClose('WebSocket closed by remote side');
        return;
      } else if (bytes <= 0) {
        this.forceClose('ReceiveFrameAsync returned error ' + bytes);
        return;
      }

      if (expectedDataFrame) {
        //
        // Process a data frame
        //

        // Always acknowledge data frames
        this._sendAck();

        if (expectedDataFrame.isLast) {
          // We received an entire message. Send it to the dispatch loop. We don't want to process it on this
          // thread, as doing so could reduce our receive throughput.
          this._dispatchQueue.enqueue(this._receivedMessages[expectedDataFrame.messageNumber]);
          this._dispatchEvent.set();

          // Remove the message from the _ReceivedMessages array once it is queued for dispatch. This way the
          // garbage collector can free the memory after it is dispatched, without waiting for the message number
          // to get reused by another message.
          this._receivedMessages[expectedDataFrame.messageNumber] = undefined;
        }
      } else {
        //
        // Process a control frame
        //

        let controlFrame = new ControlFrame();
        controlFrame.read(segment);

        // Acknowledge all control frames, except for ACKs
        if (controlFrame.opCode !== 0) {
          this._sendAck();
        }

        // If the control frame contained ACKs, give them to the bandwidth estimator
        if (controlFrame.ackCount > 0) {
          this._bandwidthEstimator.recordAcks(controlFrame.ackCount);
        }

        // Update the estimates of the inbound connection
        this._bandwidthEstimator.recordInboundRtt(controlFrame.rttEstimate);
        this._inboundThroughputEstimate = controlFrame.throughputEstimate;

        // Prepare for subsequent data frames
        if (controlFrame.opCode >= 1 && controlFrame.opCode <= 15) {
          for (let n = 0; n < controlFrame.opCode; n++) {
            let dataFrame = controlFrame.dataFrames[n];

            if (dataFrame.isFirst) {
              let msg = new Message(dataFrame.length);
              msg.header = dataFrame.header;
              this._receivedMessages[dataFrame.messageNumber] = msg;
            }

            expectedDataFrames.enqueue(dataFrame);
          }
        }
      }
    }
  }

  private async _dispatchLoop(): Promise<void> {
    while (!this._isClosing.getIsSet()) {
      let message: Message;
      if (message = this._dispatchQueue.dequeue()) {
        // Call the handler to process the message
        await this._onMessageReceived(message);
      }

      if (this._dispatchQueue.getCount() === 0) {
        // Block until another complete message is received
        await AsyncEventWaitHandle.whenAny([this._dispatchEvent, this._isClosing]);
      }
    }
  }

  public async send(message: Message, priority: number): Promise<void> {
    if (priority >= this._config.priorityLevels) {
      throw 'Exceeded max priority';
    }

    if (this._isClosing.getIsSet()) {
      // Stop sending data if the socket is closed
      return;
    }

    // Get a message number. We may have to block waiting for one to become available if we have exceeded the
    // transport config's MaxConcurrentMessages.
    let messageNumber: number;
    while ((messageNumber = this._sendMessageNumbers.dequeue()) == null) {
      await AsyncEventWaitHandle.whenAny([this._messageNumberEvent, this._isClosing]);
      if (this._isClosing.getIsSet()) {
        return;
      }
    }

    // Enqueue the message
    let messageOut = new OutgoingMessage(messageNumber, message);
    this._sendQueue.enqueue(messageOut, priority);
  }

  private _sendAck(): void {
    this._ackCount++;
    this._acksReadyEvent.set();
  }

  private async _sendLoop(): Promise<void> {
    // dataFrames contains the control data for the outgoing frames we will send
    let dataFrames = new Queue<DataFrameControl>();

    // resetBytesRemainingEvent is used as the timer to throttle outgoing traffic
    let resetBytesRemainingEvent: AsyncEventWaitHandle = new AsyncManualResetEvent(true);

    // pingEvent is used as the timer to ensure we keep the outgoing connection active
    let pingEvent: AsyncEventWaitHandle = new AsyncManualResetEvent(true);

    let bytesRemaining = 0;

    while (!this._isClosing.getIsSet()) {
      if (resetBytesRemainingEvent.getIsSet()) {
        // Calculate how many bytes we can send this iteration. Round up to the nearest multiple of an MTU.
        bytesRemaining = this._bandwidthEstimator.getThroughputEstimate() * this._config.maxPercentThroughput
          this._config.targetResponsiveness / 10000;
        bytesRemaining = Math.floor((bytesRemaining / this._config.singlePacketMtu) + 1) *
          this._config.singlePacketMtu;
        resetBytesRemainingEvent = new AsyncTimerEvent(this._config.targetResponsiveness);
      }

      // Get the outgoing messages to send
      while (bytesRemaining > 0 && dataFrames.getCount() < 15) {
        let next = this._sendQueue.getNext(bytesRemaining);
        let message = next.message;
        let sendRemaining = next.sendRemaining;
        if (!message) {
          // There are no more messages to send
          break;
        }

        // If sendRemaining is true, we must send all remaining data for the message in a single frame. If
        // it is false, the message is too large, so we should only send bytesRemaining.
        let frameLength = sendRemaining ? message.getBytesRemaining() : bytesRemaining;
        
        let dataFrame = new DataFrameControl();
        dataFrame.offset = message.bytesSent;
        dataFrame.length = message.message.payload.length;
        dataFrame.messageNumber = message.messageNumber;
        dataFrame.isFirst = message.bytesSent === 0;
        dataFrame.isLast = sendRemaining;
        dataFrame.payload = message.message.payload;
        dataFrame.frameLength = frameLength;
        dataFrame.header = message.message.header;
        dataFrames.enqueue(dataFrame);

        message.bytesSent += frameLength;
        bytesRemaining -= frameLength;
      }

      // Get the number of ACKs to send
      let ackCount = this._ackCount; this._ackCount = 0;

      // A single control frame can only send 255 ACKs. If somehow we exceed this, send multiple control
      // frames.
      while (ackCount > 255) {
        // Build an ACK control frame
        let controlFrame = new ControlFrame();
        controlFrame.opCode = 0; // ACK
        controlFrame.ackCount = 255;
        controlFrame.rttEstimate = this._bandwidthEstimator.getRttEstimate();
        controlFrame.throughputEstimate = this._bandwidthEstimator.getThroughputEstimate();
        let controlFrameBytes = controlFrame.write();

        // Send the ACK frame
        this._socket.sendFrameAsync(controlFrameBytes);
        ackCount -= 255;
      }

      // If we have either ACKs or data to send, send it
      if (ackCount > 0 || dataFrames.getCount() > 0) {
        // Build a control frame
        let controlFrame = new ControlFrame();
        controlFrame.opCode = dataFrames.getCount();
        controlFrame.ackCount = ackCount;
        controlFrame.rttEstimate = this._bandwidthEstimator.getRttEstimate();
        controlFrame.throughputEstimate = this._bandwidthEstimator.getThroughputEstimate();
        controlFrame.dataFrames = dataFrames.toArray();
        let controlFrameBytes = controlFrame.write();

        if (dataFrames.getCount() > 0) {
          // Inform the bandwidth estimator to expect an ACK
          this._bandwidthEstimator.expectAck(controlFrameBytes.byteLength);
        }

        // Send the control frame
        this._socket.sendFrameAsync(controlFrameBytes);

        // Send the data frames
        while (dataFrames.getCount() > 0) {
          let dataFrame = dataFrames.dequeue();

          // Inform the bandwidth estimator to expect an ACK
          this._bandwidthEstimator.expectAck(dataFrame.frameLength);

          // If this is the last frame of a message, we can return the message number to the queue for
          // reuse by another message
          if (dataFrame.isLast) {
            this._sendMessageNumbers.enqueue(dataFrame.messageNumber);
            this._messageNumberEvent.set();
          }

          // Send the actual data
          this._socket.sendFrameAsync(new DataView(dataFrame.payload.buffer, dataFrame.offset, dataFrame.frameLength));
        }

        // Reset the ping timer
        pingEvent = new AsyncTimerEvent(this._config.minimumFrameInterval);
      } else if (pingEvent.getIsSet()) {
        // There was no outgoing frames to send, and the MinimumFrameInterval has elapsed. Send a ping.
        let controlFrame = new ControlFrame();
        controlFrame.opCode = 16; // Ping
        controlFrame.ackCount = 0;
        controlFrame.rttEstimate = this._bandwidthEstimator.getRttEstimate();
        controlFrame.throughputEstimate = this._bandwidthEstimator.getThroughputEstimate();
        let controlFrameBytes = controlFrame.write();

        // Inform the bandwidth estimator to expect an ACK
        this._bandwidthEstimator.expectAck(controlFrameBytes.byteLength);

        // Send the Ping frame
        this._socket.sendFrameAsync(controlFrameBytes);

        // Reset the ping timer
        pingEvent = new AsyncTimerEvent(this._config.minimumFrameInterval);
      }

      if (bytesRemaining > 0) {
        // Block until there are new messages, pings, or ACKs to send
        await AsyncEventWaitHandle.whenAny([this._sendQueue.notEmptyEvent, pingEvent, this._acksReadyEvent,
          this._isClosing]);
      } else {
        // We are throttling output. Block until our bytesRemaining counter resets, or until there are
        // ACKs. ACKs are not throttled. No need to wait for pingTask, is it is much longer than the
        // bytesRemaining reset interval.
        await AsyncEventWaitHandle.whenAny([resetBytesRemainingEvent, this._acksReadyEvent, this._isClosing]);
      }
    }
  }

  /**
   * Estimated Round-Trip Time, in milliseconds
   */
  public getRttEstimate(): number {
    return this._bandwidthEstimator.getRttEstimate();
  }

  /**
   * Estimated throughput of the outbound connection, in bytes/sec
   */
  public getOutboundThroughputEstimate(): number {
    return this._bandwidthEstimator.getThroughputEstimate();
  }

  /**
   * Number of bytes sent over the WebSocket without an acknowledgement
   */
  public getOutboundUnacknowledgedBytes(): number {
    return this._bandwidthEstimator.getDataInFlight();
  }

  /**
   * Estimated throughput of the inbound connection, in bytes/sec
   */
  public getInboundThroughputEstimate(): number {
    return this._inboundThroughputEstimate;
  }
  private _inboundThroughputEstimate: number;

  /**
   * Name string for debugging
   */
  private _connectionName: string;

  private _socket: IFramedSocket;
  private _onMessageReceived: (message: Message) => Promise<void>;
  private _config: TransportConfig;
  private _tasks: Promise<void>[];

  /**
   * Estimates throughput and round-trip time (RTT) of the outbound connection
   */
  private _bandwidthEstimator: BandwidthEstimator;

  /**
   * Event used to signal when the connection is closing
   */
  public getIsClosing(): AsyncManualResetEvent {
    return this._isClosing;
  }
  private _isClosing: AsyncManualResetEvent;

  /**
   * String describing the reason for closing the connection
   */
  private _closeReason: string;

  private _receivedMessages: Message[];
  private _dispatchQueue: Queue<Message>;
  private _dispatchEvent: AsyncAutoResetEvent;

  private _sendQueue: SendQueue;

  /**
   * Number of ACKs to send
   */
  private _ackCount: number;

  /**
   * Set whenever we have outgoing ACKs to send
   */
  private _acksReadyEvent: AsyncAutoResetEvent;

  /**
   * We limit the number of concurrent messages over the transport. At most, we allow 16 due to the 4-bit field
   * that holds the message number, however the sender can choose to reduce the limit to improve latency. This
   * queue tracks which message numbers are available for use.
   */
  private _sendMessageNumbers: Queue<number>;

  /**
   * Event set whenever a message number is returned to the queue making it available for reuse
   */
  private _messageNumberEvent: AsyncAutoResetEvent;
}
