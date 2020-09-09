using Xunit;

namespace LeoSingleton.WebSocketRT.UnitTests
{
    public class SendQueueTest
    {
        /// <summary>
        /// Ensures the SendQuee returns messages in priority order
        /// </summary>
        [Fact]
        public void CheckPriority()
        {
            var queue = new SendQueue(16);
            var message1 = new OutgoingMessage(1, new Message(100), 4);
            var message2 = new OutgoingMessage(2, new Message(100), 2); // 2 is higher-priority than 4

            queue.Enqueue(message1);
            queue.Enqueue(message2);

            OutgoingMessage message;
            int result;

            // message2 should be returned first, as it is higher priority
            result = queue.GetNext(100, out message);
            Assert.Equal(message2, message);
            Assert.Equal(100, result);
            message._BytesSent += result;

            // message1 should be returned next
            result = queue.GetNext(100, out message);
            Assert.Equal(message1, message);
            Assert.Equal(100, result);
            message._BytesSent += result;

            // null should be returned, as there are not more messages
            result = queue.GetNext(100, out message);
            Assert.Null(message);
            Assert.Equal(0, result);
        }

        /// <summary>
        /// Tests the SendQueue's Cancel() method
        /// </summary>
        [Fact]
        public void TestCancellation()
        {
            var queue = new SendQueue(16);

            // Create some messages
            byte messageNumber = 0;
            var priorities = new int[6] { 1, 2, 3, 3, 3, 15 };
            var messages = new OutgoingMessage[6];
            foreach (int priority in priorities)
            {
                var message = new OutgoingMessage(messageNumber, new Message(100), priority);
                queue.Enqueue(message);
                messages[messageNumber++] = message;
            }

            OutgoingMessage msg;

            // Cancel message 0. Message 1 will be returned next.
            queue.Cancel(messages[0]);
            queue.GetNext(100, out msg);
            Assert.Equal(1, msg.MessageNumber);

            // Cancel message 2. Message 3 will be returned next.
            queue.Cancel(messages[2]);
            queue.GetNext(100, out msg);
            Assert.Equal(3, msg.MessageNumber);

            // Cancel message 5. Message 4 will be returned next.
            queue.Cancel(messages[5]);
            queue.GetNext(100, out msg);
            Assert.Equal(4, msg.MessageNumber);

            // The queue is now empty.
            queue.GetNext(100, out msg);
            Assert.Null(msg);
        }

        /// <summary>
        /// Ensures higher priority messages are sent before lower
        /// </summary>
        /// <remarks>
        /// This repros a bug from Oct 2018 where Enqueue() was not updating the HighestPriority value. Although the
        /// bug occurred in the TypeScript port, the same equally could have happened in C#.
        /// </remarks>
        [Fact]
        public void TestHigherBeforeLower()
        {
            var queue = new SendQueue(16);

            var message1 = new OutgoingMessage(0, new Message(100), 0); // Higher-priority message
            var message2 = new OutgoingMessage(1, new Message(200), 1); // Lower-priority message

            OutgoingMessage message;
            int result;

            // Send the lower-priority, and read only half of it
            queue.Enqueue(message2);
            result = queue.GetNext(100, out message);
            Assert.Equal(1, message.MessageNumber);
            Assert.Equal(100, result);
            message._BytesSent += result;

            // Send the higher-priority. It should preempt the lower-priority.
            queue.Enqueue(message1);
            result = queue.GetNext(100, out message);
            Assert.Equal(0, message.MessageNumber);
            Assert.Equal(100, result);
            message._BytesSent += result;

            // Now we should get the remainder of the lower-priority.
            result = queue.GetNext(100, out message);
            Assert.Equal(1, message.MessageNumber);
            Assert.Equal(100, result);
            message._BytesSent += result;

            // The queue is now empty.
            result = queue.GetNext(100, out message);
            Assert.Null(message);
            Assert.Equal(0, result);
        }
    }
}
