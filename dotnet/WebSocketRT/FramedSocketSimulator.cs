using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using LeoSingleton.CommonLibs;
using LeoSingleton.CommonLibs.Coordination;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Simulates a WebSocket with latency for unit testing
    /// </summary>
    public class FramedSocketSimulator
    {
        /// <summary>
        /// Initializes the simulator
        /// </summary>
        /// <param name="latency">Simulated latency (one direction), in milliseconds</param>
        /// <param name="throughput">Simulated throughput (each direction), in bytes/sec</param>
        public FramedSocketSimulator(int latency, int throughput)
        {
            _IsClosed = new AsyncManualResetEvent();

            _Time = new Stopwatch();
            _Time.Start();

            Socket1 = new SocketSim(this, Socket1ToSocket2, Socket2ToSocket1, latency, throughput);
            Socket2 = new SocketSim(this, Socket2ToSocket1, Socket1ToSocket2, latency, throughput);
        }

        /// <summary>
        /// Returns the mock WebSocket-like object for socket 1
        /// </summary>
        public IFramedSocket Socket1 { get; private set; }

        /// <summary>
        /// Returns the mock WebSocket-like object for socket 2
        /// </summary>
        public IFramedSocket Socket2 { get; private set; }

        /// <summary>
        /// Whether the simulator should drop all incoming and outgoing messages to simulate a lost connection
        /// </summary>
        public bool DropMessages { get; set; }

        /// <summary>
        /// When closed, indicates whether the WebSocket was closed gracefully using waitForRemote
        /// </summary>
        private bool _GracefulClose;

        private SimQueue Socket1ToSocket2 = new SimQueue();
        private SimQueue Socket2ToSocket1 = new SimQueue();

        private AsyncManualResetEvent _IsClosed;
        private Stopwatch _Time;

        private void Close(bool waitForRemote)
        {
            if (!_IsClosed.IsSet)
            {
                _IsClosed.Set();
                _GracefulClose = waitForRemote;

                // Wake any receivers so they return a closing error code
                Socket1ToSocket2.Event.Set();
                Socket2ToSocket1.Event.Set();
            }
        }

        private class SocketSim : IFramedSocket
        {
            public SocketSim(FramedSocketSimulator sim, SimQueue sendQueue, SimQueue receiveQueue, int latency,
                int throughput)
            {
                _Sim = sim;
                _SendQueue = sendQueue;
                _ReceiveQueue = receiveQueue;
                _Latency = latency;
                _Throughput = throughput;
            }

            private FramedSocketSimulator _Sim;
            private SimQueue _SendQueue;
            private SimQueue _ReceiveQueue;
            private int _Latency;
            private int _Throughput;

            public async Task<int> ReceiveFrameAsync(ArraySegment<byte> buffer)
            {
                while (!_Sim._IsClosed.IsSet)
                {
                    SimFrame frame;
                    if (_ReceiveQueue.Queue.TryDequeue(out frame))
                    {
                        // Simulate latency
                        long timeRemaining = frame.DeliveryTime - _Sim._Time.ElapsedMilliseconds;
                        if (timeRemaining > 0)
                        {
                            await Task.Delay((int)timeRemaining);
                        }

                        // Simulate throughput
                        if (_Throughput > 0)
                        {
                            long throughputDelay = frame.Payload.LongLength * 1000 / _Throughput;
                            if (throughputDelay > 0)
                            {
                                await Task.Delay((int)throughputDelay);
                            }
                        }

                        if (frame.Payload.Length > buffer.Count)
                        {
                            return (int)FramedSocketError.FrameTooLarge;
                        }

                        Buffer.BlockCopy(frame.Payload, 0, buffer.Array, buffer.Offset, frame.Payload.Length);
                        return frame.Payload.Length;
                    }

                    await AsyncEventWaitHandle.WhenAny(_ReceiveQueue.Event, _Sim._IsClosed);
                }

                if (!_Sim._GracefulClose)
                {
                    // .NET's implementation of ReceiveAsync has a tendency to hang when the WebSocket is closed out
                    // from under it. Even the CancellationToken doesn't always work. Simulate this unwanted behavior.
                    await Task.Delay(60 * 1000);
                }

                return (int)FramedSocketError.Closing;
            }

            public Task SendFrameAsync(ArraySegment<byte> buffer)
            {
                if (_Sim.DropMessages || _Sim._IsClosed.IsSet)
                {
                    // Simulate a connection failure or closed socket by dropping all messages
                    return Task.CompletedTask;
                }

                var frame = new SimFrame()
                {
                    Payload = buffer.ToArray(),
                    DeliveryTime = _Sim._Time.ElapsedMilliseconds + _Latency
                };
                _SendQueue.Queue.Enqueue(frame);
                _SendQueue.Event.Set();
                return Task.CompletedTask;
            }

            public async Task CloseAsync(string closeReason, bool waitForRemote)
            {
                _Sim.Close(waitForRemote);

                if (waitForRemote && (_Sim.DropMessages || _Sim._IsClosed.IsSet))
                {
                    // If we try a graceful close on a dead (or already-closed) WebSocket, the real WebSocket
                    // implementation appears to hang for a really long time. However, we use a cancellation token to
                    // ensure we abort after 5 seconds.
                    await Task.Delay(5000);
                }
            }
        }

        private class SimQueue
        {
            public ConcurrentQueue<SimFrame> Queue = new ConcurrentQueue<SimFrame>();
            public AsyncAutoResetEvent Event = new AsyncAutoResetEvent();
        }

        private class SimFrame
        {
            public byte[] Payload;
            public long DeliveryTime;
        }

        /// <summary>
        /// Fills a buffer with a specific test pattern that can be validated to ensure it was properly split and
        /// reassembled.
        /// </summary>
        /// <param name="buffer">Buffer to fill with a test pattern</param>
        public static void FillBufferWithTestPattern(byte[] buffer)
        {
            var length = buffer.Length;

            if (length == 0)
            {
                return;
            }
            else if (length == 1)
            {
                buffer[0] = 1;
                return;
            }
            else if (length == 2)
            {
                buffer[0] = buffer[1] = 2;
                return;
            }
            else if (length == 3)
            {
                buffer[0] = buffer[1] = buffer[2] = 3;
                return;
            }

            // Write the payload length to the first four bytes
            BinaryConverter.Write(buffer, 0, length);

            // Fill the rest of the bytes with the byte count, mod 251 (a prime number to avoid repeats every 2^n)
            for (int n = 4; n < length; n++)
            {
                buffer[n] = (byte)(n % 251);
            }
        }

        /// <summary>
        /// Validates a buffer matches the test pattern created by <see cref="FillBufferWithTestPattern(byte[])"/>
        /// </summary>
        /// <param name="buffer">Buffer to validate</param>
        /// <returns>True if it matches; false if not</returns>
        public static bool ValidateBufferTestPattern(byte[] buffer)
        {
            var length = buffer.Length;

            if (length == 0)
            {
                return true;
            }
            else if (length == 1)
            {
                return (buffer[0] == 1);
            }
            else if (length == 2)
            {
                return (buffer[0] == 2) && (buffer[1] == 2);
            }
            else if (length == 3)
            {
                return (buffer[0] == 3) && (buffer[1] == 3) && (buffer[2] == 3);
            }

            // The first four bytes contain the payload length
            int validateLength = BinaryConverter.ReadInt32(buffer, 0);
            if (length != validateLength)
            {
                return false;
            }

            // The rest of the bytes contain the byte count, mod 251
            for (int n = 4; n < length; n++)
            {
                if (buffer[n] != (byte)(n % 251))
                {
                    return false;
                }
            }

            return true;
        }
    }
}
