/** 
 * Holds one complete message. Messages are broken up into one or more frames while in transport.
 */
export class Message {
  public constructor(payloadLength = 0) {
    if (payloadLength > 0) {
      this.payload = new Uint8Array(payloadLength);
    }
  }

  /**
   * Optional header (64 bytes max)
   */
  public header: Uint8Array;

  /**
   * Payload data
    */
  public payload: Uint8Array;
}
