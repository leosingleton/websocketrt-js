// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Holds one complete message. Messages are broken up into one or more frames while in transport.
    /// </summary>
    public class Message
    {
        /// <summary>
        /// Constructor
        /// </summary>
        /// <param name="payloadLength">
        /// Optional payload length. If set, a buffer will be automatically created for <see cref="Payload"/>.
        /// </param>
        /// <param name="outgoing">True for outgoing messages; false for incoming</param>
        public Message(int payloadLength, bool outgoing = true)
        {
            Outgoing = outgoing;

            if (payloadLength > 0)
            {
                Payload = new byte[payloadLength];
            }
        }

        /// <summary>
        /// Constructor for outgoing messages only
        /// </summary>
        /// <param name="payload">Buffer for message payload</param>
        public Message(byte[] payload)
        {
            Outgoing = true;
            Payload = payload;
        }

        /// <summary>
        /// True for outgoing messages; false for incoming
        /// </summary>
        public bool Outgoing { get; private set; }

        /// <summary>
        /// Optional header (64 bytes max). This field is only used to return the header on incoming messages and not
        /// set on outgoing.
        /// </summary>
        public byte[] Header
        {
            get { return _Header; }
            internal set
            {
                if (Outgoing)
                {
                    throw new InvalidOperationException("Cannot set Header on outgoing Message");
                }
                _Header = value;
            }
        }
        private byte[] _Header;

        /// <summary>
        /// Payload data. Note that the size of the array is the expected length, not the actual length received.
        /// Always check <see cref="BytesReceived"/> for the actual number received so far, and don't read past that
        /// point in this array.
        /// </summary>
        public byte[] Payload { get; private set; }

        /// <summary>
        /// Number of payload bytes received
        /// </summary>
        public int BytesReceived
        {
            get
            {
                // Outgoing messages are always fully received. Only use _BytesReceived for incoming.
                return Outgoing ? Payload.Length : _BytesReceived;
            }

            set
            {
                if (Outgoing)
                {
                    throw new InvalidOperationException("Cannot set BytesReceived on outgoing Message");
                }

                _BytesReceived = value;
            }
        }

        private int _BytesReceived;

        /// <summary>
        /// True if the payload has been fully received; false otherwise
        /// </summary>
        public bool IsComplete => Payload.Length == BytesReceived;

        /// <summary>
        /// True if the message has been cancelled and will never complete
        /// </summary>
        public bool IsCancelled
        {
            get { return _IsCancelled; }
        }
        internal bool _IsCancelled;

        /// <summary>
        /// Reads the payload property as a JSON object
        /// </summary>
        /// <typeparam name="T">Expected object type of the payload</typeparam>
        /// <returns>Payload decoded from a JSON object</returns>
        public T GetPayloadAsJson<T>()
        {
            var payloadString = Encoding.UTF8.GetString(Payload);
            return JsonSerializer.Deserialize<T>(payloadString);
        }

        /// <summary>
        /// Writes the JSON notation for an object into the payload property
        /// </summary>
        /// <param name="obj">Payload to be encoded as JSON</param>
        public void SetPayloadAsJson<T>(T obj)
        {
            var payloadString = JsonSerializer.Serialize(obj);
            Payload = Encoding.UTF8.GetBytes(payloadString);
        }

        /// <summary>
        /// Registers a callback to be executed on message events
        /// </summary>
        /// <param name="callback">Callback function</param>
        /// <param name="events">Events that trigger the callback</param>
        public void RegisterCallback(MessageCallback callback,
            MessageCallbackEvents events = MessageCallbackEvents.Complete)
        {
            if (Outgoing)
            {
                throw new InvalidOperationException("Cannot register callbacks on outgoing messages");
            }

            if (events == 0)
            {
                throw new ArgumentException("Event mask is required", nameof(events));
            }

            if ((events & MessageCallbackEvents.NewMessage) != 0)
            {
                throw new ArgumentException("Cannot register for the NewMessage event at the message level",
                    nameof(events));
            }

            _Callbacks.RegisterCallback(callback, events);
        }

        /// <summary>
        /// Invoked from the dispatch loop to execute registered callbacks
        /// </summary>
        /// <param name="callbacks">
        /// Collection of registered callbacks. If null, the callbacks registered to this particular message are
        /// executed.
        /// </param>
        /// <returns>Number of callback functions executed</returns>
        internal int ExecuteCallbacks(MessageCallbackHandler callbacks = null)
        {
            Debug.Assert(!Outgoing);

            // Compute which events to send
            MessageCallbackEvents events = MessageCallbackEvents.PayloadReceived;
            if (!_SentNewMessageCallback)
            {
                if (callbacks != null)
                {
                    // This is hacky, but we get called twice, once for message-level callbacks where
                    // callbacks == null, followed by a second time for connection-level callbacks where
                    // callbacks != null. To ensure we deliver to both, we only set the boolean on the second call to
                    // this function. There are no race conditions, since the dispatch loop is single-threaded.
                    _SentNewMessageCallback = true;
                }
                events |= MessageCallbackEvents.NewMessage;
            }
            if (!_SentCompleteCallback && IsComplete)
            {
                if (callbacks != null)
                {
                    // Same hack as above, by for Complete events
                    _SentCompleteCallback = true;
                }
                events |= MessageCallbackEvents.Complete;
            }
            if (IsCancelled)
            {
                if (events.HasFlag(MessageCallbackEvents.NewMessage))
                {
                    // If we never delivered the NewMessage event, and the message is already cancelled, let's just not
                    // tell anyone...
                    return 0;
                }

                // Likewise, no reason to deliver a PayloadReceived event if the message is never going to complete...
                events = MessageCallbackEvents.Cancelled;
            }

            // Send the callbacks
            if (callbacks == null)
            {
                return _Callbacks.ExecuteCallbacks(this, events);
            }
            else
            {
                return  callbacks.ExecuteCallbacks(this, events);
            }
        }

        private MessageCallbackHandler _Callbacks = new MessageCallbackHandler();

        // The two booleans below ensure we only ever deliver one set of NewMessage and one set of Complete callbacks
        private bool _SentNewMessageCallback = false;
        private bool _SentCompleteCallback = false;
    }
}
