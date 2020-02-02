import { Message } from './Message';
import { Queue } from '@leosingleton/commonlibs';

/**
 * Thread-safe FIFO queue to dispatch messages from the transport layer
 *
 * This looks a lot like ConcurrentQueue{T}, however that one doesn't
 * prevent insering the same message multiple times.
 */
export class DispatchQueue {
  public enqueue(message: Message): void {
    // Don't double-enqueue the message
    if (!this._set.has(message)) {
      this._queue.enqueue(message);
      this._set.add(message);
    }
  }

  public dequeue(): Message {
    const message = this._queue.dequeue();
    if (message) {
      this._set.delete(message);
      return message;
    } else {
      return undefined;
    }
  }

  public getCount(): number {
    return this._queue.getCount();
  }

  private readonly _queue = new Queue<Message>();
  private readonly _set = new Set<Message>();
}
