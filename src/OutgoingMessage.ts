// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { Message } from './Message';

/**
 * Object that wraps a Message as it is being sent. Returned by
 * `Connection.sendMessageAsync` as a way to monitor the message's progress or cancel it
 * before completion.
 */
export class OutgoingMessage {
  public constructor(messageNumber: number, message: Message, priority: number, header?: Uint8Array) {
    this.messageNumber = messageNumber;
    this.messageContents = message;
    this.priority = priority;
    this.header = header;
  }

  /** ID used within the transport library to identify the message */
  public readonly messageNumber: number;

  /** Message being sent */
  public readonly messageContents: Message;

  /** Message priority (0 = highest) */
  public readonly priority: number;

  /**
   * Optional header (max 64 bytes). This value is used instead of the header value in Message
   * itself on outgoing messages, which enables forwarding the payload while rewriting the header.
   */
  public readonly header: Uint8Array;

  /** Bytes sent so far */
  public getBytesSent(): number {
    return this._bytesSent;
  }

  /** Internal. Do not set outside the transport layer. */
  public _bytesSent = 0;

  /** Bytes remaining until the end of the message. See note on bytesReady. */
  public getBytesRemaining(): number {
    return this.messageContents.getPayload().length - this._bytesSent;
  }

  /**
   * The number of bytes ready to send. Note that this should not be confused with <see cref="BytesRemaining"/>
   + when messages are forwarded prior to being fully received. It can change both upwards as more data is
   + received and downwards as that data is forwarded.
   */
  public getBytesReady(): number {
    return this.messageContents.getBytesReceived() - this._bytesSent;
  }
}
