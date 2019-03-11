import { ControlFrame, DataFrameControl, MessageCancelControl } from './ControlFrame';
import { AsyncAutoResetEvent, AsyncEventWaitHandle, AsyncManualResetEvent, AsyncTimerEvent, MovingAverage, Queue } from
  '@leosingleton/commonlibs';
import { IFramedSocket } from './IFramedSocket';
import { Message } from './Message';
import { SendQueue } from './SendQueue';
import { TransportConfig } from './TransportConfig';
import { OutgoingMessage } from './OutgoingMessage';
import { TransportCapabilities, TransportCapabilities1 } from './TransportCapabilities';
import { MessageCallbackHandler, MessageCallbackEvents, MessageCallback } from './MessageCallbackHandler';
import { DispatchQueue } from './DispatchQueue';
import { Stopwatch } from '@leosingleton/commonlibs';

export class Connection {
  /**
   * Constructor
   * @param socket Wrapper class around a WebSocket or similar mock connection
   * @param config Optional transport configuration settings. With the default value of null, all default values are
   *    used.
   * @param connectionName Opaque string to identify this connection for logging purposes
   * @param sendCapabilities If true, the transport library will send a capabilities message as the very first message.
   *    This will break the other end if it does not support capabilities (prior to September 2018). If false, we will
   *    assume the other end is legacy, and only send capabilities _after_ a capabilities message from the other end.
   *    The purpose of this is to introduce capabilities without breaking backwards-compatibility. The server
   *    should set this to false (at least for a few months), while clients (viewers and mobile apps) should leave
   *    it set to true.
   */
  public constructor(socket: IFramedSocket, config?: TransportConfig, connectionName = 'Connection',
      sendCapabilities = true) {
    // Start out with all capabilities disabled and version 0.0. This will be set once we receive a
    // capabilities message from the remote side.
    this._negotiatedCapabilities = TransportCapabilities.getZeroCapabilities();
    this._sendCapabilities = sendCapabilities;

    this._socket = socket;
    this._callbacks = new MessageCallbackHandler();
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
    this._receivedMessagesCount = 0;

    this._dispatchQueue = new DispatchQueue();
    this._dispatchEvent = new AsyncAutoResetEvent();

    this._sendQueue = new SendQueue(this._config.priorityLevels);
    this._outgoingMessagesToCancel = new Queue<OutgoingMessage>();
    this._dataToSendEvent = new AsyncAutoResetEvent();

    this._sendMessageNumbers = new Queue<number>();
    for (let n = 0; n < this._config.maxConcurrentMessages; n++) {
      this._sendMessageNumbers.enqueue(n);
    }
    this._messageNumberEvent = new AsyncAutoResetEvent();

    // Start the worker threads. We start all except for the dispatch loop here, which must be explicitly
    // started by calling BeginDispatch(). We wait in order to avoid race conditions where we dispatch messages
    // before all of the callbacks are registered.
    this._loopExceptionWrapper(this._receiveLoop());
    this._loopExceptionWrapper(this._sendLoop());
  }

  /**
   * Registers a callback to be executed on message events. These callbacks are invoked for all messages. For
   * more granular callbacks, register on the Message object itself.
   * @param callback Callback function
   * @param events Events that trigger the callback
   */
  public registerCallback(callback: MessageCallback, events = MessageCallbackEvents.Complete): void {
    this._callbacks.registerCallback(callback, events);
  }

  /**
   * Begins the dispatch loop. This must be called once all callbacks are registered using
   * registerCallback().
   */
  public beginDispatch(): void {
    this._loopExceptionWrapper(this._dispatchLoop());
  }

  /**
   * Closes the connection
   * @param reason String describing the reason for closing
   * @param waitForRemote If true, we block while the socket is closed gracefully
   */
  public forceClose(reason: string, waitForRemote = false): void {
    // Ignore multiple calls to this function
    if (!this._closeReason) {
      this._closeReason = reason;

      this._socket.closeAsync(reason, waitForRemote);

      // Cancel all messages in the process of being received
      for (let n = 0; n < this._receivedMessages.length; n++) {
        let message = this._receivedMessages[n];
        if (message) {
          this.cancelReceivedMessage(n);
        }
      }

      this._isClosing.set();
    }
  }

  /**
   * Waits for the connection to close
   * @returns String describing the reason for closing
   */
  public async waitClose(): Promise<string> {
    // We used to actually wait on the RecieveLoop, SendLoop, and DispatchLoop tasks here, however .NET's
    // WebSocket client seems to be unpredictable when it comes to timing. Instead we solely rely on our own
    // event and let the tasks clean up whenever they finish. TypeScript will do the same for consistency.
    await this._isClosing.waitAsync();
    return this._closeReason;
  }

  /**
   * Wrapper around an async worker loop to catch any unhandled exceptions, log them, and terminate the connection
   * @param promise Promise returned by an async loop 
   */
  private _loopExceptionWrapper(promise: Promise<void>): void {
    promise.catch((err: Error) => {
      console.log(err);
      this.forceClose(err.name);
    });
  }

  private async _receiveLoop(): Promise<void> {
    // When we receive a control frame, it contains information about the upcoming data frames, which is stored
    // in this FIFO queue.
    let expectedDataFrames = new Queue<DataFrameControl>();

    // Timer used to estimate inbound throughput
    let receiveTimer: Stopwatch;

    // Byte counter used to estimate inbound throughput
    let bytesReceived = 0;

    while (true) {
      // Determine the next expected frame and where the data should be stored
      let expectedDataFrame: DataFrameControl;
      let segment: DataView;
      if (expectedDataFrames.getCount() > 0) {
        expectedDataFrame = expectedDataFrames.dequeue();

        // We are expecting a data frame
        let buffer = this._receivedMessages[expectedDataFrame.messageNumber].getPayload();
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
      this._bytesIn += bytes;

      // Resize segment to match the number of bytes returned
      if (bytes !== segment.byteLength) {
        segment = new DataView(segment.buffer, segment.byteOffset, bytes);
      }

      if (expectedDataFrame) {
        //
        // Process a data frame
        //

        // Estimate inbound throughput
        bytesReceived += bytes;
        if (expectedDataFrames.getCount() === 0) {
          // This was the last data frame in the group of frames. Calculate the estimate.
          receiveTimer.stop();
          let elapsedMilliseconds = receiveTimer.getElapsedMilliseconds();
          if (bytesReceived > this._config.singlePacketMtu && elapsedMilliseconds > 0) {
            let estimate = bytesReceived * 1000 / elapsedMilliseconds;
            this._inboundThroughputEstimate.record(estimate);
          }
        }

        // We received part of a message. Send it to the dispatch loop. We don't want to process it on this
        // thread, as doing so could reduce our receive throughput.
        let message = this._receivedMessages[expectedDataFrame.messageNumber];
        message._bytesReceived += bytes;

        this._dispatchQueue.enqueue(message);
        this._dispatchEvent.set();

        if (expectedDataFrame.isLast) {
          // Remove the message from the _ReceivedMessages array once it is completely received. This way
          // the garbage collector can free the memory after it is dispatched, without waiting for the
          // message number to get reused by another message.
          this._receivedMessages[expectedDataFrame.messageNumber] = undefined;
          this._receivedMessagesCount--;
        }
      } else {
        //
        // Process a control frame
        //

        let controlFrame = new ControlFrame();
        controlFrame.read(segment);

        if (controlFrame.opCode === 0x00) {
          // Received a capabilities message. Compute the intersection of the two libraries.
          this._negotiatedCapabilities = TransportCapabilities.negotiate(TransportCapabilities.getLocalCapabilties(),
            controlFrame.data as TransportCapabilities);

          // If we did not send a capabilities message yet, and the other end handles it, send one
          if ((this._negotiatedCapabilities.capabilities1 & TransportCapabilities1.Capabilities) !== 0 &&
              !this._capabilitiesSent) {
            this._sendCapabilities = true;
            this._dataToSendEvent.set();
          }          
        } else if (controlFrame.opCode >= 0x01 && controlFrame.opCode <= 0x0f) {
          // Prepare for subsequent data frames

          // Start the timer to measure how long it takes to receive the data. We know the remote side sends all of the
          // data frames immediately following the control frame, so this provides an accurate estimate of inbound
          // throughput.
          receiveTimer = new Stopwatch();
          receiveTimer.start();
          bytesReceived = 0;

          let dataFrames = controlFrame.data as DataFrameControl[];
          for (let n = 0; n < controlFrame.opCode; n++) {
            let dataFrame = dataFrames[n];

            if (dataFrame.isFirst) {
              let msg = new Message(dataFrame.length, false);
              msg._setHeader(dataFrame.header);
              this._receivedMessages[dataFrame.messageNumber] = msg;
              this._receivedMessagesCount++;
            }

            expectedDataFrames.enqueue(dataFrame);
          }
        } else if (controlFrame.opCode === 0x10) {
          // Received a Ping. Send a Pong.
          this._sendPong = true;
          this._pongEvent.set();
        } else if (controlFrame.opCode === 0x11) {
          // Received a Pong. Use this to update our RTT estimate.
          let timer = this._pingResponseTimer; this._pingResponseTimer = null;
          if (timer) {
            timer.stop();
            this._localRttEstimate.record(timer.getElapsedMilliseconds());
          }

          this._missedPingCount = 0;
        } else if (controlFrame.opCode === 0x12) {
          // Cancel messages in progress
          let cancellationDetails = controlFrame.data as MessageCancelControl;
          this.cancelReceivedMessages(cancellationDetails.messageNumbers);
        }

        // All control frames include the RTT and throughput estimates from the remote side
        this._remoteRttEstimate = controlFrame.rttEstimate;
        this._outboundThroughputEstimate = controlFrame.throughputEstimate;
      }
    }
  }

  /**
   * Internal helper function to cancel a message that has been partially received
   * @param messageNumber Message number
   */
  private cancelReceivedMessage(messageNumber: number): void {
    // Ensure the message number is a valid message
    if (!this._receivedMessages[messageNumber]) {
      throw new Error('Invalid message number ' + messageNumber);
    }

    // Set a flag on the message to indicate cancellation
    this._receivedMessages[messageNumber]._isCancelled = true;

    // Send the cancel events
    this._dispatchQueue.enqueue(this._receivedMessages[messageNumber]);
    this._dispatchEvent.set();

    // Help the GC reclaim any memory consumed by the partially-received message
    this._receivedMessages[messageNumber] = undefined;
    this._receivedMessagesCount--;
  }

  /**
   * Internal helper function to cancel multiple messages that have been partially received
   * @param messageNumberBitmask Bitmask of message numbers. Each set bit corresponds to a message to cancel.
   */
  private cancelReceivedMessages(messageNumberBitmask: number): void {
    for (let n = 0; n < this._receivedMessages.length; n++) {
      if ((messageNumberBitmask & (1 << n)) !== 0) {
        this.cancelReceivedMessage(n);
      }
    }
  }

  private async _dispatchLoop(): Promise<void> {
    // Unlike the other threads, we don't immediately stop this one on close. We first must ensure that all of
    // the message cancel events have been sent out to avoid getting into a weird state. Waiting for
    // _ReceivedMessageCount to hit zero covers this case.
    while (!this._isClosing.getIsSet() || this._receivedMessagesCount > 0) {
      let message = this._dispatchQueue.dequeue();
      if (message) {
        // First, execute the message-level callbacks
        message._executeCallbacks();

        // Then, execute the connection-level callbacks
        message._executeCallbacks(this._callbacks);
      }

      if (this._dispatchQueue.getCount() === 0) {
        // Block until another complete message is received
        await AsyncEventWaitHandle.whenAny([this._dispatchEvent, this._isClosing]);
      }
    }
  }

  /**
   * Sends a message
   * @param message Message to send
   * @param priority Priority (0 = highest)
   * @param header Optional header (max 64 bytes). This value is used instead of the header value in the message
   *    parameter on outgoing messages, which enables forwarding the payload while rewriting the header. The default
   *    value is no header. To forward the header as-is, set this value to message.Header.
   * @returns Returns an OutgoingMessage object. This object is read-only, but can be used to track the
   *    progress of the send operation. It can also be passed to cancel(OutgoingMessage) to abort the
   *    send before completion.
   * 
   * This call blocks until the message is successfully queued, however it returns before the message is
   * actually sent. TransportConfig.MaxConcurrentMessages controls how many messages can be queued
   * at a time. If this number is hit, this method will block.
   */
  public async send(message: Message, priority: number, header?: Uint8Array): Promise<OutgoingMessage> {
    if (priority >= this._config.priorityLevels) {
      throw new Error('Priority ' + priority + 'exceeds max');
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

    let messageOut = new OutgoingMessage(messageNumber, message, priority, header);

    if (!message.isComplete()) {
      // If we are forwarding a message before it is fully-received, register a callback with it to ensure we
      // signal the _DataToSendEvent whenever additional payload data is available
      message.registerCallback((msg: Message, events: MessageCallbackEvents) => {
        this._dataToSendEvent.set();
      }, MessageCallbackEvents.PayloadReceived);

      // Likewise, if the receiving message gets cancelled, cancel the outgoing copy too
      message.registerCallback((msg: Message, events: MessageCallbackEvents) => {
        this.cancel(messageOut);
      }, MessageCallbackEvents.Cancelled);
    }

    // Enqueue the message
    this._sendQueue.enqueue(messageOut);
    this._dataToSendEvent.set();
    return messageOut;
  }

  /**
   * Cancels a message before completion.
   * 
   * Note that this operation is fully asynchronous, so it is possible the message completes sending and is
   * never cancelled.
   * 
   * @param message Message to cancel
   */
  public cancel(message: OutgoingMessage): void {
    this._outgoingMessagesToCancel.enqueue(message);
    this._dataToSendEvent.set();
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
        bytesRemaining = this._outboundThroughputEstimate * this._config.maxPercentThroughput *
          this._config.targetResponsiveness / 100000;
        bytesRemaining = Math.floor((bytesRemaining / this._config.singlePacketMtu) + 1) *
          this._config.singlePacketMtu;
        resetBytesRemainingEvent = new AsyncTimerEvent(this._config.targetResponsiveness);
      }

      if (this._sendPong) {
        // Send the pong control frame
        this.sendControlFrame(0x11);
        this._sendPong = false;
      }

      if (this._sendCapabilities) {
        // Send a capability negotation message
        await this.sendCapabilities();
        this._sendCapabilities = false;
      }

      if (!this._outgoingMessagesToCancel.isEmpty()) {
        // Process message cancellations. To avoid race conditions, we always do these on the send thread
        await this.cancelOutgoingMessages();
      }

      if (pingEvent.getIsSet()) {
        // Only send a ping if there is not one currently outstanding
        if (!this._pingResponseTimer) {
          // Send the Ping frame
          this.sendControlFrame(0x10);

          // Measure the amount of time until we receive a Pong
          let timer = new Stopwatch();
          timer.start();
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
        let randomizedInterval = interval + (interval / 2) - (Math.random() * interval);

        // Reset the ping timer
        pingEvent = new AsyncTimerEvent(randomizedInterval);
      }

      // Get the outgoing messages to send
      while (bytesRemaining > 0 && dataFrames.getCount() < 15) {
        let next = this._sendQueue.getNext(bytesRemaining);
        let message = next.message;
        let frameLength = next.bytesToSend;
        if (!message) {
          // There are no more messages with data ready to send
          break;
        }

        let dataFrame = new DataFrameControl();
        dataFrame.offset = message.getBytesSent();
        dataFrame.length = message.message.getPayload().length;
        dataFrame.messageNumber = message.messageNumber;
        dataFrame.isFirst = message.getBytesSent() === 0;
        dataFrame.isLast = message.getBytesRemaining() === frameLength;
        dataFrame.payload = message.message.getPayload();
        dataFrame.frameLength = frameLength;
        dataFrame.header = message.header;
        dataFrames.enqueue(dataFrame);

        message._bytesSent += frameLength;
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
          this._bytesOut += dataFrame.frameLength;
        }
      }
      
      if (bytesRemaining > 0) {
        // Block until there are new messages, pings, or pongs to send
        await AsyncEventWaitHandle.whenAny([this._dataToSendEvent, pingEvent, this._pongEvent, this._isClosing]);
      } else {
        // We are throttling output. Block until our bytesRemaining counter resets, or until there are
        // pongs to send. No need to wait for pingTask, is it is much longer than the bytesRemaining reset interval.
        await AsyncEventWaitHandle.whenAny([resetBytesRemainingEvent, this._pongEvent, this._isClosing]);
      }
    }
  }

  /**
   * Internal helper function to process the _outgoingMessagesToCancel collection. This function
   * must be executed on the send thread to avoid race conditions.
   */
  private async cancelOutgoingMessages(): Promise<void> {
    let msgNumbers = 0;
    let message: OutgoingMessage;

    while (message = this._outgoingMessagesToCancel.dequeue()) {
      if (await this.cancelOutgoingMessage(message)) {
        msgNumbers |= (1 << message.messageNumber);
      }
    }

    // Send a message to cancel message numbers
    if (msgNumbers !== 0) {
      let cancel = new MessageCancelControl();
      cancel.messageNumbers = msgNumbers;
      await this.sendControlFrame(0x12, cancel);
    }
  }

  /**
   * Internel helper function to do the work of Cancel(OutgoingMessage)
   * @param message Message to cancel
   * @returns True if the message was successfully cancelled; false if it was unable to be cancelled
   */
  private async cancelOutgoingMessage(message: OutgoingMessage): Promise<boolean> {
    if (message.getBytesRemaining() === 0) {
      // The message already completed. Too late to cancel.
      return false;
    }

    if ((this._negotiatedCapabilities.capabilities1 & TransportCapabilities1.CancelMessage) === 0) {
      // The other transport library is legacy and doesn't understand the cancel event. Rather than send a
      // message that immediately causes the socket to terminate, we'll just ignore the message cancellation
      // instead. However, if we run out of message numbers, go ahead and kill the socket, as we've basically
      // deadlocked and are just wasting service resources at this point.
      if (this._sendMessageNumbers.isEmpty()) {
        await this.forceClose('Out of message numbers and unable to cancel');
      }

      return false;
    }

    // Remove the message from the send queue
    this._sendQueue.cancel(message);

    // Return the message number to be reused
    this._sendMessageNumbers.enqueue(message.messageNumber);
    this._messageNumberEvent.set();

    return true;
  }

  /**
   * Creates and sends a control frame
   * @param opCode Operation code of the control frame
   * @param data Additional data depending on opCode
   */
  private async sendControlFrame(opCode: number, data?: TransportCapabilities | DataFrameControl[] |
      MessageCancelControl): Promise<void> {
    // Build a control frame
    let controlFrame = new ControlFrame();
    controlFrame.opCode = opCode;
    controlFrame.rttEstimate = this._localRttEstimate.getValue();
    controlFrame.throughputEstimate = this._inboundThroughputEstimate.getValue();
    controlFrame.data = data;
    let controlFrameBytes = controlFrame.write();

    // Send the control frame
    await this._socket.sendFrameAsync(controlFrameBytes);
    this._bytesOut += controlFrameBytes.byteLength;
  }

  /** Sends a capability negotiation message to the other side */
  private async sendCapabilities(): Promise<void> {
    await this.sendControlFrame(0x00, TransportCapabilities.getLocalCapabilties());
    this._capabilitiesSent = true;
  }

  /** Set after sendCapabilities() is called */
  private _capabilitiesSent = false;

  /** Transport library version and capabilities negotiated with the remote side */
  public getNegotiatedCapabilities(): TransportCapabilities {
    return this._negotiatedCapabilities;
  }
  private _negotiatedCapabilities: TransportCapabilities;

  /** If set, the send loop should send a capabilities message */
  private _sendCapabilities = false;

  /** Number of bytes received over the WebSocket as input */
  public getBytesIn(): number {
    return this._bytesIn;
  }
  private _bytesIn = 0;

  /** Number of bytes sent over the WebSocket as output */
  public getBytesOut(): number {
    return this._bytesOut;
  }
  private _bytesOut = 0;

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
  private _pingResponseTimer: Stopwatch;

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

  /**
   * The WebSocket itself for the underlying connection
   */
  private _socket: IFramedSocket;

  /**
   * Callbacks registered with the connection itself. These callbacks receive events on any message received by
   * the connection.
   */
  private _callbacks: MessageCallbackHandler;

  /**
   * Configuration settings for the transport library
   */
  private _config: TransportConfig;

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

  /**
   * Array of messages partially received. The index is the message number, limited by
   * TransportConfig.MaxConcurrentMessages, however we always assume 16 because the transport
   * layer on the other side might have a different configuration value than we do.
   */
  private _receivedMessages: Message[];
  
  /**
   * Number of non-null values in the _receivedMessages array
   */
  private _receivedMessagesCount = 0;

  /**
   * Messages are dispatched from a separate dispatch loop to avoid holding up the receive loop. This queue
   * contains the messages with events for it to dispatch. Signal _dispatchEvent to wake up the
   * loop after adding a message here.
   */
  private _dispatchQueue: DispatchQueue;

  /**
   * Event set when a new item is added to _dispatchQueue
   */
  private _dispatchEvent: AsyncAutoResetEvent;

  /**
   * Prioritized queue of outgoing messages
   */
  private _sendQueue: SendQueue;

  /**
   * This is a collection of outgoing messages that should be cancelled. Cancellation occurs when the sender
   * decides to stop sending a message, which most commonly occurs when forwarding a message, and the incoming
   * connection dies before the message is fully received.
   * 
   * To wake the send loop, signal _dataToSendEvent after adding messages to the queue.
   */
  private _outgoingMessagesToCancel: Queue<OutgoingMessage>;

  /**
   * Set whenever we have data available for the send loop
   */
  private _dataToSendEvent: AsyncAutoResetEvent;

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
