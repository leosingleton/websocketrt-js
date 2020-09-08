using System.Threading.Tasks;
using WhiteboardServer.Common.Coordination;
using WhiteboardServer.Transport;
using Xunit;

namespace WhiteboardServer.UnitTests.Transport
{
    public class ConnectionTest
    {
        /// <summary>
        /// Runs a basic simulator to execute the transport code in a unit test environment
        /// </summary>
        [Fact]
        public async Task Simulator()
        {
            // Zero latency, 1 GB/sec
            var sim = new ConnectionTestSimulator(0, 1024 * 1024 * 1024);
            sim.BeginDispach();

            // Send 1 MB from c1 to c2
            const int messageSize = 1024 * 1024;
            await sim.Connection1.SendTestMessage(messageSize);

            // Test case should be nearly instant, but give it up to 10 seconds
            await sim.Connection2.ExpectTestMessages(1, messageSize, 0, 10000);

            // Close the connections
            await sim.CloseGracefully();

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Run the simulator, but timing to ensure the bandwidth estimation works somewhat accurately. Unfortunately,
        /// due to unpredictable load on the build server, we have to be somewhat generous with the min/max values.
        /// </summary>
        [Fact]
        public async Task TimedSimulator()
        {
            var sim = new ConnectionTestSimulator(250, 257 * 1024);
            sim.BeginDispach();

            // For more accurate timing, prime the connections with some data first to build up the bandwidth
            // estimations. This should complete in 4.25 seconds, but allow up to 15.
            const int messageSize = 1023 * 1024;
            await sim.Connection1.SendTestMessage(messageSize);
            await sim.Connection2.SendTestMessage(messageSize);
            await sim.Connection1.ExpectTestMessages(1, messageSize, 0, 15000);
            await sim.Connection2.ExpectTestMessages(1, messageSize, 0, 15000);

            // Send 1 MB from c1 to c2
            await sim.Connection1.SendTestMessage(messageSize);

            // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 6 seconds.
            await sim.Connection2.ExpectTestMessages(1, messageSize, 4000, 6000);

            // Send 1 MB from c2 to c1
            await Task.Delay(500);
            await sim.Connection2.SendTestMessage(messageSize);

            // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 6 seconds.
            await sim.Connection1.ExpectTestMessages(1, messageSize, 4000, 6000);

            // Close the connections
            await sim.CloseGracefully();

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Simulates a dropped connection and ensures both sides detect it via pings and close gracefully
        /// </summary>
        [Fact]
        public async Task DroppedConnectionSimulator()
        {
            var sim = new ConnectionTestSimulator(251, 255 * 1024);
            sim.DropMessages = true; // Drop all messages to simulate a dropped WebSocket

            void onMessageReceived(Message msg, MessageCallbackEvents events)
            {
                Assert.False(true, "This callback should not be invoked during this test case");
            }

            sim.Connection1.RegisterCallback(onMessageReceived);
            sim.Connection2.RegisterCallback(onMessageReceived);
            sim.BeginDispach();

            // The connections should detect the dead WebSocket and automatically close. This should takes 4 pings of
            // 5 seconds each, for a total of 20 seconds.
            Task<string> t1 = sim.Connection1.WaitClose();
            Task<string> t2 = sim.Connection1.WaitClose();
            await Task.Delay(30000); // Give 10 extra seconds
            Assert.True(t1.IsCompleted, "Connection1 failed to close in 30 seconds");
            Assert.True(t2.IsCompleted, "Connection2 failed to close in 30 seconds");

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Registers callbacks and ensures we receive the expected callbacks
        /// </summary>
        [Fact]
        public async Task ValidateCallbacks()
        {
            var sim = new ConnectionTestSimulator(0, 1024 * 1024);

            var isComplete = new AsyncManualResetEvent();
            int newMessageEvents = 0;
            int payloadReceivedEvents = 0;
            int completeEvents = 0;

            void onMessageReceived(Message msg, MessageCallbackEvents events)
            {
                if ((events & MessageCallbackEvents.NewMessage) != 0)
                {
                    newMessageEvents++;
                    msg.RegisterCallback(onMessageReceived, MessageCallbackEvents.PayloadReceived |
                        MessageCallbackEvents.Complete);
                }
                if ((events & MessageCallbackEvents.PayloadReceived) != 0)
                {
                    payloadReceivedEvents++;
                }
                if ((events & MessageCallbackEvents.Complete) != 0)
                {
                    completeEvents++;
                    isComplete.Set();
                }
            }

            sim.Connection1.RegisterCallback(onMessageReceived, MessageCallbackEvents.All);
            sim.Connection2.RegisterCallback(onMessageReceived, MessageCallbackEvents.All);
            sim.BeginDispach();

            // Send 1 MB from c1 to c2
            const int messageSize = 1022 * 1024;
            await sim.Connection1.SendTestMessage(messageSize);

            // Wait for the message to be received. Give it 1 second more to catch any late callbacks.
            await isComplete.WaitAsync();
            await Task.Delay(1000);

            // We should receive a single NewMessage event from the connection callback
            Assert.Equal(1, newMessageEvents);

            // We should receive more than 10 PayloadReceived events. Probably around 60-80.
            Assert.InRange(payloadReceivedEvents, 10, 1000);

            // We should receive exactly two Complete events--one from the connection, one from the message
            Assert.Equal(2, completeEvents);

            // Close the connections
            await sim.CloseGracefully();

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Ensures the transport layer can forward a message that has only been partially received
        /// </summary>
        [Fact]
        public async Task ForwardPartialMessage()
        {
            var sim = new ConnectionTestSimulator(249, 255 * 1024);
            const int messageSize = 1026 * 1024;

            // When c2 receives the beginning of a message, start forwarding it back to c1
            ConnectionTestSimulator.ForwardConnection(sim.Connection2, sim.Connection1);
            sim.BeginDispach();

            // Send 1 MB from c1 to c2
            await sim.Connection1.SendTestMessage(messageSize);

            // Wait for c1 to receive the message back. It should take 4.5 seconds, but allow up to 15.
            await sim.Connection1.ExpectTestMessages(1, messageSize, 0, 15000);

            // Close the connections
            await sim.CloseGracefully();

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Tests message cancellation
        /// </summary>
        [Fact]
        public async Task CancelMessage()
        {
            var sim = new ConnectionTestSimulator(252, 257 * 1024);
            sim.BeginDispach();

            // Send 1 MB from c1 to c2
            const int messageSize = 1022 * 1024;
            var message = await sim.Connection1.SendTestMessage(messageSize);

            // Cancel the message after 1 second
            await Task.Delay(1000);
            sim.Connection1.Cancel(message);

            // After 10 seconds, ensure the message is partially, but cancelled before being fully-delivered to c2
            await Task.Delay(10000);
            Assert.Equal(0, sim.Connection2.MessagesReceived);
            Assert.Equal(1, sim.Connection2.NewMessages);
            Assert.Equal(1, sim.Connection2.CancelledMessages);

            // Send another message to ensure the connection is still good after cancelling a message
            const int messageSize2 = 256 * 1024;
            await sim.Connection1.SendTestMessage(messageSize2);
            await sim.Connection2.ExpectTestMessages(1, messageSize2, 0, 10000);

            // Close the connections
            await sim.CloseGracefully();

            // Ensure the received messages match the test patterns
            sim.ValidateTestMessages();
        }

        /// <summary>
        /// Ensures that if A sends a message to B and B forwards the message to C, if A cancels the message, the
        /// cancellation automatically propagates to C
        /// </summary>
        [Fact]
        public async Task CancelPropagation()
        {
            var simAB = new ConnectionTestSimulator(248, 255 * 1024);
            var simBC = new ConnectionTestSimulator(252, 257 * 1024);

            // B forwards all messages from A to C
            ConnectionTestSimulator.ForwardConnection(simAB.Connection2, simBC.Connection1);
            simAB.BeginDispach();
            simBC.BeginDispach();

            // Send 1 MB from A to B
            const int messageSize = 1025 * 1024;
            var message = await simAB.Connection1.SendTestMessage(messageSize);

            // Cancel the message after 1 second
            await Task.Delay(1000);
            simAB.Connection1.Cancel(message);

            // After 10 sec, ensure the message is partially received, but cancelled before being fully-delivered to C
            await Task.Delay(10000);
            Assert.Equal(0, simBC.Connection2.MessagesReceived);
            Assert.Equal(1, simBC.Connection2.NewMessages);
            Assert.Equal(1, simBC.Connection2.CancelledMessages);

            // Send another message to ensure both connections are still good after cancelling a message
            const int messageSize2 = 254 * 1024;
            await simAB.Connection1.SendTestMessage(messageSize2);
            await simBC.Connection2.ExpectTestMessages(1, messageSize2, 0, 10000);

            // Close the connections
            await simAB.CloseGracefully();
            await simBC.CloseGracefully();

            // Ensure the received messages match the test patterns
            simAB.ValidateTestMessages();
            simBC.ValidateTestMessages();
        }
    }
}
