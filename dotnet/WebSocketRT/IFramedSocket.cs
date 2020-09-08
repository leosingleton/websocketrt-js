using System;
using System.Threading.Tasks;

namespace WhiteboardServer.Transport
{
    /// <summary>
    /// Abstraction for a WebSocket-like transport that supports framing. By supporting this generic interface, we can
    /// easily mock WebSockets and simulate the whiteboard transport offline.
    /// </summary>
    public interface IFramedSocket
    {
        /// <summary>
        /// Receives one frame from the socket
        /// </summary>
        /// <param name="buffer">Destination to store the frame data</param>
        /// <returns>
        /// On success, a positive value indicating the number of bytes received in the frame. On failure, a negative
        /// value from the FramedSocketError enum below.
        /// </returns>
        Task<int> ReceiveFrameAsync(ArraySegment<byte> buffer);

        /// <summary>
        /// Sends one frame over the socket
        /// </summary>
        /// <param name="buffer">Source to read the frame data from</param>
        Task SendFrameAsync(ArraySegment<byte> buffer);

        /// <summary>
        /// Closes the socket
        /// </summary>
        /// <param name="closeReason">String describing the reason for closing</param>
        /// <param name="waitForRemote">If true, we block while the socket is closed gracefully</param>
        Task CloseAsync(string closeReason, bool waitForRemote);
    }

    /// <summary>
    /// Error codes returned by IFramedSocket.ReceiveFrameAsync()
    /// </summary>
    public enum FramedSocketError : int
    {
        /// <summary>
        /// The remote end closed the socket
        /// </summary>
        Closing = -1,

        // Cancelled = -2, // Formerly used when the methods took a CancellationToken parameter

        /// <summary>
        /// The received frame exceeded the size of the input buffer supplied
        /// </summary>
        FrameTooLarge = -3,

        /// <summary>
        /// The received frame was not of binary type
        /// </summary>
        InvalidType = -4
    }
}
