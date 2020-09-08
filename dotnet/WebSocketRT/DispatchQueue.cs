using System.Collections.Concurrent;
using System.Collections.Generic;

namespace WhiteboardServer.Transport
{
    /// <summary>
    /// Thread-safe FIFO queue to dispatch messages from the transport layer
    /// </summary>
    /// <remarks>
    /// This looks a lot like <see cref="ConcurrentQueue{T}"/>, however that one doesn't
    /// prevent insering the same message multiple times.
    /// </remarks>
    internal class DispatchQueue
    {
        public void Enqueue(Message message)
        {
            lock (_Queue)
            {
                // Don't double-enqueue the message
                if (!_Set.Contains(message))
                {
                    _Queue.Enqueue(message);
                    _Set.Add(message);
                }
            }
        }

        public bool TryDequeue(out Message message)
        {
            lock (_Queue)
            {
                if (_Queue.TryDequeue(out message))
                {
                    _Set.Remove(message);
                    return true;
                }
                else
                {
                    return false;
                }
            }
        }

        public int Count => _Queue.Count;

        private readonly ConcurrentQueue<Message> _Queue = new ConcurrentQueue<Message>();
        private readonly HashSet<Message> _Set = new HashSet<Message>();
    }
}
