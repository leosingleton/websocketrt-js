// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using System;
using System.Collections.Generic;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Priority queue used to store outgoing messages
    /// </summary>
    internal class SendQueue
    {
        public SendQueue(int priorityLevels)
        {
            _MessageQueues = new Queue<OutgoingMessage>[priorityLevels];
        }

        public void Enqueue(OutgoingMessage message)
        {
            int priority = message.Priority;

            lock (this)
            {
                var queue = _MessageQueues[priority];
                if (queue == null)
                {
                    queue = new Queue<OutgoingMessage>();
                    _MessageQueues[priority] = queue;
                }

                queue.Enqueue(message);

                _HighestPriority = Math.Min(_HighestPriority, priority);
            }
        }

        /// <summary>
        /// Gets the next outgoing message from the queue
        /// </summary>
        /// <param name="maxBytes">
        /// Maximum bytes the transport layer can send. If the next message is less than or equal to this number of
        /// bytes, it is removed from the queue. Otherwise, it remains at the head.
        /// </param>
        /// <param name="message">Returns the next outgoing message or null if none remain</param>
        /// <returns>
        /// Number of bytes to send. This may be less than the maxBytes parameter supplied if the highest priority
        /// message has less available payload. Returns 0 if there are no messages to send.
        /// </returns>
        public int GetNext(int maxBytes, out OutgoingMessage message)
        {
            lock (this)
            {
                int priority = _HighestPriority;

                while (priority < _MessageQueues.Length)
                {
                    var queue = _MessageQueues[priority];
                    if (queue != null)
                    {
                        if (queue.Count > 0)
                        {
                            message = queue.Peek();

                            int bytesReady = message.BytesReady;
                            if (bytesReady > 0)
                            {
                                // If this send completes the message, remove it from the queue
                                if (bytesReady == message.BytesRemaining && bytesReady <= maxBytes)
                                {
                                    queue.Dequeue();
                                }

                                return Math.Min(bytesReady, maxBytes);
                            }
                        }
                        else
                        {
                            // There are no more messages at this priority level
                            _HighestPriority++;
                        }
                    }

                    // No messages with data ready at this priority level. Try the next.
                    priority++;
                }
            }

            // No messages remaining
            message = null;
            return 0;
        }

        /// <summary>
        /// Removes a message from the send queue
        /// </summary>
        /// <param name="message">Message to cancel</param>
        public void Cancel(OutgoingMessage message)
        {
            lock (this)
            {
                var queue = _MessageQueues[message.Priority];
                if (queue != null)
                {
                    // This part is really ugly. Cancel() was completely an afterthought and the data structure
                    // wasn't designed to support it...
                    if (queue.Count == 1)
                    {
                        var peek = queue.Peek();
                        if (message == peek)
                        {
                            queue.Dequeue();
                            return;
                        }
                    }
                    else if (queue.Count > 1)
                    {
                        bool found = false;

                        var newQueue = new Queue<OutgoingMessage>();
                        while (queue.Count > 0)
                        {
                            var peek = queue.Dequeue();
                            if (message == peek)
                            {
                                found = true;
                            }
                            else
                            {
                                newQueue.Enqueue(peek);
                            }
                        }
                        _MessageQueues[message.Priority] = newQueue;

                        if (found)
                        {
                            return;
                        }
                    }
                }
            }

            throw new InvalidOperationException(string.Format("Failed to cancel message number {0} (Priority={1})",
                message.MessageNumber, message.Priority));
        }

        /// <summary>
        /// The message queues. Indexed by priority, where 0 = highest priority. Not all priority levels are used, so
        /// priority level is initialized on first use. Before initialization, the queue will be null.
        /// </summary>
        private Queue<OutgoingMessage>[] _MessageQueues;

        /// <summary>
        /// Highest priority level that currently has a message queued
        /// </summary>
        private int _HighestPriority;
    }
}
