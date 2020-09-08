using System;
using System.Collections.Generic;
using WhiteboardServer.Common;

namespace WhiteboardServer.Transport
{
    /// <summary>
    /// Capabilities negotiated between both ends of the transport during the initial connection
    /// </summary>
    [Flags]
    public enum TransportCapabilities1
    {
        /// <summary>
        /// None
        /// </summary>
        None = 0,

        /// <summary>
        /// The ability to negotiate capabilities
        /// </summary>
        /// <remarks>Capabilities were first added in September 2018</remarks>
        Capabilities = 1,

        /// <summary>
        /// Support for the message cancellation control frame (OpCode=0x12)
        /// </summary>
        /// <remarks>Added September 2018</remarks>
        CancelMessage = 2,

        /// <summary>
        /// The highest bit is reserved for when we run out of capabilities bits and have to add a
        /// TransportCapabilities2 enum.
        /// </summary>
        Capabilities2 = int.MinValue,

        /// <summary>
        /// All
        /// </summary>
        All = Capabilities | CancelMessage
    }

    /// <summary>
    /// Object representing the version and capabilities of the transport library
    /// </summary>
    public class TransportCapabilities
    {
        /// <summary>
        /// Major version number
        /// </summary>
        public ushort MajorVersion { get; set; }

        /// <summary>
        /// Minor version number
        /// </summary>
        public ushort MinorVersion { get; set; }

        /// <summary>
        /// Feature capability bitmask. Use <see cref="CapabilitiesToStringArray{T}(T)"/> to convert to a
        /// JSON-serializable representation.
        /// </summary>
        public TransportCapabilities1 Capabilities1 { get; set; }

        /// <summary>
        /// Reads the capabilities from a control frame
        /// </summary>
        /// <param name="frame">Byte array holding a control frame</param>
        /// <param name="startIndex">Offset within the byte array to begin reading</param>
        /// <returns>Number of bytes read</returns>
        internal int Read(byte[] frame, int startIndex)
        {
            MajorVersion = BinaryConverter.ReadUInt16(frame, startIndex);
            MinorVersion = BinaryConverter.ReadUInt16(frame, startIndex + 2);
            Capabilities1 = (TransportCapabilities1)BinaryConverter.ReadInt32(frame, startIndex + 4);
            return 8;
        }

        /// <summary>
        /// Writes the capabilities to a control frame
        /// </summary>
        /// <param name="frame">Byte array holding a control frame</param>
        /// <param name="startIndex">Offset within the byte array to begin writing</param>
        /// <returns>Number of bytes written</returns>
        internal int Write(byte[] frame, int startIndex)
        {
            BinaryConverter.Write(frame, startIndex, MajorVersion);
            BinaryConverter.Write(frame, startIndex + 2, MinorVersion);
            BinaryConverter.Write(frame, startIndex + 4, (int)Capabilities1);
            return 8;
        }

        /// <summary>
        /// Returns an object representing a transport library with zero capabilites
        /// </summary>
        public static TransportCapabilities ZeroCapabilities
        {
            get
            {
                return new TransportCapabilities()
                {
                    MajorVersion = 0,
                    MinorVersion = 0,
                    Capabilities1 = TransportCapabilities1.None
                };
            }
        }

        /// <summary>
        /// Returns the capabilities of this version of the transport library
        /// </summary>
        public static TransportCapabilities LocalCapabilities
        {
            get
            {
                return new TransportCapabilities()
                {
                    MajorVersion = 1,
                    MinorVersion = 1,
                    Capabilities1 = TransportCapabilities1.All
                };
            }
        }

        /// <summary>
        /// Calculates the supported version and capabilities across two different versions of the transport library
        /// </summary>
        /// <param name="caps1">Capability object returned by one transport library</param>
        /// <param name="caps2">Capability object returned by the other transport library</param>
        /// <returns>Resulting capability object</returns>
        public static TransportCapabilities Negotiate(TransportCapabilities caps1, TransportCapabilities caps2)
        {
            var version = VersionComparer.Lower(
                new ushort[] { caps1.MajorVersion, caps1.MinorVersion },
                new ushort[] { caps2.MajorVersion, caps2.MinorVersion });

            return new TransportCapabilities()
            {
                Capabilities1 = caps1.Capabilities1 & caps2.Capabilities1,
                MajorVersion = version[0],
                MinorVersion = version[1]
            };
        }

        /// <summary>
        /// Converts a bitmask of capabilities to an array of strings. Used for external REST APIs.
        /// </summary>
        /// <typeparam name="T">Bitmask type, e.g. <see cref="TransportCapabilities1"/></typeparam>
        /// <param name="bitmask">Value of the bitmask</param>
        /// <returns>Array of strings containing the specific enum values that are set</returns>
        public static string[] CapabilitiesToStringArray<T>(T bitmask) where T : Enum
        {
            var result = new List<string>();

            foreach (T flag in Enum.GetValues(typeof(T)))
            {
                if (bitmask.HasFlag(flag))
                {
                    var flagString = flag.ToString();
                    if (flagString != "None" && flagString != "All")
                    {
                        result.Add(flagString);
                    }
                }
            }

            return result.ToArray();
        }
    }
}
