import { Message } from './Message';
import { SendQueue } from './SendQueue';
import { OutgoingMessage } from './OutgoingMessage';

describe("SendQueue", () => {

  it("Ensures the SendQueue returns messages in priority order", () => {
    let queue = new SendQueue(16);
    let message1 = new OutgoingMessage(1, new Message(100), 4);
    let message2 = new OutgoingMessage(2, new Message(100), 2); // 2 is higher-priority than 4

    queue.enqueue(message1);
    queue.enqueue(message2);

    // message2 should be returned first, as it is higher priority
    let result1 = queue.getNext(100);
    expect(result1.message).toEqual(message2);
    expect(result1.bytesToSend).toEqual(100);
    result1.message._bytesSent += result1.bytesToSend;

    // message1 should be returned next
    let result2 = queue.getNext(100);
    expect(result2.message).toEqual(message1);
    expect(result2.bytesToSend).toEqual(100);
    result2.message._bytesSent += result2.bytesToSend;

    // null should be returned, as there are no more messages
    let result3 = queue.getNext(100);
    expect(result3.message).toBeNull();
    expect(result3.bytesToSend).toEqual(0);
  });

  it("Tests the SendQueue's Cancel() method", () => {
    let queue = new SendQueue(16);

    // Create some messages
    let messageNumber = 0;
    let priorities = [ 1, 2, 3, 3, 3, 15 ];
    let messages: OutgoingMessage[] = [];
    priorities.forEach(priority => {
      let message = new OutgoingMessage(messageNumber, new Message(100), priority);
      queue.enqueue(message);
      messages[messageNumber++] = message;
    });

    // Cancel message 0. Message 1 will be returned next.
    queue.cancel(messages[0]);
    let next = queue.getNext(100);
    expect(next.message.messageNumber).toEqual(1);

    // Cancel message 2. Message 3 will be returned next.
    queue.cancel(messages[2]);
    let next2 = queue.getNext(100);
    expect(next2.message.messageNumber).toEqual(3);

    // Cancel message 5. Message 4 will be returned next.
    queue.cancel(messages[5]);
    let next3 = queue.getNext(100);
    expect(next3.message.messageNumber).toEqual(4);

    // The queue is now empty.
    let next4 = queue.getNext(100);
    expect(next4.message).toBeNull();
  });

  // This repros a bug from Oct 2018 where enqueue() was not updating the _highestPriority value
  it("Sends higher priority messages before lower", () => {
    let queue = new SendQueue(16);

    let message1 = new OutgoingMessage(0, new Message(100), 0); // Higher-priority message
    let message2 = new OutgoingMessage(1, new Message(200), 1); // Lower-priority message

    // Send the lower-priority, and read only half of it
    queue.enqueue(message2);
    let next = queue.getNext(100);
    expect(next.message.messageNumber).toEqual(1);
    expect(next.bytesToSend).toEqual(100);
    next.message._bytesSent += next.bytesToSend;

    // Send the higher-priority. It should preempt the lower-priority.
    queue.enqueue(message1);
    let next2 = queue.getNext(100);
    expect(next2.message.messageNumber).toEqual(0);
    expect(next2.bytesToSend).toEqual(100);
    next2.message._bytesSent += next2.bytesToSend;

    // Now we should get the remainder of the lower-priority.
    let next3 = queue.getNext(100);
    expect(next3.message.messageNumber).toEqual(1);
    expect(next3.bytesToSend).toEqual(100);
    next3.message._bytesSent += next3.bytesToSend;

    // The queue is now empty.
    let next4 = queue.getNext(100);
    expect(next4.message).toBeNull();
    expect(next4.bytesToSend).toEqual(0);
  });

});
