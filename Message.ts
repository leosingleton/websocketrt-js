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

  /** Reads the payload property as a JSON object */
  public getPayloadAsJson(): any {
    // Unpack the server's message
    let payloadString: string = String.fromCharCode.apply(null, this.payload);
    return JSON.parse(payloadString);
  }

  /** Writes the JSON notation for an object into the payload property */
  public setPayloadAsJson(obj: any): void {
    let payloadString = JSON.stringify(obj);

    // TODO: This part can probably be optimized. See: http://code.google.com/p/stringencoding/
    let payloadLength = payloadString.length;
    this.payload = new Uint8Array(payloadString.length);
    for (let n = 0; n < payloadLength; n++) {
      this.payload[n] = payloadString.charCodeAt(n);
    }
  }
}
