import { MovingAverage } from './MovingAverage';
import { ControlFrame, DataFrameControl } from './ControlFrame';
import { AsyncAutoResetEvent } from './coordination/AsyncAutoResetEvent';
import { AsyncManualResetEvent } from './coordination/AsyncManualResetEvent';
import { AsyncTimerEvent } from './coordination/AsyncTimerEvent';
import { IFramedSocket } from './IFramedSocket';
import { Message } from './Message';
import { Queue } from './Queue';
import { SendQueue, OutgoingMessage } from './SendQueue';
import { TransportConfig } from './TransportConfig';
import { AsyncEventWaitHandle } from './coordination/AsyncEventWaitHandle';

export class Connection {
  public constructor(socket: IFramedSocket, onMessageReceived: (message: Message) => Promise<void>,
      config?: TransportConfig, connectionName = 'Connection') {
    this._socket = socket;
    this._onMessageReceived = onMessageReceived;
    this._config = config ? config : new TransportConfig(); // Use defaults if null
    this._connectionName = connectionName;

    this._localRttEstimate = new MovingAverage(100, this._config.bandwidthEstimatorSamples);
    this._remoteRttEstimate = 100;

    this._inboundThroughputEstimate = new MovingAverage(128 * 1024, this._config.bandwidthEstimatorSamples);
    this._outboundThroughputEstimate = 128 * 1024;

    this._pongEvent = new AsyncAutoResetEvent();

    this._isClosing = new AsyncManualResetEvent();

    // 16 is the max value for _Config.MaxConcurrentMessages. The transport layer on the other side might have
    // a different configuration than us, so we always assume the max supported value when receiving.
    this._receivedMessages = new Array<Message>(16);
    this._dispatchQueue = new Queue<Message>();
    this._dispatchEvent = new AsyncAutoResetEvent();

    this._sendQueue = new SendQueue(this._config.priorityLevels);

    this._sendMessageNumbers = new Queue<number>();
    for (let n = 0; n < this._config.maxConcurrentMessages; n++) {
      this._sendMessageNumbers.enqueue(n);
    }
    this._messageNumberEvent = new AsyncAutoResetEvent();

    // Start the worker threads
    this._tasks = [];
    this._tasks[0] = this._receiveLoop();
    this._tasks[1] = this._dispatchLoop();
    this._tasks[2] = this._sendLoop();
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
    // A forEach loop doesn't properly await async tasks. Use a traditional for loop to avoid this.
    for (let n = 0; n < this._tasks.length; n++) {
      await this._tasks[n];
    }

    return this._closeReason;
  }

  private async _receiveLoop(): Promise<void> {
    // When we receive a control frame, it contains information about the upcoming data frames, which is stored
    // in this FIFO queue.
    let expectedDataFrames = new Queue<DataFrameControl>();

    // Timer used to estimate inbound throughput
    let receiveTimer: number;

    // Byte counter used to estimate inbound throughput
    let bytesReceived: number;

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

        // Estimate inbound throughput
        bytesReceived += bytes;
        if (expectedDataFrames.getCount() === 0) {
          // This was the last data frame in the group of frames. Calculate the estimate.
          let elapsedMilliseconds = Date.now() - receiveTimer;
          if (bytesReceived > this._config.singlePacketMtu && elapsedMilliseconds > 0) {
            let estimate = bytesReceived * 1000 / elapsedMilliseconds;
            this._inboundThroughputEstimate.record(estimate);
          }
        }

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

        // Prepare for subsequent data frames
        if (controlFrame.opCode >= 1 && controlFrame.opCode <= 15) {
          // Start the timer to measure how long it takes to receive the data. We know the remote side sends all of the
          // data frames immediately following the control frame, so this provides an accurate estimate of inbound
          // throughput.
          receiveTimer = Date.now();
          bytesReceived = 0;

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

        if (controlFrame.opCode === 16) {
          // Received a Ping. Send a Pong.
          this._sendPong = true;
          this._pongEvent.set();
        }

        if (controlFrame.opCode === 17) {
          // Received a Pong. Use this to update our RTT estimate.
          let timer = this._pingResponseTimer; this._pingResponseTimer = null;
          if (timer) {
            this._localRttEstimate.record(Date.now() - timer);
          }

          this._missedPingCount = 0;
        }

        // All control frames include the RTT and throughput estimates from the remote side
        this._remoteRttEstimate = controlFrame.rttEstimate;
        this._outboundThroughputEstimate = controlFrame.throughputEstimate;
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
        bytesRemaining = this._outboundThroughputEstimate * this._config.maxPercentThroughput
          this._config.targetResponsiveness / 100000;
        bytesRemaining = Math.floor((bytesRemaining / this._config.singlePacketMtu) + 1) *
          this._config.singlePacketMtu;
        resetBytesRemainingEvent = new AsyncTimerEvent(this._config.targetResponsiveness);
      }

      if (this._sendPong) {
        // Send the pong control frame
        this.sendControlFrame(17);
        this._sendPong = false;
      }

      if (pingEvent.getIsSet()) {
        // Only send a ping if there is not one currently outstanding
        if (!this._pingResponseTimer) {
          // Send the Ping frame
          this.sendControlFrame(16);

          // Measure the amount of time until we receive a Pong
          let timer = Date.now();
          this._pingResponseTimer = timer;
          this._pingCount++;
        } else {
          this._missedPingCount++;

          if (this._missedPingCount >= this._config.missedPingCount) {
            // The remote side is not responding to pings. Close the connection.
            this.forceClose('Remote side did not respond to a ping');
            return;
          }
        }

        // Calculate the ping interval
        let interval = this._config.pingInterval; // Ping every 10 seconds
        if (this._pingCount < (this._config.pingInterval / this._config.initialPingInterval)) {
          // For the first 10 seconds, ping at 1/second
          interval = this._config.initialPingInterval;
        }

        // Randomize the interval by +/- 50%
        let randomizedInterval = interval + (interval / 2) + (Math.random() * interval);

        // Reset the ping timer
        pingEvent = new AsyncTimerEvent(randomizedInterval);
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

      // If we have data to send, send it
      if (dataFrames.getCount() > 0) {
        // Send the control frame
        this.sendControlFrame(dataFrames.getCount(), dataFrames.toArray());

        // Send the data frames
        while (dataFrames.getCount() > 0) {
          let dataFrame = dataFrames.dequeue();

          // If this is the last frame of a message, we can return the message number to the queue for
          // reuse by another message
          if (dataFrame.isLast) {
            this._sendMessageNumbers.enqueue(dataFrame.messageNumber);
            this._messageNumberEvent.set();
          }

          // Send the actual data
          this._socket.sendFrameAsync(new DataView(dataFrame.payload.buffer, dataFrame.offset, dataFrame.frameLength));
        }
      }
      
      if (bytesRemaining > 0) {
        // Block until there are new messages, pings, or pongs to send
        await AsyncEventWaitHandle.whenAny([this._sendQueue.notEmptyEvent, pingEvent, this._pongEvent,
          this._isClosing]);
      } else {
        // We are throttling output. Block until our bytesRemaining counter resets, or until there are
        // pongs to send. No need to wait for pingTask, is it is much longer than the bytesRemaining reset interval.
        await AsyncEventWaitHandle.whenAny([resetBytesRemainingEvent, this._pongEvent, this._isClosing]);
      }
    }
  }

  /**
   * Creates and sends a control frame
   * @param opCode Operation code of the control frame
   * @param dataFrames Optional (depending on opCode) information about data frames that follow the control frame
   */
  private async sendControlFrame(opCode: number, dataFrames?: DataFrameControl[]): Promise<void> {
    // Build a control frame
    let controlFrame = new ControlFrame();
    controlFrame.opCode = opCode;
    controlFrame.rttEstimate = this._localRttEstimate.getValue();
    controlFrame.throughputEstimate = this._inboundThroughputEstimate.getValue();
    controlFrame.dataFrames = dataFrames;
    let controlFrameBytes = controlFrame.write();

    // Send the control frame
    await this._socket.sendFrameAsync(controlFrameBytes);
  }

  /**
   * Estimated Round-Trip Time, in milliseconds
   */
  public getRttEstimate(): number {
    // RTT should always the same in each direction, but is sometimes inaccurate due to server and network load adding
    // additional latency. For a more accurate measurement, both sides independently calculate the RTT value and share
    // their result. For the actual RTT estimate, we take the lower of the two.
    return Math.min(this._localRttEstimate.getValue(), this._remoteRttEstimate);
  }

  /**
   * Estimate RTT calculated by ourselves
   */
  private _localRttEstimate: MovingAverage;

  /**
   * Estimated RTT calculated by the other side
   */
  private _remoteRttEstimate: number;

  /**
   * Estimated throughput of the outbound connection, in bytes/sec
   */
  public getOutboundThroughputEstimate(): number {
    return this._outboundThroughputEstimate;
  }
  private _outboundThroughputEstimate: number;

  /**
   * Estimated throughput of the inbound connection, in bytes/sec
   */
  public getInboundThroughputEstimate(): number {
    return this._inboundThroughputEstimate.getValue();
  }

  /**
   * Moving average used to calculate the inbound throughput estimate
   */
  private _inboundThroughputEstimate: MovingAverage;

  /**
   * Measures the interval between sending a Ping and receiving a Pong. This is used to calculate RTT.
   */
  private _pingResponseTimer: number;

  /**
   * Number of pings sent
   */
  private _pingCount = 0;

  /**
   * Number of consecutive pings that were not sent, because the previous was still waiting for a pong response.
   * If this hits TransportConfig.missedPingCount, the connection is closed.
   */
  private _missedPingCount = 0;

  /**
   * Name string for debugging
   */
  private _connectionName: string;

  private _socket: IFramedSocket;
  private _onMessageReceived: (message: Message) => Promise<void>;
  private _config: TransportConfig;
  private _tasks: Promise<void>[];

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
   * Set whenever we need to send a Pong in response to a Ping
   */
  private _sendPong: boolean;

  /**
   * Set whenever we need to send a Pong in response to a Ping
   */
  private _pongEvent: AsyncAutoResetEvent;

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
