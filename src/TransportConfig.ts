// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

/** Configuration options for WebSocketRT */
export class TransportConfig {
  /**
   * Number of priority levels we support (maximum 16). More levels gives the higher layer greater control over
   * message prioritization, but with a slightly increased performance overhead.
   */
  public priorityLevels = 16;

  /**
   * Number of bytes in the largest frame that fits within a single TCP packet.
   */
  public singlePacketMtu = 1398;

  /**
   * The number of concurrent messages that can be in-flight (maximum 16) before `Connection.SendMessageAsync`
   * blocks and begins throttling the sender.
   */
  public maxConcurrentMessages = 16;

  /**
   * The target responsiveness of the transport, in milliseconds. Lower values will allow for better preemption,
   * so high priority messages have lower latency. Higher values have a lower performance overhead and better
   * overall throughput.
   */
  public targetResponsiveness = 100;

  /**
   * Number of samples we use in the moving averages for bandwidth estimation. Lower numbers will make the
   * transport ramp up quicker and be more responsive to changes in network performance, however higher values
   * will give increased accurracy.
   */
  public bandwidthEstimatorSamples = 100;

  /** Interval between pings, in milliseconds. */
  public pingInterval = 15000;

  /** At startup, we temporarily increase the ping frequency to help the RTT and throughput estimates converge. */
  public initialPingInterval = 5000;

  /**
   * Number of consecutive ping intervals that can be missed (because the remote side didn't repond with a pong),
   * before the connection is closed.
   *
   * Effectively, the connection has a timeout of `pingInterval * missedPingCount` = 60 seconds.
   */
  public missedPingCount = 4;

  /**
   * To avoid hitting TCP congestion control which will cause our throughput to vary wildly, we cap outgoing
   * data below the calculated maximum. This value controls the percent from 0 to 100.
   */
  public maxPercentThroughput = 75;
}
