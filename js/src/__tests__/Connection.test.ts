// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { ConnectionTestSimulator } from '../ConnectionTestSimulator';
import { MessageCallbackEvents } from '../MessageCallbackHandler';
import { Message } from '../Message';
import { AsyncManualResetEvent, Task } from '@leosingleton/commonlibs';

describe('Connection', () => {

  it('Runs a basic simulator to execute the transport code in a unit test environment', async () => {
    // Zero latency, 1 GB/sec
    const sim = new ConnectionTestSimulator(0, 1024 * 1024 * 1024);
    sim.beginDispatch();

    // Send 1 MB from c1 to c2
    const messageSize = 1024 * 1024;
    await sim.connection1.sendTestMessage(messageSize);

    // Test case should be nearly instant, but give it up to 10 seconds
    await sim.connection2.expectTestMessages(1, messageSize, 0, 10000);

    // Close the connections
    await sim.closeGracefully();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 15000);

  // Run the simulator, but timing to ensure the bandwidth estimation works somewhat accurately. Unfortunately,
  // due to unpredictable load on the build server, we have to be somewhat generous with the min/max values.
  it('Timed Simulator', async () => {
    const sim = new ConnectionTestSimulator(250, 257 * 1024);
    sim.beginDispatch();

    // For more accurate timing, prime the connections with some data first to build up the bandwidth
    // estimations. This should complete in 4.25 seconds, but allow up to 15.
    const messageSize = 1023 * 1024;
    await sim.connection1.sendTestMessage(messageSize);
    await sim.connection2.sendTestMessage(messageSize);
    await sim.connection1.expectTestMessages(1, messageSize, 0, 15000);
    await sim.connection2.expectTestMessages(1, messageSize, 0, 15000);

    // Send 1 MB from c1 to c2
    await sim.connection1.sendTestMessage(messageSize);

    // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 6 seconds.
    await sim.connection2.expectTestMessages(1, messageSize, 4000, 6000);

    // Send 1 MB from c2 to c1
    await Task.delayAsync(500);
    await sim.connection2.sendTestMessage(messageSize);

    // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 6 seconds.
    await sim.connection1.expectTestMessages(1, messageSize, 4000, 6000);

    // Close the connections
    await sim.closeGracefully();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 45000);

  it('Simulates a dropped connection and ensures both sides detect it via pings and close gracefully', async () => {
    const sim = new ConnectionTestSimulator(251, 255 * 1024);
    sim.dropMessages = true; // Drop all messages to simulate a dropped WebSocket

    const onMessageReceived = (_msg: Message, _events: MessageCallbackEvents) => {
      expect(true).toBeFalsy(); // This callback should not be invoked during this test case
    };

    sim.connection1.registerCallback(onMessageReceived);
    sim.connection2.registerCallback(onMessageReceived);
    sim.beginDispatch();

    // The connections should detect the dead WebSocket and automatically close. This should takes 4 pings of
    // 5 seconds each, for a total of 20 seconds. The test case has an extra 10 seconds before it times out.
    await sim.connection1.waitClose();
    await sim.connection2.waitClose();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 30000);

  it('Registers callbacks and ensures we receive the expected callbacks', async () => {
    const sim = new ConnectionTestSimulator(0, 1024 * 1024);

    const isComplete = new AsyncManualResetEvent();
    let newMessageEvents = 0;
    let payloadReceivedEvents = 0;
    let completeEvents = 0;

    const onMessageReceived = (msg: Message, events: MessageCallbackEvents) => {
      if ((events & MessageCallbackEvents.NewMessage) !== 0) {
        newMessageEvents++;
        msg.registerCallback(onMessageReceived, MessageCallbackEvents.PayloadReceived |
          MessageCallbackEvents.Complete);
      }
      if ((events & MessageCallbackEvents.PayloadReceived) !== 0) {
        payloadReceivedEvents++;
      }
      if ((events & MessageCallbackEvents.Complete) !== 0) {
        completeEvents++;
        isComplete.setEvent();
      }
    };

    sim.connection1.registerCallback(onMessageReceived, MessageCallbackEvents.All);
    sim.connection2.registerCallback(onMessageReceived, MessageCallbackEvents.All);
    sim.beginDispatch();

    // Send 1 MB from c1 to c2
    const messageSize = 1022 * 1024;
    await sim.connection1.sendTestMessage(messageSize);

    // Wait for the message to be received. Give it 1 second more to catch any late callbacks.
    await isComplete.waitAsync();
    await Task.delayAsync(1000);

    // We should receive a single NewMessage event from the connection callback
    expect(newMessageEvents).toEqual(1);

    // We should receive more than 10 PayloadReceived events. Probably around 60-80.
    expect(payloadReceivedEvents).toBeGreaterThanOrEqual(10);
    expect(payloadReceivedEvents).toBeLessThanOrEqual(1000);

    // We should receive exactly two Complete events--one from the connection, one from the message
    expect(completeEvents).toEqual(2);

    // Close the connections
    await sim.closeGracefully();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 15000);

  it('Ensures the transport layer can forward a message that has only been partially received', async () => {
    const sim = new ConnectionTestSimulator(249, 255 * 1024);
    const messageSize = 1026 * 1024;

    // When c2 receives the beginning of a message, start forwarding it back to c1
    ConnectionTestSimulator.forwardConnection(sim.connection2, sim.connection1);
    sim.beginDispatch();

    // Send 1 MB from c1 to c2
    await sim.connection1.sendTestMessage(messageSize);

    // Wait for c1 to receive the message back. It should take 4.5 seconds, but allow up to 15.
    await sim.connection1.expectTestMessages(1, messageSize, 0, 15000);

    // Close the connections
    await sim.closeGracefully();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 20000);

  it('Tests message cancellation', async () => {
    const sim = new ConnectionTestSimulator(252, 257 * 1024);
    sim.beginDispatch();

    // Send 1 MB from c1 to c2
    const messageSize = 1022 * 1024;
    const message = await sim.connection1.sendTestMessage(messageSize);

    // Cancel the message after 1 second
    await Task.delayAsync(1000);
    sim.connection1.cancelMessage(message);

    // After 10 seconds, ensure the message is partially, but cancelled before being fully-delivered to c2
    await Task.delayAsync(10000);
    expect(sim.connection2.getMessagesReceived()).toEqual(0);
    expect(sim.connection2.getNewMessages()).toEqual(1);
    expect(sim.connection2.getCancelledMessages()).toEqual(1);

    // Send another message to ensure the connection is still good after cancelling a message
    const messageSize2 = 256 * 1024;
    await sim.connection1.sendTestMessage(messageSize2);
    await sim.connection2.expectTestMessages(1, messageSize2, 0, 10000);

    // Close the connections
    await sim.closeGracefully();

    // Ensure the received messages match the test patterns
    sim.validateTestMessages();
  }, 30000);

  // Ensures that if A sends a message to B and B forwards the message to C, if A cancels the message, the
  // cancellation automatically propagates to C
  it('Cancel Propagation', async () => {
    const simAB = new ConnectionTestSimulator(248, 255 * 1024);
    const simBC = new ConnectionTestSimulator(252, 257 * 1024);

    // B forwards all messages from A to C
    ConnectionTestSimulator.forwardConnection(simAB.connection2, simBC.connection1);
    simAB.beginDispatch();
    simBC.beginDispatch();

    // Send 1 MB from A to B
    const messageSize = 1025 * 1024;
    const message = await simAB.connection1.sendTestMessage(messageSize);

    // Cancel the message after 1 second
    await Task.delayAsync(1000);
    simAB.connection1.cancelMessage(message);

    // After 10 sec, ensure the message is partially received, but cancelled before being fully-delivered to C
    await Task.delayAsync(10000);
    expect(simBC.connection2.getMessagesReceived()).toEqual(0);
    expect(simBC.connection2.getNewMessages()).toEqual(1);
    expect(simBC.connection2.getCancelledMessages()).toEqual(1);

    // Send another message to ensure both connections are still good after cancelling a message
    const messageSize2 = 254 * 1024;
    await simAB.connection1.sendTestMessage(messageSize2);
    await simBC.connection2.expectTestMessages(1, messageSize2, 0, 10000);

    // Close the connections
    await simAB.closeGracefully();
    await simBC.closeGracefully();

    // Ensure the received messages match the test patterns
    simAB.validateTestMessages();
    simBC.validateTestMessages();
  }, 30000);

});
