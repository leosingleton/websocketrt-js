// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Maps a WebSocket to the IFramedSocket interface
    /// </summary>
    public class WSFramedSocket : IFramedSocket
    {
        /// <summary>
        /// Constructor
        /// </summary>
        /// <param name="ws">WebSocket</param>
        public WSFramedSocket(WebSocket ws)
        {
            WS = ws;
        }

        /// <summary>
        /// Updated using interlocked operations to ensure CloseAsync() is only called once. 1 = true; 0 = false.
        /// </summary>
        private int IsClosing = 0;

        /// <summary>
        /// Cancellation token set when the WebSocket is closing
        /// </summary>
        private CancellationTokenSource IsClosingCts = new CancellationTokenSource();

#pragma warning disable CS1591 // Inherit XML comments
        public async Task<int> ReceiveFrameAsync(ArraySegment<byte> buffer)
#pragma warning restore CS1591
        {
            WebSocketReceiveResult result;
            int bytesReceived = 0;

            do
            {
                // If the client has exceeded the maximum messsage size set below, terminate its connection
                if (bytesReceived == buffer.Count)
                {
                    return (int)FramedSocketError.FrameTooLarge;
                }

                // Receive some data
                var remainingBuffer = new ArraySegment<byte>(buffer.Array, buffer.Offset + bytesReceived,
                    buffer.Count - bytesReceived);
                try
                {
                    result = await WS.ReceiveAsync(remainingBuffer, IsClosingCts.Token);
                }
                catch (OperationCanceledException)
                {
                    // ReceiveAsync() throws an exception on the CancellationToken
                    return (int)FramedSocketError.Closing;
                }
                catch (WebSocketException)
                {
                    // ReceiveAsync() throws an exception if the remote side doesn't gracefully close the WebSocket:
                    // "System.Net.WebSockets.WebSocketException (0x80004005): The remote party closed the WebSocket
                    // connection without completing the close handshake."
                    return (int)FramedSocketError.Closing;
                }

                // Handle the connection closing
                if (result.MessageType == WebSocketMessageType.Close || result.CloseStatus.HasValue)
                {
                    return (int)FramedSocketError.Closing;
                }

                // Ensure the message type is binary
                if (result.MessageType != WebSocketMessageType.Binary)
                {
                    return (int)FramedSocketError.InvalidType;
                }

                // The entire message may not be returned in a single call to ReceiveAsync. Handle this case.
                bytesReceived += result.Count;
            } while (!result.EndOfMessage);

            return bytesReceived;
        }

#pragma warning disable CS1591 // Inherit XML comments
        public async Task SendFrameAsync(ArraySegment<byte> buffer)
#pragma warning restore CS1591
        {
            try
            {
                await WS.SendAsync(buffer, WebSocketMessageType.Binary, true, IsClosingCts.Token);
            }
            catch (OperationCanceledException)
            {
                // ReceiveAsync() throws an OperationCanceledException on the CancellationToken. Catch in case
                // SendAsync() does the same.
            }
            catch (WebSocketException)
            {
                // ReceiveAsync() throws the exception. Catch in case SendAsync() does the same.
            }
        }

#pragma warning disable CS1591 // Inherit XML comments
        public async Task CloseAsync(string closeReason, bool waitForRemote)
#pragma warning restore CS1591
        {
            if (Interlocked.CompareExchange(ref IsClosing, 1, 0) == 0)
            {
                // Give the Send and Receive operations a chance to fail on their own, since aborting an operation in
                // progress using a cancellation token throws a lot of exceptions and generally leaves the socket in a
                // bad state.
                IsClosingCts.CancelAfter(60000);

                try
                {
                    if (waitForRemote)
                    {
                        await WS.CloseAsync(WebSocketCloseStatus.NormalClosure, closeReason, IsClosingCts.Token);
                    }
                    else
                    {
                        await WS.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, closeReason, IsClosingCts.Token);
                    }
                }
                catch (Exception)
                {
                    // Ignore exceptions on close
                }
            }
        }

        private WebSocket WS;
    }
}
