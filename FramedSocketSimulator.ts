import { BinaryConverter } from './BinaryConverter';
import { Message } from './Message';

export class FramedSocketSimulator {
  /**
   * Fills a message's payload with a specific test pattern that can be validated to ensure the payload was
   * properly split and reassembled.
   * @param message Message to fill with a test pattern
   */
  public static fillMessageWithTestPattern(message: Message): void {
    let length = message.payload.byteLength;

    // Write the payload length to the first four bytes
    BinaryConverter.writeInt32(message.payload, 0, length);

    // Fill the rest of the bytes with the byte count, mod 256
    for (let n = 4; n < length; n++) {
      message.payload[n] = n % 256;
    }
  }

  /**
   * Validates a message's payload matches the test pattern created by FillMessageWithTestPattern()
   * @param message Message to validate
   * @returns True if it matches; false if not
   */
  public static validateMessageTestPattern(message: Message): boolean {
    let length = message.payload.byteLength;

    // The first four bytes contain the payload length
    let validateLength = BinaryConverter.readInt32(message.payload, 0);
    if (length !== validateLength) {
      return false;
    }

    // The rest of the bytes contain the byte count, mod 256
    for (let n = 4; n < length; n++) {
      if (message.payload[n] !== (n % 256)) {
        return false;
      }
    }

    return true;
  }
}
