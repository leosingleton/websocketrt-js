// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using LeoSingleton.CommonLibs.Coordination;
using Xunit;

namespace LeoSingleton.WebSocketRT.UnitTests
{
    /// <summary>
    /// Helper class to build a test case using the <see cref="FramedSocketSimulator"/>
    /// </summary>
    class ConnectionTestSimulator : FramedSocketSimulator
    {
        public ConnectionTestSimulator(int latency, int throughput) : base(latency, throughput)
        {
            Connection1 = new SimulatedConnection(Socket1, "Connection1");
            Connection2 = new SimulatedConnection(Socket2, "Connection2");
        }

        /// <summary>
        /// One simulated connection endpoint
        /// </summary>
        public readonly SimulatedConnection Connection1;

        /// <summary>
        /// The other simulated connection endpoint
        /// </summary>
        public readonly SimulatedConnection Connection2;

        /// <summary>
        /// Wrapper around the connection object to provide helper methods for unit tests
        /// </summary>
        public class SimulatedConnection : Connection
        {
            public SimulatedConnection(IFramedSocket socket, string connectionName) : base(socket, null, connectionName)
            {
                RegisterCallback((Message message, MessageCallbackEvents events) =>
                {
                    // We can't do asserts here, because it's not the main XUnit thread, so store the message and
                    // header. The unit test can validate it later by calling ValidateTestMessages().
                    Messages.Enqueue(message);

                    Interlocked.Increment(ref _MessagesReceived);
                    Interlocked.Add(ref _MessageBytesReceived, message.BytesReceived);
                    MessageReceivedEvent.Set();
                });

                RegisterCallback((Message message, MessageCallbackEvents events) =>
                {
                    Interlocked.Increment(ref _NewMessages);
                }, MessageCallbackEvents.NewMessage);

                RegisterCallback((Message message, MessageCallbackEvents events) =>
                {
                    Interlocked.Increment(ref _CancelledMessages);
                }, MessageCallbackEvents.Cancelled);
            }

            /// <summary>
            /// Messages received. The first element in the tuple is the message; the second the optional message
            /// header.
            /// </summary>
            public ConcurrentQueue<Message> Messages = new ConcurrentQueue<Message>();

            /// <summary>
            /// The number of messages that have been fully received
            /// </summary>
            public int MessagesReceived
            {
                get { return _MessagesReceived; }
            }
            private int _MessagesReceived;

            /// <summary>
            /// The number of bytes belonging to messages that have been fully received
            /// </summary>
            public int MessageBytesReceived
            {
                get { return _MessageBytesReceived; }
            }
            private int _MessageBytesReceived;

            /// <summary>
            /// Event signalled whenever a message is fully received
            /// </summary>
            private AsyncAutoResetEvent MessageReceivedEvent = new AsyncAutoResetEvent();

            /// <summary>
            /// Messages we begun to receive (but may later be cancelled before fully received)
            /// </summary>
            public int NewMessages
            {
                get { return _NewMessages; }
            }
            private int _NewMessages;

            /// <summary>
            /// Messages partially received then cancelled
            /// </summary>
            public int CancelledMessages
            {
                get { return _CancelledMessages; }
            }
            private int _CancelledMessages;

            /// <summary>
            /// Sends a message of the requested size and priority. The payload is filled with a test pattern to ensure
            /// that disassembly/reassembly of frames works correctly.
            /// </summary>
            /// <param name="bytes">Message size, in bytes</param>
            /// <param name="priority">Message priority (0 = highest)</param>
            /// <returns><see cref="OutgoingMessage"/> which can be used to cancel or monitor progress</returns>
            public async Task<OutgoingMessage> SendTestMessage(int bytes, int priority = 0)
            {
                var message = new Message(bytes);
                FillBufferWithTestPattern(message.Payload);
                var header = new byte[bytes % 61]; // 64 byte max
                FillBufferWithTestPattern(header);
                return await Send(message, priority, header);
            }

            /// <summary>
            /// Expect the specified number of messages and bytes to be received
            /// </summary>
            /// <param name="messageCount">Expected number of messages</param>
            /// <param name="bytes">Expected number of total bytes</param>
            /// <param name="minMilliseconds">Minimum time to arrive, in milliseconds</param>
            /// <param name="maxMilliseconds">Maximum time to arrive, in milliseconds</param>
            public async Task ExpectTestMessages(int messageCount, int bytes, int minMilliseconds, int maxMilliseconds)
            {
                var oneSecondTimer = new AsyncTimerEvent(1000, true);
                var elapsed = new Stopwatch();
                elapsed.Start();

                do
                {
                    // Wait for a message, or wake every 1 second
                    await AsyncEventWaitHandle.WhenAny(MessageReceivedEvent, oneSecondTimer);

                    if (MessagesReceived >= messageCount || MessageBytesReceived >= bytes)
                    {
                        Assert.Equal(messageCount, MessagesReceived);
                        Assert.Equal(bytes, MessageBytesReceived);
                        Assert.InRange(elapsed.ElapsedMilliseconds, minMilliseconds, maxMilliseconds);

                        // Success. Reset counters for future calls.
                        _MessagesReceived = 0;
                        _MessageBytesReceived = 0;
                        return;
                    }
                } while (elapsed.ElapsedMilliseconds < maxMilliseconds);
            }

            /// <summary>
            /// Validates all messages received and throws XUnits asserts if they do not match the patterns of messages
            /// created by <see cref="SendTestMessage(int, int)"/>
            /// </summary>
            public void ValidateTestMessages()
            {
                while (Messages.TryDequeue(out var message))
                {
                    Assert.NotNull(message);
                    Assert.True(ValidateBufferTestPattern(message.Payload));
                    Assert.NotNull(message.Header);
                    Assert.Equal(message.Payload.Length % 61, message.Header.Length);
                    Assert.True(ValidateBufferTestPattern(message.Header));
                }
            }
        }

        /// <summary>
        /// Begins the dispatch loop on both sides of the connection
        /// </summary>
        public void BeginDispach()
        {
            Connection1.BeginDispatch();
            Connection2.BeginDispatch();
        }

        /// <summary>
        /// Gracefully close the connections. Used to end a test case.
        /// </summary>
        public async Task CloseGracefully()
        {
            // Trigger the connnection close from c1's side
            await Connection1.ForceClose("Unit test is complete", true);

            // Wait for the connections to close
            await Connection1.WaitClose();
            await Connection2.WaitClose();
        }

        /// <summary>
        /// Validates all messages received and throws XUnits asserts if they do not match the patterns of messages
        /// created by <see cref="SimulatedConnection.SendTestMessage(int, int)"/>
        /// </summary>
        public void ValidateTestMessages()
        {
            Connection1.ValidateTestMessages();
            Connection2.ValidateTestMessages();
        }

        /// <summary>
        /// Forwards all messages from one connection to another
        /// </summary>
        /// <param name="srcConnection">Source connection</param>
        /// <param name="destConnection">Destination connection</param>
        /// <param name="notComplete">
        /// If true, we ensure the message is not complete before forwarding. The simulated latency and throughput on
        /// the srcConnection must be set to ensure this happens for the given message size without race conditions.
        /// </param>
        public static void ForwardConnection(SimulatedConnection srcConnection, SimulatedConnection destConnection,
            bool notComplete = true)
        {
            srcConnection.RegisterCallback(async (Message msg, MessageCallbackEvents events) =>
            {
                if (notComplete)
                {
                    Assert.False(msg.IsComplete);
                }

                await destConnection.Send(msg, 0, msg.Header);
            }, MessageCallbackEvents.NewMessage);
        }
    }
}
