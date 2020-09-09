// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

using Xunit;

namespace LeoSingleton.WebSocketRT.UnitTests
{
    public class TransportCapabilitiesTest
    {
        /// <summary>
        /// Tests the <see cref="TransportCapabilities.Negotiate(TransportCapabilities, TransportCapabilities)"/>
        /// function
        /// </summary>
        [Fact]
        public void Negotiate()
        {
            var caps1 = new TransportCapabilities()
            {
                MajorVersion = 2,
                MinorVersion = 5,
                Capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.Capabilities2
            };

            var caps2 = new TransportCapabilities()
            {
                MajorVersion = 3,
                MinorVersion = 0,
                Capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.CancelMessage
            };

            var caps3 = TransportCapabilities.Negotiate(caps1, caps2);
            Assert.Equal(2, caps3.MajorVersion);
            Assert.Equal(5, caps3.MinorVersion);
            Assert.Equal(TransportCapabilities1.Capabilities, caps3.Capabilities1);
        }

        /// <summary>
        /// Tests the <see cref="TransportCapabilities.CapabilitiesToStringArray{T}(T)"/> function
        /// </summary>
        [Fact]
        public void CapabilitiesToStringArray()
        {
            // Create a bitmask with two bits set
            TransportCapabilities1 caps = TransportCapabilities1.CancelMessage | TransportCapabilities1.Capabilities2;

            // Convert to an array of strings
            var array = TransportCapabilities.CapabilitiesToStringArray(caps);

            Assert.Equal(2, array.Length);
            Assert.Equal("CancelMessage", array[0]);
            Assert.Equal("Capabilities2", array[1]);
        }
    }
}
