// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

/**
 * Abstraction for a WebSocket-like transport that supports framing. By supporting this generic interface, we can
 * easily mock WebSockets and simulate the whiteboard transport offline.
 */
export interface IFramedSocket {
  /**
   * Receives one frame from the socket
   * @param buffer Destination to store the frame data
   * @returns On success, a positive value indicating the number of bytes received in the frame. On failure, a negative
   *    value from the FramedSocketError enum below.
   */
  receiveFrameAsync(buffer: DataView): Promise<number>;

  /**
   * Sends one frame over the socket
   * @param buffer Source to read the frame data from
   */
  sendFrameAsync(buffer: DataView): void;

  /**
   * Closes the socket
   * @param closeReason String describing the reason for closing
   * @param waitForRemote If true, we block while the socket is closed gracefully
   */
  closeAsync(closeReason: string, waitForRemote: boolean): void;
}

/**
 * Error codes returned by IFramedSocket.ReceiveFrameAsync()
 */
export const enum FramedSocketError {
  /**
   * The remote end closed the socket
   */
  Closing = -1,

  /**
   * The request was cancelled using the CancellationToken
   */
  Cancelled = -2,

  /**
   * The received frame exceeded the size of the input buffer supplied
   */
  FrameTooLarge = -3,

  /**
   * The received frame was not of binary type
   */
  InvalidType = -4
}
