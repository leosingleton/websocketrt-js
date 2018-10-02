/** 
 * .NET's built-in BinaryReader/BinaryWriter doesn't support network byte order, nor does the BitConverter class. So we
 * build our own...
 */
export class BinaryConverter {
  public static readUInt64(buffer: Uint8Array, startIndex: number): number {
    return (buffer[startIndex] << 56) |
      (buffer[startIndex + 1] << 48) |
      (buffer[startIndex + 2] << 40) |
      (buffer[startIndex + 3] << 32) |
      (buffer[startIndex + 4] << 24) |
      (buffer[startIndex + 5] << 16) |
      (buffer[startIndex + 6] << 8) |
      buffer[startIndex + 7];
  }

  public static writeUInt64(buffer: Uint8Array, startIndex: number, value: number): void {
    buffer[startIndex] = (value & 0xff00000000000000) >> 56;
    buffer[startIndex + 1] = (value & 0xff000000000000) >> 48;
    buffer[startIndex + 2] = (value & 0xff0000000000) >> 40;
    buffer[startIndex + 3] = (value & 0xff00000000) >> 32;
    buffer[startIndex + 4] = (value & 0xff000000) >> 24;
    buffer[startIndex + 5] = (value & 0xff0000) >> 16;
    buffer[startIndex + 6] = (value & 0xff00) >> 8;
    buffer[startIndex + 7] = value & 0xff;
  }

  public static readInt32(buffer: Uint8Array, startIndex: number): number {
    return (buffer[startIndex] << 24) |
      (buffer[startIndex + 1] << 16) |
      (buffer[startIndex + 2] << 8) |
      buffer[startIndex + 3];
  }

  public static writeInt32(buffer: Uint8Array, startIndex: number, value: number): void {
    buffer[startIndex] = (value & 0xff000000) >>> 24;
    buffer[startIndex + 1] = (value & 0xff0000) >>> 16;
    buffer[startIndex + 2] = (value & 0xff00) >>> 8;
    buffer[startIndex + 3] = value & 0xff;
  }

  public static readUInt16(buffer: Uint8Array, startIndex: number): number {
    return ((buffer[startIndex] << 8) | buffer[startIndex + 1]);
  }

  public static writeUInt16(buffer: Uint8Array, startIndex: number, value: number): void {
    buffer[startIndex] = (value & 0xff00) >>> 8;
    buffer[startIndex + 1] = value & 0xff;
  }

  public static readInt16(buffer: Uint8Array, startIndex: number): number {
    return ((buffer[startIndex] << 8) | buffer[startIndex + 1]);
  }

  public static writeInt16(buffer: Uint8Array, startIndex: number, value: number): void {
    buffer[startIndex] = (value & 0xff00) >> 8;
    buffer[startIndex + 1] = value & 0xff;
  }
}
