using System;
using System.Diagnostics;
using LeoSingleton.CommonLibs;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Frames sent over the WebSocket are either data frames containing payload or control frames, which are used for
    /// the transport layers on each side to communicate control information. This class serializes and deserializes
    /// control frames.
    /// </summary>
    internal class ControlFrame
    {
        /// <summary>
        /// Operation Code:
        /// <list type="bullet">
        /// <item>0x00 = Capabilities Negotiation</item>
        /// <item>0x01 - 0x0f = Send Data Frames (value = # of data frames)</item>
        /// <item>0x10 = Ping</item>
        /// <item>0x11 = Pong</item>
        /// <item>0x12 = Cancel Messages</item>
        /// </list>
        /// </summary>
        public byte OpCode;

        /// <summary>
        /// Current estimated RTT, in milliseconds
        /// </summary>
        public ushort RttEstimate;

        /// <summary>
        /// Current estimated throughput, in bytes/sec. Measured in the direction from the computer receiving the
        /// control frame to the computer sending the control frame.
        /// </summary>
        public int ThroughputEstimate;

        /// <summary>
        /// If OpCode is 0x00, the remainder of the control frame contains the capabilities of the transport library
        /// </summary>
        public TransportCapabilities Capabilities;

        /// <summary>
        /// If OpCode is 0x01-0x0f, additional control information about the data frames is here. The payloads for
        /// these will be sent as separate frames immediately following the control frame.
        /// </summary>
        public DataFrameControl[] DataFrames;

        /// <summary>
        /// If OpCode is 0x12, the remainder of the control frame contains details about which message numbers to
        /// cancel
        /// </summary>
        public MessageCancelControl CancellationDetails;

        public ControlFrame()
        {
        }

        public ControlFrame(ArraySegment<byte> frame)
        {
            OpCode = frame.Array[frame.Offset];
            RttEstimate = BinaryConverter.ReadUInt16(frame.Array, frame.Offset + 2);
            ThroughputEstimate = BinaryConverter.ReadInt32(frame.Array, frame.Offset + 4);

            int offset = 8;
            if (OpCode == 0x00)
            {
                Capabilities = new TransportCapabilities();
                offset += Capabilities.Read(frame.Array, frame.Offset + offset);
            }
            else if (OpCode >= 0x01 && OpCode <= 0x0f)
            {
                DataFrames = new DataFrameControl[OpCode];
                for (int n = 0; n < OpCode; n++)
                {
                    DataFrames[n] = new DataFrameControl();
                    offset += DataFrames[n].Read(frame.Array, frame.Offset + offset);
                }
            }
            else if (OpCode == 0x12)
            {
                CancellationDetails = new MessageCancelControl();
                offset += CancellationDetails.Read(frame.Array, frame.Offset + offset);
            }
            Debug.Assert(offset == frame.Count);
        }

        public ArraySegment<byte> Write()
        {
            int dataFrameCount = (DataFrames != null) ? DataFrames.Length : 0;

            var frame = new byte[MaxLength];
            frame[0] = OpCode;
            BinaryConverter.Write(frame, 2, RttEstimate);
            BinaryConverter.Write(frame, 4, ThroughputEstimate);

            int offset = 8;
            if (OpCode == 0x00)
            {
                offset += Capabilities.Write(frame, offset);
            }
            else if (OpCode >= 0x01 && OpCode <= 0x0f)
            {
                for (int n = 0; n < dataFrameCount; n++)
                {
                    offset += DataFrames[n].Write(frame, offset);
                }
            }
            else if (OpCode == 0x12)
            {
                offset += CancellationDetails.Write(frame, offset);
            }

            return new ArraySegment<byte>(frame, 0, offset);
        }

        /// <summary>
        /// Maximum size of a control frame, in bytes
        /// </summary>
        public const int MaxLength = 8 + (15 * 72);
    }

    /// <summary>
    /// Additional details in the control frame about data frames, used with OpCodes 0x01-0x0f
    /// </summary>
    internal class DataFrameControl
    {
        /// <summary>
        /// Offset of the data within the message (max 64 MB)
        /// </summary>
        public int Offset;

        /// <summary>
        /// Length of the total message (max 64 MB)
        /// </summary>
        public int Length;

        /// <summary>
        /// Identifies which of the messages in flight (0-15) this data payload is for
        /// </summary>
        public byte MessageNumber;

        /// <summary>
        /// If true, this is the first data frame for the message. Any partial data previously received for this
        /// message number should be discarded.
        /// </summary>
        public bool IsFirst;

        /// <summary>
        /// If true, this is the last data frame for the message. The complete message can now be delivered to the
        /// upper protocol layers.
        /// </summary>
        public bool IsLast;

        /// <summary>
        /// Each data frame can include a header (max 64 bytes) in the control frame
        /// </summary>
        public byte[] Header;

        /// <summary>
        /// Payload of the message.
        /// <para>
        /// Warning: This field is not serialized to the control frame. It is only used internally by the SendLoop to
        /// track the data to send.
        /// </para>
        /// </summary>
        public byte[] Payload;

        /// <summary>
        /// Length of the outgoing frame.
        /// <para>
        /// Warning: This field is not serialized to the control frame. It is only used internally by the SendLoop to
        /// track the data to send.
        /// </para>
        /// </summary>
        public int FrameLength;

        public DataFrameControl()
        {
        }

        public int Read(byte[] frame, int startIndex)
        {
            // MessageNumber lives in the upper 4 bits of Offset. IsFirst lives in the 5th-higest bit if Length.
            // IsLast lives in the 6th-highest.
            Offset = BinaryConverter.ReadInt32(frame, startIndex);
            MessageNumber = (byte)((Offset & 0xf0000000) >> 28);
            IsFirst = (Offset & 0x08000000) != 0;
            IsLast = (Offset & 0x04000000) != 0;
            Offset &= 0x03ffffff;

            // The header length lives in the upper 6 bits of Length
            Length = BinaryConverter.ReadInt32(frame, startIndex + 4);
            int headerLength = (int)((Length & 0xfc000000) >> 26);
            Length &= 0x03ffffff;

            // Copy the header
            if (headerLength > 0)
            {
                Header = new byte[headerLength];
                Buffer.BlockCopy(frame, startIndex + 8, Header, 0, headerLength);
            }

            return headerLength + 8;
        }

        public int Write(byte[] frame, int startIndex)
        {
            // MessageNumber lives in the upper 4 bits of Offset. IsFirst lives in the 5th-higest bit if Length.
            // IsLast lives in the 6th-highest.
            int offset = Offset & 0x03ffffff;
            offset |= (MessageNumber & 0xf) << 28;
            offset |= (IsFirst ? 1 : 0) << 27;
            offset |= (IsLast ? 1 : 0) << 26;
            BinaryConverter.Write(frame, startIndex, offset);

            int headerLength = (Header != null) ? Header.Length : 0;

            // The header length lives in the upper 6 bits of Length
            int length = Length & 0x03ffffff;
            if (headerLength > 0)
            {
                length |= (headerLength & 0x3f) << 26;
                Buffer.BlockCopy(Header, 0, frame, startIndex + 8, headerLength);
            }
            BinaryConverter.Write(frame, startIndex + 4, length);

            return headerLength + 8;
        }
    }

    /// <summary>
    /// Additional details on the cancel OpCode (0x12)
    /// </summary>
    internal class MessageCancelControl
    {
        /// <summary>
        /// Bitmask of message numbers to cancel
        /// </summary>
        public ushort MessageNumbers;

        public int Read(byte[] frame, int startIndex)
        {
            MessageNumbers = BinaryConverter.ReadUInt16(frame, startIndex);
            return 2;
        }

        public int Write(byte[] frame, int startIndex)
        {
            BinaryConverter.Write(frame, startIndex, MessageNumbers);
            return 2;
        }
    }
}
