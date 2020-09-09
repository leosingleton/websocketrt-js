// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using Xunit;

namespace LeoSingleton.WebSocketRT.UnitTests
{
    public class ControlFrameTest
    {
        /// <summary>
        /// Ensures a control frame respresenting capabilities (OpCode=0x00) can be serialized and deserialized
        /// </summary>
        [Fact]
        public void SerializeDeserializeCapabilities()
        {
            var frame1 = new ControlFrame()
            {
                OpCode = 0x00,
                RttEstimate = 42,
                ThroughputEstimate = 12345678,
                Capabilities = new TransportCapabilities()
                {
                    MajorVersion = 3,
                    MinorVersion = 5,
                    Capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.Capabilities2
                }
            };
            var bytes = frame1.Write();

            var frame2 = new ControlFrame(bytes);
            Assert.Equal(frame1.OpCode, frame2.OpCode);
            Assert.Equal(frame1.RttEstimate, frame2.RttEstimate);
            Assert.Equal(frame1.ThroughputEstimate, frame2.ThroughputEstimate);
            Assert.Equal(frame1.Capabilities.MajorVersion, frame2.Capabilities.MajorVersion);
            Assert.Equal(frame1.Capabilities.MinorVersion, frame2.Capabilities.MinorVersion);
            Assert.Equal(frame1.Capabilities.Capabilities1, frame2.Capabilities.Capabilities1);
            Assert.Equal(frame1.DataFrames, frame2.DataFrames);
            Assert.Equal(frame1.CancellationDetails, frame2.CancellationDetails);
        }

        /// <summary>
        /// Ensures a control frame respresenting a ping can be serialized and deserialized
        /// </summary>
        [Fact]
        public void SerializeDeserializePing()
        {
            var frame1 = new ControlFrame()
            {
                OpCode = 0x10,
                RttEstimate = 42,
                ThroughputEstimate = 12345678
            };
            var bytes = frame1.Write();

            var frame2 = new ControlFrame(bytes);
            Assert.Equal(frame1.OpCode, frame2.OpCode);
            Assert.Equal(frame1.RttEstimate, frame2.RttEstimate);
            Assert.Equal(frame1.ThroughputEstimate, frame2.ThroughputEstimate);
            Assert.Equal(frame1.Capabilities, frame2.Capabilities);
            Assert.Equal(frame1.DataFrames, frame2.DataFrames);
            Assert.Equal(frame1.CancellationDetails, frame2.CancellationDetails);
        }

        /// <summary>
        /// Ensures a control frame preceding data frames can be serialized
        /// </summary>
        [Fact]
        public void SerializeDeserializeDataFrames()
        {
            var frame1 = new ControlFrame()
            {
                OpCode = 0x02,
                RttEstimate = 4096,
                ThroughputEstimate = 123456789,
                DataFrames = new DataFrameControl[]
                {
                    new DataFrameControl()
                    {
                        MessageNumber = 4,
                        Offset = 0,
                        Length = 15000,
                        IsFirst = true,
                        IsLast = false,
                        Header = new byte[] { 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07 }
                    },
                    new DataFrameControl()
                    {
                        MessageNumber = 15,
                        Offset = 19000000,
                        Length = 20000000,
                        IsFirst = false,
                        IsLast = true
                    }
                }
            };
            var bytes = frame1.Write();

            var frame2 = new ControlFrame(bytes);
            Assert.Equal(frame1.OpCode, frame2.OpCode);
            Assert.Equal(frame1.RttEstimate, frame2.RttEstimate);
            Assert.Equal(frame1.ThroughputEstimate, frame2.ThroughputEstimate);
            Assert.Equal(frame1.Capabilities, frame2.Capabilities);
            Assert.Equal(frame1.DataFrames.Length, frame2.DataFrames.Length);
            Assert.Equal(frame1.DataFrames[0].MessageNumber, frame2.DataFrames[0].MessageNumber);
            Assert.Equal(frame1.DataFrames[0].Offset, frame2.DataFrames[0].Offset);
            Assert.Equal(frame1.DataFrames[0].Length, frame2.DataFrames[0].Length);
            Assert.Equal(frame1.DataFrames[0].IsFirst, frame2.DataFrames[0].IsFirst);
            Assert.Equal(frame1.DataFrames[0].IsLast, frame2.DataFrames[0].IsLast);
            Assert.Equal(frame1.DataFrames[0].Header, frame2.DataFrames[0].Header);
            Assert.Equal(frame1.DataFrames[1].MessageNumber, frame2.DataFrames[1].MessageNumber);
            Assert.Equal(frame1.DataFrames[1].Offset, frame2.DataFrames[1].Offset);
            Assert.Equal(frame1.DataFrames[1].Length, frame2.DataFrames[1].Length);
            Assert.Equal(frame1.DataFrames[1].IsFirst, frame2.DataFrames[1].IsFirst);
            Assert.Equal(frame1.DataFrames[1].IsLast, frame2.DataFrames[1].IsLast);
            Assert.Equal(frame1.DataFrames[1].Header, frame2.DataFrames[1].Header);
            Assert.Equal(frame1.CancellationDetails, frame2.CancellationDetails);
        }

        /// <summary>
        /// Ensures a control frame respresenting a cancel (OpCode=0x12) can be serialized and deserialized
        /// </summary>
        [Fact]
        public void SerializeDeserializeCancel()
        {
            var frame1 = new ControlFrame()
            {
                OpCode = 0x12,
                RttEstimate = 42,
                ThroughputEstimate = 12345678,
                CancellationDetails = new MessageCancelControl()
                {
                    MessageNumbers = 42
                }
            };
            var bytes = frame1.Write();

            var frame2 = new ControlFrame(bytes);
            Assert.Equal(frame1.OpCode, frame2.OpCode);
            Assert.Equal(frame1.RttEstimate, frame2.RttEstimate);
            Assert.Equal(frame1.ThroughputEstimate, frame2.ThroughputEstimate);
            Assert.Equal(frame1.Capabilities, frame2.Capabilities);
            Assert.Equal(frame1.DataFrames, frame2.DataFrames);
            Assert.Equal(frame1.CancellationDetails.MessageNumbers, frame2.CancellationDetails.MessageNumbers);
        }
    }
}
