// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using LeoSingleton.CommonLibs.Coordination;

// Allow unit tests of internal classes
[assembly: InternalsVisibleTo("LeoSingleton.WebSocketRT.Simulator")]
[assembly: InternalsVisibleTo("LeoSingleton.WebSocketRT.UnitTests")]

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Handles a single WebSocket connection
    /// </summary>
    public class Connection
    {
        /// <summary>
        /// Constructor
        /// </summary>
        /// <param name="socket">Wrapper class around a WebSocket or similar mock connection</param>
        /// <param name="config">
        /// Optional transport configuration settings. With the default value of null, all default values are used.
        /// </param>
        /// <param name="connectionName">Opaque string to identify this connection for logging purposes</param>
        /// <param name="sendCapabilities">
        /// <para>
        /// If true, the transport library will send a capabilities message as the very first message. This will break
        /// the other end if it does not support capabilities (prior to September 2018). If false, we will assume the
        /// other end is legacy, and only send capabilities _after_ a capabilities message from the other end.
        /// </para>
        /// <para>
        /// The purpose of this is to introduce capabilities without breaking backwards-compatibility. The server
        /// should set this to false (at least for a few months), while clients (viewers and mobile apps) should leave
        /// it set to true.
        /// </para>
        /// </param>
        public Connection(IFramedSocket socket, TransportConfig config = null, string connectionName = "Connection",
            bool sendCapabilities = true)
        {
            // Start out with all capabilities disabled and version 0.0. This will be set once we receive a
            // capabilities message from the remote side.
            NegotiatedCapabilities = TransportCapabilities.ZeroCapabilities;
            _SendCapabilities = sendCapabilities;

            _Socket = socket;
            _Callbacks = new MessageCallbackHandler();
            _Config = config ?? new TransportConfig(); // Use defaults if null
            _ConnectionName = connectionName;

            _LocalRttEstimate = new MovingAverage(100, _Config.BandwidthEstimatorSamples);
            _RemoteRttEstimate = 100;

            _InboundThroughputEstimate = new MovingAverage(128 * 1024, _Config.BandwidthEstimatorSamples);
            OutboundThroughputEstimate = 128 * 1024;

            _PongEvent = new AsyncAutoResetEvent();

            _IsClosing = new AsyncManualResetEvent();

            // 16 is the max value for _Config.MaxConcurrentMessages. The transport layer on the other side might have
            // a different configuration than us, so we always assume the max supported value when receiving.
            _ReceivedMessages = new Message[16];
            _ReceivedMessagesCount = 0;

            _DispatchQueue = new DispatchQueue();
            _DispatchEvent = new AsyncAutoResetEvent();

            _SendQueue = new SendQueue(_Config.PriorityLevels);
            _OutgoingMessagesToCancel = new ConcurrentQueue<OutgoingMessage>();
            _DataToSendEvent = new AsyncAutoResetEvent();

            _SendMessageNumbers = new ConcurrentQueue<byte>();
            for (byte n = 0; n < _Config.MaxConcurrentMessages; n++)
            {
                _SendMessageNumbers.Enqueue(n);
            }
            _MessageNumberEvent = new AsyncAutoResetEvent();

            // Start the worker threads. We start all except for the dispatch loop here, which must be explicitly
            // started by calling BeginDispatch(). We wait in order to avoid race conditions where we dispatch messages
            //before all of the callbacks are registered.
            LoopExceptionWrapper(ReceiveLoop());
            LoopExceptionWrapper(SendLoop());
        }

        /// <summary>
        /// Registers a callback to be executed on message events. These callbacks are invoked for all messages. For
        /// more granular callbacks, register on the <see cref="Message"/> object itself.
        /// </summary>
        /// <param name="events">Events that trigger the callback</param>
        /// <param name="callback">Callback function</param>
        public void RegisterCallback(MessageCallback callback,
            MessageCallbackEvents events = MessageCallbackEvents.Complete)
        {
            _Callbacks.RegisterCallback(callback, events);
        }

        /// <summary>
        /// Begins the dispatch loop. This must be called once all callbacks are registered using
        /// <see cref="RegisterCallback(MessageCallback, MessageCallbackEvents)"/>.
        /// </summary>
        public void BeginDispatch()
        {
            LoopExceptionWrapper(DispatchLoop());
        }

        /// <summary>
        /// Closes the connection
        /// </summary>
        /// <param name="reason">String describing the reason for closing</param>
        /// <param name="waitForRemote">If true, we block while the socket is closed gracefully</param>
        public async Task ForceClose(string reason, bool waitForRemote = false)
        {
            // Don't log reason unless this is the first call. The second reason is usually wrong.
            Debug.WriteLine(string.Format("{0}::ForceClose", _ConnectionName));

            // Ignore multiple calls to this function
            if (Interlocked.CompareExchange(ref _CloseReason, reason, null) == null)
            {
                Debug.WriteLine(string.Format("{0}::ForceClose reason={1} waitForRemote={2}", _ConnectionName, reason,
                    waitForRemote));

                await _Socket.CloseAsync(reason, waitForRemote);
                Debug.WriteLine(string.Format("{0}::ForceClose socket closed", _ConnectionName));

                // Cancel all messages in the process of being received
                for (byte n = 0; n < _ReceivedMessages.Length; n++)
                {
                    var message = _ReceivedMessages[n];
                    if (message != null)
                    {
                        CancelReceivedMessage(n);
                    }
                }

                _IsClosing.Set();
            }
        }

        /// <summary>
        /// Waits for the connection to close
        /// </summary>
        /// <returns>String describing the reason for closing</returns>
        public async Task<string> WaitClose()
        {
            // We used to actually wait on the RecieveLoop, SendLoop, and DispatchLoop tasks here, however .NET's
            // WebSocket client seems to be unpredictable when it comes to timing. Instead we solely rely on our own
            // event and let the tasks clean up whenever they finish.
            await _IsClosing.WaitAsync();
            Debug.WriteLine(string.Format("{0}::WaitClose exiting reason={1}", _ConnectionName, _CloseReason));
            return _CloseReason;
        }

        /// <summary>
        /// Wrapper around an async worker loop to catch any unhandled exceptions, log them, and terminate the
        /// connection
        /// </summary>
        /// <param name="task">Task returned by an async loop</param>
        private async void LoopExceptionWrapper(Task task)
        {
            try
            {
                await task;
            }
            catch (Exception ex)
            {
                Debug.WriteLine(string.Format("{0}::LoopExceptionWrapper caught exception", _ConnectionName));
                Debug.WriteLine(ex);
                await ForceClose(ex.GetType().FullName);
            }
        }

        private async Task ReceiveLoop()
        {
            // When we receive a control frame, it contains information about the upcoming data frames, which is stored
            // in this FIFO queue.
            var expectedDataFrames = new Queue<DataFrameControl>();

            // Timer used to estimate inbound throughput
            Stopwatch receiveTimer = null;

            // Byte counter used to estimate inbound throughput
            long bytesReceived = 0;

            while (true)
            {
                // Determine the next expected frame and where the data should be stored
                DataFrameControl expectedDataFrame = null;
                ArraySegment<byte> segment;
                if (expectedDataFrames.Count > 0)
                {
                    expectedDataFrame = expectedDataFrames.Dequeue();

                    // We are expecting a data frame
                    var buffer = _ReceivedMessages[expectedDataFrame.MessageNumber].Payload;
                    var offset = expectedDataFrame.Offset;
                    segment = new ArraySegment<byte>(buffer, offset, buffer.Length - offset);
                }
                else
                {
                    // We are expecting a control frame
                    segment = new ArraySegment<byte>(new byte[ControlFrame.MaxLength]);
                }

                // Receive a frame from the WebSocket
                int bytes = await _Socket.ReceiveFrameAsync(segment);
                Debug.WriteLine(string.Format("{0}::ReceiveLoop ReceiveFrameAsync returned {1} bytes",
                    _ConnectionName, bytes));
                if (bytes == -1)
                {
                    await ForceClose("WebSocket closed by remote side");
                    Debug.WriteLine(string.Format("{0}::ReceiveLoop exiting due to closed WebSocket",
                        _ConnectionName));
                    return;
                }
                else if (bytes <= 0)
                {
                    await ForceClose(string.Format("ReceiveFrameAsync returned error {0}", bytes));
                    Debug.WriteLine(string.Format("{0}::ReceiveLoop exiting due to error", _ConnectionName));
                    return;
                }
                Interlocked.Add(ref _BytesIn, bytes);
                
                // Resize segment to match the number of bytes returned
                if (bytes != segment.Count)
                {
                    segment = new ArraySegment<byte>(segment.Array, segment.Offset, bytes);
                }

                if (expectedDataFrame != null)
                {
                    //
                    // Process a data frame
                    //

                    // Estimate inbound throughput
                    bytesReceived += bytes;
                    if (expectedDataFrames.Count == 0)
                    {
                        // This was the last data frame in the group of frames. Calculate the estimate.
                        receiveTimer.Stop();
                        var elapsedMilliseconds = receiveTimer.ElapsedMilliseconds;
                        if (bytesReceived > _Config.SinglePacketMtu && elapsedMilliseconds > 0)
                        {
                            var estimate = bytesReceived * 1000 / elapsedMilliseconds;
                            _InboundThroughputEstimate.Record(estimate);
                        }
                    }

                    // We received part of a message. Send it to the dispatch loop. We don't want to process it on this
                    // thread, as doing so could reduce our receive throughput.
                    var message = _ReceivedMessages[expectedDataFrame.MessageNumber];
                    message.BytesReceived += bytes;

                    Debug.WriteLine(string.Format("{0}::ReceiveLoop dispatching MessageNumber={1} Length={2} " +
                        "BytesReceived={3}", _ConnectionName, expectedDataFrame.MessageNumber,
                        expectedDataFrame.Length, message.BytesReceived));

                    _DispatchQueue.Enqueue(message);
                    _DispatchEvent.Set();

                    if (expectedDataFrame.IsLast)
                    {
                        // Remove the message from the _ReceivedMessages array once it is completely received. This way
                        // the garbage collector can free the memory after it is dispatched, without waiting for the
                        // message number to get reused by another message.
                        _ReceivedMessages[expectedDataFrame.MessageNumber] = null;
                        Interlocked.Decrement(ref _ReceivedMessagesCount);
                    }
                }
                else
                {
                    //
                    // Process a control frame
                    //

                    var controlFrame = new ControlFrame(segment);

                    Debug.WriteLine(string.Format("{0}::ReceiveLoop control frame with opcode {1:X2}", _ConnectionName,
                        controlFrame.OpCode));
                    Debug.Assert(controlFrame.OpCode >= 0x00 && controlFrame.OpCode <= 0x12);

                    if (controlFrame.OpCode == 0x00)
                    {
                        // Received a capabilities message. Compute the intersection of the two libraries.
                        NegotiatedCapabilities = TransportCapabilities.Negotiate(TransportCapabilities.LocalCapabilities,
                            controlFrame.Capabilities);

                        // If we did not send a capabilities message yet, and the other end handles it, send one
                        if (NegotiatedCapabilities.Capabilities1.HasFlag(TransportCapabilities1.Capabilities) &&
                            !_CapabilitiesSent)
                        {
                            _SendCapabilities = true;
                            _DataToSendEvent.Set();
                        }
                    }
                    else if (controlFrame.OpCode >= 0x01 && controlFrame.OpCode <= 0x0f)
                    {
                        // Prepare for subsequent data frames
                        Debug.Assert(controlFrame.DataFrames.Length == controlFrame.OpCode);

                        // Start the timer to measure how long it takes to receive the data. We know the remote side
                        // sends all of the data frames immediately following the control frame, so this provides an
                        // accurate estimate of inbound throughput.
                        receiveTimer = new Stopwatch();
                        receiveTimer.Start();
                        bytesReceived = 0;

                        for (int n = 0; n < controlFrame.OpCode; n++)
                        {
                            var dataFrame = controlFrame.DataFrames[n];
                            Debug.WriteLine(string.Format("{0}::ReceiveLoop expecting data frame " +
                                "MessageNumber={1} Length={2} Offset={3} IsFirst={4} IsLast={5}", _ConnectionName,
                                dataFrame.MessageNumber, dataFrame.Length, dataFrame.Offset, dataFrame.IsFirst,
                                dataFrame.IsLast));

                            if (dataFrame.IsFirst)
                            {
                                var msg = new Message(dataFrame.Length, false);
                                msg.Header = dataFrame.Header;
                                _ReceivedMessages[dataFrame.MessageNumber] = msg;
                                Interlocked.Increment(ref _ReceivedMessagesCount);
                            }

                            expectedDataFrames.Enqueue(dataFrame);
                        }
                    }
                    else if (controlFrame.OpCode == 0x10)
                    {
                        // Received a Ping. Send a Pong.
                        _SendPong = true;
                        _PongEvent.Set();
                    }
                    else if (controlFrame.OpCode == 0x11)
                    {
                        // Received a Pong. Use this to update our RTT estimate.
                        var timer = Interlocked.Exchange(ref _PingResponseTimer, null);
                        if (timer != null)
                        {
                            timer.Stop();
                            _LocalRttEstimate.Record(timer.ElapsedMilliseconds);
                        }

                        _MissedPingCount = 0;
                    }
                    else if (controlFrame.OpCode == 0x12)
                    {
                        // Cancel messages in progress
                        CancelReceivedMessages(controlFrame.CancellationDetails.MessageNumbers);
                    }

                    // All control frames includes the RTT and throughput estimates from the remote side
                    _RemoteRttEstimate = controlFrame.RttEstimate;
                    OutboundThroughputEstimate = controlFrame.ThroughputEstimate;
                }
            }
        }

        /// <summary>
        /// Internal helper function to cancel a message that has been partially received
        /// </summary>
        /// <param name="messageNumber">Message number</param>
        private void CancelReceivedMessage(byte messageNumber)
        {
            Debug.WriteLine(string.Format("{0}::CancelReceivedMessage messageNumber={0}", _ConnectionName,
                messageNumber));
            Debug.Assert(messageNumber < _ReceivedMessages.Length);

            // Ensure the message number is a valid message
            if (_ReceivedMessages[messageNumber] == null)
            {
                throw new ArgumentException("Invalid message number", nameof(messageNumber));
            }

            // Set a flag on the message to indicate cancellation
            _ReceivedMessages[messageNumber]._IsCancelled = true;

            // Send the cancel events
            _DispatchQueue.Enqueue(_ReceivedMessages[messageNumber]);
            _DispatchEvent.Set();

            // Help the GC reclaim any memory consumed by the partially-received message
            _ReceivedMessages[messageNumber] = null;
            Interlocked.Decrement(ref _ReceivedMessagesCount);
        }

        /// <summary>
        /// Internal helper function to cancel multiple messages that have been partially received
        /// </summary>
        /// <param name="messageNumberBitmask">
        /// Bitmask of message numbers. Each set bit corresponds to a message to cancel.
        /// </param>
        private void CancelReceivedMessages(int messageNumberBitmask)
        {
            Debug.WriteLine(string.Format("{0}::CancelReceivedMessages bitmask={1}", _ConnectionName,
                messageNumberBitmask));

            for (byte n = 0; n < _ReceivedMessages.Length; n++)
            {
                if ((messageNumberBitmask & (1 << n)) != 0)
                {
                    CancelReceivedMessage(n);
                }
            }
        }

        private async Task DispatchLoop()
        {
            // Unlike the other threads, we don't immediately stop this one on close. We first must ensure that all of
            // the message cancel events have been sent out to avoid getting into a weird state. Waiting for
            // _ReceivedMessageCount to hit zero covers this case.
            while (!_IsClosing.IsSet || _ReceivedMessagesCount > 0)
            {
                Message message;
                if (_DispatchQueue.TryDequeue(out message))
                {
                    Debug.WriteLine(string.Format("{0}::DispatchLoop returning message of {1} bytes (IsComplete={2})",
                        _ConnectionName, message.BytesReceived, message.IsComplete));

                    // First, execute the message-level callbacks
                    message.ExecuteCallbacks();

                    // Then, execute the connection-level callbacks
                    message.ExecuteCallbacks(_Callbacks);
                }

                if (_DispatchQueue.Count == 0)
                {
                    // Block until another complete message is received
                    Debug.WriteLine(string.Format("{0}::DispatchLoop waiting for event", _ConnectionName));
                    await AsyncEventWaitHandle.WhenAny(_DispatchEvent, _IsClosing);
                }
            }

            Debug.WriteLine(string.Format("{0}::DispatchLoop exiting", _ConnectionName));
        }

        /// <summary>
        /// Sends a message
        /// </summary>
        /// <param name="message">Message to send</param>
        /// <param name="priority">Priority (0 = highest)</param>
        /// <param name="header">
        /// Optional header (max 64 bytes). This value is used instead of the header value in the message parameter
        /// on outgoing messages, which enables forwarding the payload while rewriting the header. The default value is
        /// no header. To forward the header as-is, set this value to message.Header.
        /// </param>
        /// <returns>
        /// <para>
        /// Returns an <see cref="OutgoingMessage"/> object. This object is read-only, but can be used to track the
        /// progress of the send operation. It can also be passed to <see cref="Cancel(OutgoingMessage)"/> to abort the
        /// send before completion.
        /// </para>
        /// <para>
        /// This call blocks until the message is successfully queued, however it returns before the message is
        /// actually sent. <see cref="TransportConfig.MaxConcurrentMessages"/> controls how many messages can be queued
        /// at a time. If this number is hit, this method will block.
        /// </para>
        /// </returns>
        public async Task<OutgoingMessage> Send(Message message, int priority, byte[] header = null)
        {
            Debug.WriteLine(string.Format("{0}::Send sending {1} bytes, priority={2}", _ConnectionName,
                message.Payload.LongLength, priority));

            if (priority >= _Config.PriorityLevels)
            {
                throw new ArgumentException("Exceeded max priority", nameof(priority));
            }

            if (_IsClosing.IsSet)
            {
                // Stop sending data if the socket is closed
                Debug.WriteLine(string.Format("{0}::Send aborting due to closing websocket (1)", _ConnectionName));
                return null;
            }

            // Get a message number. We may have to block waiting for one to become available if we have exceeded the
            // transport config's MaxConcurrentMessages.
            byte messageNumber;
            while (!_SendMessageNumbers.TryDequeue(out messageNumber))
            {
                await AsyncEventWaitHandle.WhenAny(_MessageNumberEvent, _IsClosing);
                if (_IsClosing.IsSet)
                {
                    Debug.WriteLine(string.Format("{0}::Send aborting due to closing websocket (2)", _ConnectionName));
                    return null;
                }
            }
            Debug.WriteLine(string.Format("{0}::Send messageNumber={1}", _ConnectionName, messageNumber));

            var messageOut = new OutgoingMessage(messageNumber, message, priority, header);

            if (!message.IsComplete)
            {
                // If we are forwarding a message before it is fully-received, register a callback with it to ensure we
                // signal the _DataToSendEvent whenever additional payload data is available
                message.RegisterCallback((Message msg, MessageCallbackEvents events) =>
                {
                    Debug.WriteLine(string.Format("{0}::MessageCallback(PayloadReceived) messageNumber={1} events={2}",
                        _ConnectionName, messageNumber, events));

                    _DataToSendEvent.Set();
                }, MessageCallbackEvents.PayloadReceived);

                // Likewise, if the receiving message gets cancelled, cancel the outgoing copy too
                message.RegisterCallback((Message msg, MessageCallbackEvents events) =>
                {
                    Debug.WriteLine(string.Format("{0}::MessageCallback(Cancelled) messageNumber={1} events={2}",
                        _ConnectionName, messageNumber, events));

                    Cancel(messageOut);
                }, MessageCallbackEvents.Cancelled);
            }

            // Enqueue the message
            _SendQueue.Enqueue(messageOut);
            _DataToSendEvent.Set();

            Debug.WriteLine(string.Format("{0}::Send returning messageNumber={1}", _ConnectionName, messageNumber));
            return messageOut;
        }

        /// <summary>
        /// <para>Cancels a message before completion.</para>
        /// <para>
        /// Note that this operation is fully asynchronous, so it is possible the message completes sending and is
        /// never cancelled.
        /// </para>
        /// </summary>
        /// <param name="message">Message to cancel</param>
        public void Cancel(OutgoingMessage message)
        {
            _OutgoingMessagesToCancel.Enqueue(message);
            _DataToSendEvent.Set();
        }

        private async Task SendLoop()
        {
            // dataFrames contains the control data for the outgoing frames we will send
            var dataFrames = new Queue<DataFrameControl>();

            // resetBytesRemainingEvent is used as the timer to throttle outgoing traffic
            AsyncEventWaitHandle resetBytesRemainingEvent = new AsyncManualResetEvent(true);

            // pingEvent is used as the timer to ensure we keep the outgoing connection active
            AsyncEventWaitHandle pingEvent = new AsyncManualResetEvent(true);

            // RNG to randomize ping times
            var random = new Random();

            int bytesRemaining = 0;

            while (!_IsClosing.IsSet)
            {
                if (resetBytesRemainingEvent.IsSet)
                {
                    // Calculate how many bytes we can send this iteration. Round up to the nearest multiple of an MTU.
                    bytesRemaining = (int)(OutboundThroughputEstimate * _Config.MaxPercentThroughput *
                        _Config.TargetResponsiveness / 100000);
                    bytesRemaining = ((bytesRemaining / _Config.SinglePacketMtu) + 1) * _Config.SinglePacketMtu;
                    resetBytesRemainingEvent = new AsyncTimerEvent(_Config.TargetResponsiveness);
                }
                Debug.WriteLine(string.Format("{0}::SendLoop bytesRemaining={1}", _ConnectionName, bytesRemaining));

                if (_SendPong)
                {
                    // Send the pong control frame
                    await SendControlFrame(0x11);
                    _SendPong = false;
                }

                if (_SendCapabilities)
                {
                    // Send a capability negotation message
                    await SendCapabilities();
                    _SendCapabilities = false;
                }

                if (!_OutgoingMessagesToCancel.IsEmpty)
                {
                    // Process message cancellations. To avoid race conditions, we always do these on the send thread
                    await CancelOutgoingMessages();
                }

                if (pingEvent.IsSet)
                {
                    // Only send a ping if there is not one currently outstanding
                    if (_PingResponseTimer == null)
                    {
                        // Send the Ping frame
                        await SendControlFrame(0x10);

                        // Measure the amount of time until we receive a Pong
                        var timer = new Stopwatch();
                        timer.Start();
                        _PingResponseTimer = timer;
                        _PingCount++;
                    }
                    else
                    {
                        _MissedPingCount++;
                        Debug.WriteLine(string.Format("{0}::SendLoop missedPingCount={1}", _ConnectionName,
                            _MissedPingCount));

                        if (_MissedPingCount >= _Config.MissedPingCount)
                        {
                            // The remote side is not responding to pings. Close the connection.
                            await ForceClose("Remote side did not respond to a ping");
                            Debug.WriteLine(string.Format("{0}::SendLoop exiting due to missed pings",
                                _ConnectionName));
                            return;
                        }
                    }

                    // Calculate the ping interval
                    int interval = _Config.PingInterval; // Ping every 10 seconds
                    if (_PingCount < (_Config.PingInterval / _Config.InitialPingInterval))
                    {
                        // For the first 10 seconds, ping at 1/second
                        interval = _Config.InitialPingInterval;
                    }

                    // Randomize the interval by +/- 50%
                    int randomizedInterval = interval + (interval / 2) - random.Next(interval);

                    // Reset the ping timer
                    pingEvent = new AsyncTimerEvent(randomizedInterval);
                }

                // Get the outgoing messages to send
                while (bytesRemaining > 0 && dataFrames.Count < 15)
                {
                    OutgoingMessage message;
                    int frameLength = _SendQueue.GetNext(bytesRemaining, out message);
                    if (message == null)
                    {
                        // There are no more messages with data ready to send
                        break;
                    }

                    int bytesReady = message.BytesReady;
                    Debug.WriteLine(string.Format("{0}::SendLoop frameLength={1} bytesReady={2}",
                        _ConnectionName, frameLength, bytesReady));
                    Debug.Assert(frameLength <= bytesReady);
                    Debug.Assert(frameLength <= bytesRemaining);

                    var dataFrame = new DataFrameControl()
                    {
                        Offset = message.BytesSent,
                        Length = message.Message.Payload.Length,
                        MessageNumber = message.MessageNumber,
                        IsFirst = message.BytesSent == 0,
                        IsLast = message.BytesRemaining == frameLength,
                        Payload = message.Message.Payload,
                        FrameLength = frameLength,
                        Header = message.Header
                    };
                    dataFrames.Enqueue(dataFrame);

                    Interlocked.Add(ref message._BytesSent, frameLength);
                    Debug.Assert(message.BytesSent <= message.Message.Payload.Length);
                    bytesRemaining -= frameLength;
                    Debug.Assert(bytesRemaining >= 0);
                }

                // If we have data to send, send it
                if (dataFrames.Count > 0)
                {
                    // Send the control frame
                    await SendControlFrame((byte)dataFrames.Count, dataFrames: dataFrames.ToArray());

                    // Send the data frames
                    while (dataFrames.Count > 0)
                    {
                        var dataFrame = dataFrames.Dequeue();
                        Debug.WriteLine(string.Format("{0}::SendLoop sending data frame of {1} bytes", _ConnectionName,
                            dataFrame.FrameLength));

                        // If this is the last frame of a message, we can return the message number to the queue for
                        // reuse by another message
                        if (dataFrame.IsLast)
                        {
                            _SendMessageNumbers.Enqueue(dataFrame.MessageNumber);
                            _MessageNumberEvent.Set();
                        }

                        // Send the actual data
                        await _Socket.SendFrameAsync(new ArraySegment<byte>(dataFrame.Payload, dataFrame.Offset,
                            dataFrame.FrameLength));
                        Interlocked.Add(ref _BytesOut, dataFrame.Length);
                    }
                }

                if (bytesRemaining > 0)
                {
                    // Block until there are new messages, pings, or pongs to send
                    Debug.WriteLine(string.Format("{0}::SendLoop waiting for messages, pings, or ACKs",
                        _ConnectionName));
                    await AsyncEventWaitHandle.WhenAny(_DataToSendEvent, pingEvent, _PongEvent, _IsClosing);
                }
                else
                {
                    // We are throttling output. Block until our bytesRemaining counter resets, or until there are
                    // pongs to send. No need to wait for pingTask, is it is much longer than the bytesRemaining reset
                    // interval.
                    Debug.WriteLine(string.Format("{0}::SendLoop waiting for data throttling", _ConnectionName));
                    await AsyncEventWaitHandle.WhenAny(resetBytesRemainingEvent, _PongEvent, _IsClosing);
                }

                Debug.WriteLine(string.Format("{0}::SendLoop looping", _ConnectionName));
            }

            Debug.WriteLine(string.Format("{0}::SendLoop exiting", _ConnectionName));
        }

        /// <summary>
        /// Internal helper function to process the <see cref="_OutgoingMessagesToCancel"/> collection. This function
        /// must be executed on the send thread to avoid race conditions.
        /// </summary>
        private async Task CancelOutgoingMessages()
        {
            int msgNumbers = 0;
            OutgoingMessage message;

            while (_OutgoingMessagesToCancel.TryDequeue(out message))
            {
                if (await CancelOutgoingMessage(message))
                {
                    msgNumbers |= (1 << message.MessageNumber);
                }
            }

            // Send a message to cancel message numbers
            if (msgNumbers != 0)
            {
                var cancel = new MessageCancelControl()
                {
                    MessageNumbers = (ushort)msgNumbers
                };
                await SendControlFrame(0x12, cancel: cancel);
            }
        }

        /// <summary>
        /// Internel helper function to do the work of <see cref="Cancel(OutgoingMessage)"/>
        /// </summary>
        /// <param name="message">Message to cancel</param>
        /// <returns>True if the message was successfully cancelled; false if it was unable to be cancelled</returns>
        private async Task<bool> CancelOutgoingMessage(OutgoingMessage message)
        {
            if (message.BytesRemaining == 0)
            {
                // The message already completed. Too late to cancel.
                return false;
            }

            if (!NegotiatedCapabilities.Capabilities1.HasFlag(TransportCapabilities1.CancelMessage))
            {
                // The other transport library is legacy and doesn't understand the cancel event. Rather than send a
                // message that immediately causes the socket to terminate, we'll just ignore the message cancellation
                // instead. However, if we run out of message numbers, go ahead and kill the socket, as we've basically
                // deadlocked and are just wasting service resources at this point.
                if (_SendMessageNumbers.IsEmpty)
                {
                    await ForceClose("Out of message numbers and unable to cancel");
                }

                return false;
            }

            // Remove the message from the send queue
            _SendQueue.Cancel(message);

            // Return the message number to be reused
            _SendMessageNumbers.Enqueue(message.MessageNumber);
            _MessageNumberEvent.Set();

            return true;
        }

        /// <summary>
        /// Creates and sends a control frame
        /// </summary>
        /// <param name="opCode">Operation code of the control frame</param>
        /// <param name="capabilities">Optional (depending on opCode) capabilities about the transport library</param>
        /// <param name="dataFrames">
        /// Optional (depending on opCode) information about data frames that follow the control frame
        /// </param>
        /// <param name="cancel">Optional (depending on opCode) details about messages to cancel</param>
        private async Task SendControlFrame(byte opCode, TransportCapabilities capabilities = null,
            DataFrameControl[] dataFrames = null, MessageCancelControl cancel = null)
        {
            // Build a control frame
            var controlFrame = new ControlFrame()
            {
                OpCode = opCode,
                RttEstimate = (ushort)_LocalRttEstimate.Value,
                ThroughputEstimate = (int)InboundThroughputEstimate,
                Capabilities = capabilities,
                DataFrames = dataFrames,
                CancellationDetails = cancel
            };
            Debug.WriteLine(string.Format("{0}::SendControlFrame OpCode={1:X2}", _ConnectionName, controlFrame.OpCode));
            Debug.Assert(controlFrame.OpCode >= 0x00 && controlFrame.OpCode <= 0x12);
            var controlFrameBytes = controlFrame.Write();

            // Send the control frame
            await _Socket.SendFrameAsync(controlFrameBytes);
            Interlocked.Add(ref _BytesOut, controlFrameBytes.Count);
        }

        /// <summary>
        /// Sends a capability negotiation message to the other side
        /// </summary>
        private async Task SendCapabilities()
        {
            await SendControlFrame(0x00, capabilities: TransportCapabilities.LocalCapabilities);
            _CapabilitiesSent = true;
        }

        /// <summary>
        /// Set after <see cref="SendCapabilities"/> is called
        /// </summary>
        private bool _CapabilitiesSent = false;

        /// <summary>
        /// Transport library version and capabilities negotiated with the remote side
        /// </summary>
        public TransportCapabilities NegotiatedCapabilities { get; private set; }

        /// <summary>
        /// If set, the send loop should send a capabilities message
        /// </summary>
        private bool _SendCapabilities;

        /// <summary>
        /// Number of bytes received over the WebSocket as input
        /// </summary>
        public long BytesIn
        {
            get { return _BytesIn; }
        }

        private long _BytesIn;

        /// <summary>
        /// Number of bytes sent over the WebSocket as output
        /// </summary>
        public long BytesOut
        {
            get { return _BytesOut; }
        }

        private long _BytesOut;

        /// <summary>
        /// Estimated Round-Trip Time, in milliseconds
        /// </summary>
        public long RttEstimate
        {
            get
            {
                // RTT should always the same in each direction, but is sometimes inaccurate due to server and network
                // load adding additional latency. For a more accurate measurement, both sides independently calculate
                // the RTT value and share their result. For the actual RTT estimate, we take the lower of the two.
                return Math.Min(_LocalRttEstimate.Value, _RemoteRttEstimate);
            }
        }

        /// <summary>
        /// Estimated RTT calculated by ourselves
        /// </summary>
        private MovingAverage _LocalRttEstimate;

        /// <summary>
        /// Estimated RTT calculated by the other side
        /// </summary>
        private long _RemoteRttEstimate;

        /// <summary>
        /// Estimated throughput of the outbound connection, in bytes/sec
        /// </summary>
        public long OutboundThroughputEstimate { get; private set; }

        /// <summary>
        /// Estimated throughput of the inbound connection, in bytes/sec
        /// </summary>
        public long InboundThroughputEstimate
        {
            get { return _InboundThroughputEstimate.Value; }
        }

        /// <summary>
        /// Moving average used to calculate the inbound throughput estimate
        /// </summary>
        private MovingAverage _InboundThroughputEstimate;

        /// <summary>
        /// Measures the interval between sending a Ping and receiving a Pong. This is used to calculate RTT.
        /// </summary>
        private Stopwatch _PingResponseTimer;

        /// <summary>
        /// Number of pings sent
        /// </summary>
        private long _PingCount;

        /// <summary>
        /// Number of consecutive pings that were not sent, because the previous was still waiting for a pong response.
        /// If this hits TransportConfig.MissedPingCount, the connection is closed.
        /// </summary>
        private int _MissedPingCount;

        /// <summary>
        /// Name string for debugging
        /// </summary>
        private string _ConnectionName;

        /// <summary>
        /// The WebSocket itself for the underlying connection
        /// </summary>
        private IFramedSocket _Socket;

        /// <summary>
        /// Callbacks registered with the connection itself. These callbacks receive events on any message received by
        /// the connection.
        /// </summary>
        private MessageCallbackHandler _Callbacks;

        /// <summary>
        /// Configuration settings for the transport library
        /// </summary>
        private TransportConfig _Config;

        /// <summary>
        /// Event used to signal when the connection is closing
        /// </summary>
        public AsyncManualResetEvent IsClosing { get { return _IsClosing; } }
        private AsyncManualResetEvent _IsClosing;

        /// <summary>
        /// String describing the reason for closing the connection
        /// </summary>
        private string _CloseReason;

        /// <summary>
        /// Array of messages partially received. The index is the message number, limited by
        /// <see cref="TransportConfig.MaxConcurrentMessages"/>, however we always assume 16 because the transport
        /// layer on the other side might have a different configuration value than we do.
        /// </summary>
        private Message[] _ReceivedMessages;

        /// <summary>
        /// Number of non-null values in the <see cref="_ReceivedMessages"/> array
        /// </summary>
        private int _ReceivedMessagesCount;
        
        /// <summary>
        /// Messages are dispatched from a separate dispatch loop to avoid holding up the receive loop. This queue
        /// contains the messages with events for it to dispatch. Signal <see cref="_DispatchEvent"/> to wake up the
        /// loop after adding a message here.
        /// </summary>
        private DispatchQueue _DispatchQueue;

        /// <summary>
        /// Event set when a new item is added to <see cref="_DispatchQueue"/>
        /// </summary>
        private AsyncAutoResetEvent _DispatchEvent;

        /// <summary>
        /// Prioritized queue of outgoing messages
        /// </summary>
        private SendQueue _SendQueue;

        /// <summary>
        /// <para>
        /// This is a collection of outgoing messages that should be cancelled. Cancellation occurs when the sender
        /// decides to stop sending a message, which most commonly occurs when forwarding a message, and the incoming
        /// connection dies before the message is fully received.
        /// </para>
        /// <para>
        /// To wake the send loop, signal <see cref="_DataToSendEvent"/> after adding messages to the queue.
        /// </para>
        /// </summary>
        private ConcurrentQueue<OutgoingMessage> _OutgoingMessagesToCancel;

        /// <summary>
        /// Set whenever we have data available for the send loop
        /// </summary>
        private AsyncAutoResetEvent _DataToSendEvent;

        /// <summary>
        /// Set whenever we need to send a Pong in response to a Ping
        /// </summary>
        private bool _SendPong;

        /// <summary>
        /// Set whenever we need to send a Pong in response to a Ping
        /// </summary>
        private AsyncAutoResetEvent _PongEvent;

        /// <summary>
        /// We limit the number of concurrent messages over the transport. At most, we allow 16 due to the 4-bit field
        /// that holds the message number, however the sender can choose to reduce the limit to improve latency. This
        /// queue tracks which message numbers are available for use.
        /// </summary>
        private ConcurrentQueue<byte> _SendMessageNumbers;

        /// <summary>
        /// Event set whenever a message number is returned to the queue making it available for reuse
        /// </summary>
        private AsyncAutoResetEvent _MessageNumberEvent;
    }
}
