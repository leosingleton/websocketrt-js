/** 
 * .NET's built-in BinaryReader/BinaryWriter doesn't support network byte order, nor does the BitConverter class. So we
 * build our own...
 */
export class BinaryConverter {
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
}
