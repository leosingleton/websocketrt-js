namespace WhiteboardServer.Transport
{
    /// <summary>
    /// Configuration options for the transport layer
    /// </summary>
    public class TransportConfig
    {
        /// <summary>
        /// Number of priority levels we support (maximum 16). More levels gives the higher layer greater control over
        /// message prioritization, but with a slightly increased performance overhead.
        /// </summary>
        public int PriorityLevels = 16;

        /// <summary>
        /// Number of bytes in the largest frame that fits within a single TCP packet.
        /// </summary>
        public int SinglePacketMtu = 1398;

        /// <summary>
        /// The number of concurrent messages that can be in-flight (maximum 16) before <see cref="Connection.Send"/>
        /// blocks and begins throttling the sender.
        /// </summary>
        public int MaxConcurrentMessages = 16;

        /// <summary>
        /// The target responsiveness of the transport, in milliseconds. Lower values will allow for better preemption,
        /// so high priority messages have lower latency. Higher values have a lower performance overhead and better
        /// overall throughput.
        /// </summary>
        public int TargetResponsiveness = 100;

        /// <summary>
        /// Number of samples we use in the moving averages for bandwidth estimation. Lower numbers will make the
        /// transport ramp up quicker and be more responsive to changes in network performance, however higher values
        /// will give increased accurracy.
        /// </summary>
        public int BandwidthEstimatorSamples = 100;

        /// <summary>
        /// Interval between pings, in milliseconds.
        /// </summary>
        public int PingInterval = 15000;

        /// <summary>
        /// At startup, we temporarily increase the ping interval to help the RTT and throughput estimates converge.
        /// </summary>
        public int InitialPingInterval = 5000;

        /// <summary>
        /// Number of consecutive ping intervals that can be missed (because the remote side didn't respond with a
        /// pong), before the connection is closed.
        /// 
        /// Effectively, the connection has a timeout of PingInterval * MissedPingCount = 60 seconds.
        /// </summary>
        public int MissedPingCount = 4;

        /// <summary>
        /// To avoid hitting TCP congestion control which will cause our throughput to vary wildly, we cap outgoing
        /// data below the calculated maximum. This value controls the percent from 0 to 100.
        /// </summary>
        public int MaxPercentThroughput = 75;
    }
}
