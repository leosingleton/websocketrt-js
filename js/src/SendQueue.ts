// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { OutgoingMessage } from './OutgoingMessage';
import { Queue } from '@leosingleton/commonlibs';

/** Priority queue used to store outgoing messages */
export class SendQueue {
  public constructor(priorityLevels: number) {
    this._messageQueues = new Array<Queue<OutgoingMessage>>(priorityLevels);
  }

  public enqueue(message: OutgoingMessage): void {
    const priority = message.priority;

    let queue = this._messageQueues[priority];
    if (!queue) {
      queue = new Queue<OutgoingMessage>();
      this._messageQueues[priority] = queue;
    }

    queue.enqueue(message);

    this._highestPriority = Math.min(this._highestPriority, priority);
  }

  /**
   * Gets the next outgoing message from the queue
   * @param maxBytes Maximum bytes the transport layer can send. If the next message is less than or equal to this
   *    number of bytes, it is removed from the queue. Otherwise, it remains at the head.
   * @returns messageContents Returns the next outgoing message or `null` if none remain
   * @returns bytesToSend Number of bytes to send. This may be less than the `maxBytes` parameter supplied if the
   *    highest priority message has less available payload. Returns 0 if there are no messages to send.
   */
  public getNext(maxBytes: number): { messageContents: OutgoingMessage, bytesToSend: number } {
    let priority = this._highestPriority;

    while (priority < this._messageQueues.length) {
      const queue = this._messageQueues[priority];
      if (queue) {
        let message: OutgoingMessage;
        if ((message = queue.tryPeek())) {
          const bytesReady = message.getBytesReady();
          if (bytesReady > 0) {
            // If this send completes the message, remove it from the queue
            if (bytesReady === message.getBytesRemaining() && bytesReady <= maxBytes) {
              queue.dequeue();
            }

            return {
              messageContents: message,
              bytesToSend: Math.min(bytesReady, maxBytes)
            };
          }
        } else {
          // There are no more messages at this priority level
          this._highestPriority++;
        }
      }

      // No messages with data ready at this priority level. Try the next.
      priority++;
    }

    // No messages remaining
    return {
      messageContents: null,
      bytesToSend: 0
    };
  }

  /**
   * Removes a message from the send queue
   * @param message Message to cancel
   */
  public cancel(message: OutgoingMessage): void {
    const queue = this._messageQueues[message.priority];
    if (queue) {
      // This part is really ugly. Cancel() was completely an afterthought and the data structure
      // wasn't designed to support it...
      if (queue.getCount() === 1) {
        const peek = queue.tryPeek();
        if (message === peek) {
          queue.dequeue();
          return;
        }
      } else if (queue.getCount() > 1) {
        let found = false;

        const newQueue = new Queue<OutgoingMessage>();
        while (queue.getCount() > 0) {
          const peek = queue.dequeue();
          if (message === peek) {
            found = true;
          } else {
            newQueue.enqueue(peek);
          }
        }
        this._messageQueues[message.priority] = newQueue;

        if (found) {
          return;
        }
      }
    }

    // Failed to cancel message
    throw new Error('Failed to cancel ' + message.messageNumber + ' ' + message.priority);
  }

  /**
   * The message queues. Indexed by priority, where 0 = highest priority. Not all priority levels are used, so
   * priority level is initialized on first use. Before initialization, the queue will be null.
   */
  private _messageQueues: Queue<OutgoingMessage>[];

  /** Highest priority level that currently has a message queued */
  private _highestPriority = 0;
}
