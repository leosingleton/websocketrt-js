import { BinaryConverter } from './BinaryConverter';
import { TransportCapabilities } from './TransportCapabilities';

/** 
 * Frames sent over the WebSocket are either data frames containing payload or control frames, which are used for
 * the transport layers on each side to communicate control information. This class serializes and deserializes
 * control frames.
 */
export class ControlFrame {
  /**
   * Operation Code:
   *  0x00 = Capabilities Negotiation
   *  0x01 - 0x0f = Send Data Frames (value = # of data frames)
   *  0x10 = Ping
   *  0x11 = Pong
   *  0x12 = Cancel Messages
   */
  public opCode: number;

  /**
   * Current estimated RTT, in milliseconds
   */
  public rttEstimate: number;

  /**
   * Current estimated throughput, in bytes/sec. Measured in the direction from the computer receiving the control
   * frame to the computer sending the control frame.
   */
  public throughputEstimate: number;

  /**
   * If OpCode is 0x00, the remainder of the control frame contains the capabilities of the transport library.
   * 
   * If OpCode is 0x01-0x0f, additional control information about the data frames is here. The payloads for
   * these will be sent as separate frames immediately following the control frame.
   * 
   * If OpCode is 0x12, the remainder of the control frame contains details about which message numbers to.
   */
  public data: TransportCapabilities | DataFrameControl[] | MessageCancelControl;

  public constructor() {}

  public read(frame: DataView): void {
    let opCode = frame.getUint8(0);
    this.opCode = opCode;
    this.rttEstimate = frame.getUint16(2, false);
    this.throughputEstimate = frame.getInt32(4, false);

    let offset = 8;
    if (opCode === 0x00) {
      this.data = new TransportCapabilities();
      offset += this.data.read(new Uint8Array(frame.buffer), frame.byteOffset + offset);
    } else if (opCode >= 0x01 && opCode <= 0x0f) {
      this.data = new Array<DataFrameControl>(opCode);
      for (let n = 0; n < opCode; n++) {
        this.data[n] = new DataFrameControl();
        offset += this.data[n].read(new Uint8Array(frame.buffer), frame.byteOffset + offset);
      }
    } else if (opCode === 0x12) {
      this.data = new MessageCancelControl();
      offset += this.data.read(new Uint8Array(frame.buffer), frame.byteOffset + offset);
    }
  }

  public write(): DataView {
    let frame = new Uint8Array(ControlFrame.maxLength);
    frame[0] = this.opCode;
    BinaryConverter.writeUInt16(frame, 2, this.rttEstimate);
    BinaryConverter.writeInt32(frame, 4, this.throughputEstimate);

    let offset = 8;
    if (this.opCode === 0x00) {
      let data = this.data as TransportCapabilities;
      offset += data.write(frame, offset);
    } else if (this.opCode >= 0x01 && this.opCode <= 0x0f) {
      let data = this.data as DataFrameControl[];
      for (let n = 0; n < data.length; n++) {
        offset += data[n].write(frame, offset);
      }
    } else if (this.opCode === 0x12) {
      let data = this.data as MessageCancelControl;
      offset += data.write(frame, offset);
    }

    return new DataView(frame.buffer, 0, offset);
  }

  /**
   * Maximum size of a control frame, in bytes
   */
  public static readonly maxLength = 8 + (15 * 72);
}

export class DataFrameControl {
  /**
   * Offset of the data within the message (max 64 MB)
   */
  public offset: number;

  /**
   * Length of the total message (max 64 MB)
   */
  public length: number;

  /**
   * Identifies which of the messages in flight (0-15) this data payload is for
   */
  public messageNumber: number;

  /**
   * If true, this is the first data frame for the message. Any partial data previously received for this
   * message number should be discarded.
   */
  public isFirst: boolean;

  /**
   * If true, this is the last data frame for the message. The complete message can now be delivered to the
   * upper protocol layers.
   */
  public isLast: boolean;

  /**
   * Each data frame can include a header (max 64 bytes) in the control frame
   */
  public header: Uint8Array;

  /**
   * Payload of the message.
   * 
   * Warning: This field is not serialized to the control frame. It is only used internally by the SendLoop to
   * track the data to send.
   */
  public payload: Uint8Array;

  /**
   * Length of the outgoing frame.
   * 
   * Warning: This field is not serialized to the control frame. It is only used internally by the SendLoop to
   * track the data to send.
   */
  public frameLength: number;

  public constructor() {}

  public read(frame: Uint8Array, startIndex: number): number {
    // MessageNumber lives in the upper 4 bits of Offset. IsFirst lives in the 5th-higest bit if Length.
    // IsLast lives in the 6th-highest.
    this.offset = BinaryConverter.readInt32(frame, startIndex);
    this.messageNumber = (this.offset & 0xf0000000) >>> 28;
    this.isFirst = (this.offset & 0x08000000) !== 0;
    this.isLast = (this.offset & 0x04000000) !== 0;
    this.offset &= 0x03ffffff;

    // The header length lives in the upper 6 bits of Length
    this.length = BinaryConverter.readInt32(frame, startIndex + 4);
    let headerLength = (this.length & 0xfc000000) >>> 26;
    this.length &= 0x03ffffff;

    // Copy the header
    if (headerLength > 0) {
      this.header = frame.subarray(startIndex + 8, startIndex + 8 + headerLength);
    }

    return headerLength + 8;
  }

  public write(frame: Uint8Array, startIndex: number): number {
    // MessageNumber lives in the upper 4 bits of Offset. IsFirst lives in the 5th-higest bit if Length.
    // IsLast lives in the 6th-highest.
    let offset = this.offset & 0x03ffffff;
    offset |= (this.messageNumber & 0xf) << 28;
    offset |= (this.isFirst ? 1 : 0) << 27;
    offset |= (this.isLast ? 1 : 0) << 26;
    BinaryConverter.writeInt32(frame, startIndex, offset);

    let headerLength = this.header ? this.header.length : 0;

    // The header length lives in the upper 6 bits of Length
    let length = this.length & 0x03ffffff;
    if (headerLength > 0) {
      length |= (headerLength & 0x3f) << 26;
      frame.set(this.header, startIndex + 8);
    }
    BinaryConverter.writeInt32(frame, startIndex + 4, length);

    return headerLength + 8;
  }
}

/** Additional details on the cancel OpCode (0x12) */
export class MessageCancelControl {
  /** Bitmask of message numbers to cancel */
  public messageNumbers: number;

  public read(frame: Uint8Array, startIndex: number): number {
    this.messageNumbers = BinaryConverter.readUInt16(frame, startIndex);
    return 2;
  }

  public write(frame: Uint8Array, startIndex: number): number {
    BinaryConverter.writeUInt16(frame, startIndex, this.messageNumbers);
    return 2;
  }
}
