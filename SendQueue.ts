import { AsyncAutoResetEvent } from './Coordination/AsyncAutoResetEvent';
import { Message } from './Message';
import { Queue } from './Queue';

/**
 * Priority queue used to store outgoing messages
 */
export class SendQueue {
  public constructor(priorityLevels: number) {
    this._messageQueues = new Array<Queue<OutgoingMessage>>(priorityLevels);
    this._highestPriority = 0;
    this.notEmptyEvent = new AsyncAutoResetEvent();
  }

  public enqueue(message: OutgoingMessage, priority: number): void {
    let queue = this._messageQueues[priority];
    if (!queue) {
      queue = new Queue<OutgoingMessage>();
      this._messageQueues[priority] = queue;
    }

    queue.enqueue(message);

    this._highestPriority = Math.min(this._highestPriority, priority);

    this.notEmptyEvent.set();
  }

  /**
   * Gets the next outgoing message from the queue
   * @param maxBytes Maximum bytes the transport layer can send. If the next message is less than or equal to this
   *    number of bytes, it is removed from the queue. Otherwise, it remains at the head.
   * @returns message Returns the next outgoing message or null if none remain
   * @returns sendRemaining True if the message has been removed from the queue. False if the message is larger than
   *    maxBytes or no messages remain.
   */
  public getNext(maxBytes: number): {message: OutgoingMessage, sendRemaining: boolean} {
    while (this._highestPriority < this._messageQueues.length) {
      let queue = this._messageQueues[this._highestPriority];
      if (queue) {
        let message: OutgoingMessage;
        if (message = queue.tryPeek()) {
          if (message.getBytesRemaining() <= maxBytes) {
            queue.dequeue();
            return {
              message: message,
              sendRemaining: true
            };
          } else {
            return {
              message: message,
              sendRemaining: false
            }
          }
        }
      }

      // No frames found at this priority level. Try the next.
      this._highestPriority++;
    }

    // No messages remaining
    return {
      message: null,
      sendRemaining: false
    };
  }

  /**
   * The message queues. Indexed by priority, where 0 = highest priority. Not all priority levels are used, so
   * priority level is initialized on first use. Before initialization, the queue will be null.
   */
  private _messageQueues: Queue<OutgoingMessage>[];

  /**
   * Highest priority level that currently has a message queued
   */
  private _highestPriority: number;

  /**
   * Set whenever the outgoing queue is not empty
   */
  public readonly notEmptyEvent: AsyncAutoResetEvent;
}

/** 
 * Holds a single message on the outgoing queue
 */
export class OutgoingMessage {
  constructor(messageNumber: number, message: Message) {
    this.messageNumber = messageNumber;
    this.message = message;
  }

  public messageNumber: number;

  public message: Message;

  public bytesSent = 0;

  public getBytesRemaining(): number {
    return this.message.payload.length - this.bytesSent;
  }
}
