import { Message } from './Message';
import { SendQueue, OutgoingMessage } from './SendQueue';

describe("SendQueue", () => {

  it("Ensures the SendQuee returns messages in priority order", () => {
    let queue = new SendQueue(16);
    let message1 = new OutgoingMessage(1, new Message(100));
    let message2 = new OutgoingMessage(2, new Message(100));

    queue.enqueue(message1, 4);
    queue.enqueue(message2, 2); // 2 is higher-priority than 4

    // message2 should be returned first, as it is higher priority
    let result1 = queue.getNext(100);
    expect(result1.message).toEqual(message2);
    expect(result1.sendRemaining).toBeTruthy();

    // message1 should be returned next
    let result2 = queue.getNext(100);
    expect(result2.message).toEqual(message1);
    expect(result2.sendRemaining).toBeTruthy();

    // null should be returned, as there are no more messages
    let result3 = queue.getNext(100);
    expect(result3.message).toBeNull();
    expect(result3.sendRemaining).toBeFalsy();
  });

});
