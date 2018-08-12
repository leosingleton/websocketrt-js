import { FramedSocketSimulator } from './FramedSocketSimulator';
import { Message } from './Message';
import { AsyncTimerEvent } from '../common/coordination';
import { Connection } from './Connection';

describe("Connection", () => {

  it("Runs a basic simulator to execute the transport code in a unit test environment", async () => {
    let sim = new FramedSocketSimulator(250, 256 * 1024);

    let messageReceived: Message;
    let bytesReceived = 0;
    let onMessageReceived = async (msg: Message) => {
      messageReceived = msg;
      bytesReceived += msg.payload.byteLength;
    };

    let waitForBytes = async (size: number, maxSeconds: number) => {
      for (let n = 0; n < maxSeconds * 10; n++) {
        if (bytesReceived >= size) {
          break;
        }
        await AsyncTimerEvent.delay(100);
      }
    }

    let c1 = new Connection(sim.getSocket1(), onMessageReceived, null, 'Connection1');
    let c2 = new Connection(sim.getSocket2(), onMessageReceived, null, 'Connection2');

    // Send 1 MB from c1 to c2
    let messageSize = 1024 * 1024;
    let message = new Message(messageSize);
    FramedSocketSimulator.fillMessageWithTestPattern(message);
    await c1.send(message, 0);

    // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 8 seconds.
    await AsyncTimerEvent.delay(4000);
    expect(bytesReceived).toEqual(0);
    await waitForBytes(messageSize, 4);
    expect(bytesReceived).toEqual(messageSize);
    expect(messageReceived).toBeDefined();
    expect(FramedSocketSimulator.validateMessageTestPattern(messageReceived)).toBeTruthy();

    // Send 1 MB from c2 to c1
    await AsyncTimerEvent.delay(500);
    messageReceived = null;
    bytesReceived = 0;
    await c2.send(message, 0);

    // 1 MB should take 4.25 seconds at 256 KB/sec and 250 ms latency. Allow anywhere from 4 to 8 seconds.
    await AsyncTimerEvent.delay(4000);
    expect(bytesReceived).toEqual(0);
    await waitForBytes(messageSize, 4);
    expect(bytesReceived).toEqual(messageSize);
    expect(messageReceived).toBeDefined();
    expect(FramedSocketSimulator.validateMessageTestPattern(messageReceived)).toBeTruthy();

    // Trigger the connnection close from c1's side
    await c1.forceClose('Unit test is complete');

    // Wait for the connections to close
    await c1.waitClose();
    await c2.waitClose();
  }, 15000);

  it("Simulates a dropped connection and ensures both sides detect it via pings and close gracefully", async () => {
    let sim = new FramedSocketSimulator(250, 256 * 1024);
    sim.dropMessages = true; // Drop all messages to simulate a dropped WebSocket

    let onMessageReceived = async (msg: Message) => {
      expect(true).toBeFalsy('This callback should not be invoked during this test case');
    };

    let c1 = new Connection(sim.getSocket1(), onMessageReceived, null, 'Connection1');
    let c2 = new Connection(sim.getSocket2(), onMessageReceived, null, 'Connection2');

    // The connections should detect the dead WebSocket and automatically close. This should takes 4 pings of
    // 5 seconds each, for a total of 20 seconds. The test case has an extra 10 seconds before it times out.
    await c1.waitClose();
    await c2.waitClose();
  }, 30000);

});
