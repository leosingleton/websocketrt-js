import { BinaryConverter, VersionComparer } from '@leosingleton/commonlibs';

/** Capabilities negotiated between both ends of the transport during the initial connection */
export const enum TransportCapabilities1 {
  /** None */
  None = 0,

  /**
   * The ability to negotiate capabilities
   * 
   * Capabilities were first added in September 2018
   */
  Capabilities = 1,

  /**
   * Support for the message cancellation control frame (OpCode=0x12)
   * 
   * Added September 2018
   */
  CancelMessage = 2,

  /**
   * The highest bit is reserved for when we run out of capabilities bits and have to add a
   * TransportCapabilities2 enum.
   */
  Capabilities2 = 2147483647,

  /** All */
  All = Capabilities | CancelMessage
}

/** Object representing the version and capabilities of the transport library */
export class TransportCapabilities {
  /** Major version number */
  public majorVersion: number;

  /** Minor version number */
  public minorVersion: number;

  /**
   * Feature capability bitmask. Use CapabilitiesToStringArray to convert to a
   * JSON-serializable representation.
   */
  public capabilities1: TransportCapabilities1;

  /**
   * Reads the capabilities from a control frame
   * @param frame Byte array holding a control frame
   * @param startIndex Offset within the byte array to begin reading
   * @returns Number of bytes read
   */
  public read(frame: Uint8Array, startIndex: number): number {
    this.majorVersion = BinaryConverter.readUInt16(frame, startIndex);
    this.minorVersion = BinaryConverter.readUInt16(frame, startIndex + 2);
    this.capabilities1 = BinaryConverter.readInt32(frame, startIndex + 4);
    return 8;
  }

  /**
   * Writes the capabilities to a control frame
   * @param frame Byte array holding a control frame
   * @param startIndex Offset within the byte array to begin writing
   * @returns Number of bytes written
   */
  public write(frame: Uint8Array, startIndex: number): number {
    BinaryConverter.writeUInt16(frame, startIndex, this.majorVersion);
    BinaryConverter.writeUInt16(frame, startIndex + 2, this.minorVersion);
    BinaryConverter.writeInt32(frame, startIndex + 4, this.capabilities1);
    return 8;
  }

  /** Returns an object representing a transport library with zero capabilites */
  public static getZeroCapabilities(): TransportCapabilities {
    let result = new TransportCapabilities();
    result.majorVersion = 0;
    result.minorVersion = 0;
    result.capabilities1 = TransportCapabilities1.None;
    return result;
  }

  /** Returns the capabilities of this version of the transport library */
  public static getLocalCapabilties(): TransportCapabilities {
    let result = new TransportCapabilities();
    result.majorVersion = 1;
    result.minorVersion = 1;
    result.capabilities1 = TransportCapabilities1.All;
    return result;
  }

  /**
   * Calculates the supported version and capabilities across two different versions of the transport library
   * @param caps1 Capability object returned by one transport library
   * @param caps2 Capability object returned by the other transport library
   * @returns Resulting capability object
   */
  public static negotiate(caps1: TransportCapabilities, caps2: TransportCapabilities): TransportCapabilities {
    let version = VersionComparer.lower(
      [caps1.majorVersion, caps1.minorVersion],
      [caps2.majorVersion, caps2.minorVersion]);

    let result = new TransportCapabilities();
    result.capabilities1 = caps1.capabilities1 & caps2.capabilities1;
    result.majorVersion = version[0];
    result.minorVersion = version[1];
    return result;
  }
}
