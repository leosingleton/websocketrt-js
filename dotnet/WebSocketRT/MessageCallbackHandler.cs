// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Collections.Concurrent;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// <para>
    /// Enumerated value indicated the reason a message callback is executed
    /// </para>
    /// <para>
    /// This enum is used as a bitmask. It is possible that all flags are set simultaneously if the payload was
    /// delivered in one frame. The bitmask may also be used to filter which types of events to receive.
    /// </para>
    /// </summary>
    [Flags]
    public enum MessageCallbackEvents
    {
        /// <summary>
        /// No bits are set
        /// </summary>
        None = 0,

        /// <summary>
        /// Indicates the first callback for a given message. This may be sent before the payload is fully received.
        /// </summary>
        NewMessage = 1,

        /// <summary>
        /// Indicates that more payload has been received. This flag is set on every callback.
        /// </summary>
        PayloadReceived = 2,

        /// <summary>
        /// Indicates the payload is fully received, and there will be no more callbacks for this message.
        /// </summary>
        Complete = 4,

        /// <summary>
        /// Indicates the message has been cancelled and will never complete.
        /// </summary>
        Cancelled = 8,

        /// <summary>
        /// All bits are set
        /// </summary>
        All = NewMessage | PayloadReceived | Complete | Cancelled
    }

    /// <summary>
    /// Callback function for message events
    /// </summary>
    /// <param name="message">Message on which the events occurred</param>
    /// <param name="events">
    /// Bitmask indicating which events occured on the message. At least one of these was requested by the callback
    /// registration, however, it may include additional events the callback did not register for.
    /// </param>
    public delegate void MessageCallback(Message message, MessageCallbackEvents events);

    /// <summary>
    /// Helper class to register and execute callback functions
    /// </summary>
    internal class MessageCallbackHandler
    {
        /// <summary>
        /// Registers a callback to be executed on message events
        /// </summary>
        /// <param name="callback">Callback function</param>
        /// <param name="events">Events that trigger the callback</param>
        public void RegisterCallback(MessageCallback callback, MessageCallbackEvents events)
        {
            _Callbacks.Add(new CallbackPair()
            {
                Callback = callback,
                Events = events
            });
        }

        /// <summary>
        /// Executes all registered message callbacks
        /// </summary>
        /// <param name="message">Message</param>
        /// <param name="events">Events that occured on the message</param>
        /// <returns>Number of callback functions executed</returns>
        public int ExecuteCallbacks(Message message, MessageCallbackEvents events)
        {
            int count = 0;

            foreach (var pair in _Callbacks)
            {
                if ((pair.Events & events) != 0)
                {
                    pair.Callback(message, events);
                    count++;
                }
            }

            return count;
        }

        private class CallbackPair
        {
            public MessageCallback Callback;
            public MessageCallbackEvents Events;
        }

        private readonly ConcurrentBag<CallbackPair> _Callbacks = new ConcurrentBag<CallbackPair>();
    }
}
