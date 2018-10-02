/** 
 * .NET's built-in BinaryReader/BinaryWriter doesn't support network byte order, nor does the BitConverter class. So we
 * build our own...
 */
export class BinaryConverter {
  public static readUInt64(buffer: Uint8Array, startIndex: number): number {
    // JavaScript bitwise operators work on signed 32-bit integers. Work around this limitation by reading two 32-bit
    // signed integers, then converting them to a single unsigned 64-bit.
    let high = this.readInt32(buffer, startIndex);
    let low = this.readInt32(buffer, startIndex + 4);

    // To unsigned
    if (high < 0) { high += 0x100000000; }
    if (low < 0) { low += 0x100000000; }

    return (high * 0x100000000) + low;
  }

  public static writeUInt64(buffer: Uint8Array, startIndex: number, value: number): void {
    // Same problem as readUInt64 above
    let high = Math.floor(value / 0x100000000);
    let low = value % 0x100000000;

    // To signed
    if (high > 0x7fffffff) { high -= 0x100000000; }
    if (low > 0x7fffffff) { low -= 0x100000000; }

    this.writeInt32(buffer, startIndex, high);
    this.writeInt32(buffer, startIndex + 4, low);
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
    // Read unsigned, then convert to signed
    let value = this.readUInt16(buffer, startIndex);
    if (value > 0x7fff) { value -= 0x10000; }
    return value;
  }

  public static writeInt16(buffer: Uint8Array, startIndex: number, value: number): void {
    // Convert to unsigned, then write
    if (value < 0) { value += 0x10000; }
    this.writeUInt16(buffer, startIndex, value);
  }
}
