namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Object that wraps a <see cref="Message"/> as it is being sent. Returned by
    /// <see cref="Connection.Send(Message, int, byte[])"/> as a way to monitor the message's progress or cancel it
    /// before completion.
    /// </summary>
    public class OutgoingMessage
    {
        internal OutgoingMessage(byte messageNumber, Message message, int priority, byte[] header = null)
        {
            MessageNumber = messageNumber;
            Message = message;
            Priority = priority;
            Header = header;
        }

        /// <summary>
        /// ID used within the transport library to identify the message
        /// </summary>
        internal byte MessageNumber;

        /// <summary>
        /// Message being sent
        /// </summary>
        public readonly Message Message;

        /// <summary>
        /// Message priority (0 = highest)
        /// </summary>
        public readonly int Priority;

        /// <summary>
        /// Optional header (max 64 bytes). This value is used instead of the header value in <see cref="Message"/>
        /// itself on outgoing messages, which enables forwarding the payload while rewriting the header.
        /// </summary>
        public readonly byte[] Header;

        /// <summary>
        /// Bytes sent so far
        /// </summary>
        public int BytesSent
        {
            get { return _BytesSent; }
        }
        internal int _BytesSent;

        /// <summary>
        /// Bytes remaining until the end of the message. See note on <see cref="BytesReady"/>.
        /// </summary>
        public int BytesRemaining
        {
            get { return Message.Payload.Length - BytesSent; }
        }

        /// <summary>
        /// The number of bytes ready to send. Note that this should not be confused with <see cref="BytesRemaining"/>
        /// when messages are forwarded prior to being fully received. It can change both upwards as more data is
        /// received and downwards as that data is forwarded.
        /// </summary>
        public int BytesReady
        {
            get { return Message.BytesReceived - BytesSent; }
        }
    }
}
