import { Queue } from './Queue';
import { TransportConfig } from './TransportConfig';

/**
 * Estimates the throughput and round-trip time (RTT) of the outgoing network connection
 */
export class BandwidthEstimator {
  public constructor(config: TransportConfig) {
    this._config = config;

    this._expectedAcks = [];

    // Initialize the estimates to 100 ms RTT with 128kbps of throughput
    this._dataInFlight = 0;
    this._rttEstimate = new MovingAverage(100, config.bandwidthEstimatorSamples);
    this._throughputEstimate = new MovingAverage(128 * 1024, config.bandwidthEstimatorSamples);
  }

  /**
   * Tells the bandwidth estimator to expect an ACK to arrive for a data frame being sent
   * @param frameLength The length of the frame we should expect an ACK for. Knowing the frame length is essential for
   *    bandwidth estimation.
   */
  public expectAck(frameLength: number): void {
    // If there is currently no data in flight, reset the last ACK time, so we don't include the time the
    // WebSocket was idle in our bandwidth estimation.
    if (this._dataInFlight === 0) {
      this._idleAck = true;
      this._lastAck = Date.now().valueOf();
    }

    this._expectedAcks.push(frameLength);

    // Update the total data in flight
    this._dataInFlight += frameLength;
  }

  /**
   * Records ACKs received and updates the throughput and RTT estimations
   * @param ackCount Number of ACKs received
   */
  public recordAcks(ackCount: number): void {
    // Calculate the total bytes of the frames being acknowledged
    let totalBytes = 0;
    for (let n = 0; n < ackCount; n++) {
      let length = this._expectedAcks.shift();
      totalBytes += length;
    }

    // Calculate the elapsed time
    let now = Date.now().valueOf();
    let last = this._lastAck; this._lastAck = now;
    let elapsed = now - last;

    // If this was the first ACK after the WebSocket was idle and the total data being acknowledged was less
    // than one TCP packet, use the elapsed time to estimate RTT
    if (this._idleAck && totalBytes < this._config.singlePacketMtu) {
      this._rttEstimate.record(elapsed);
    }

    // If this ACK is for a frame that immediately followed another, and the total data is more than one TCP
    // packet, use the elapsed time to estimate throughput. Ignore elapsed times less than one millisecond to
    // avoid divide-by-zero.
    if (!this._idleAck && totalBytes > this._config.singlePacketMtu && elapsed > 0) {
      this._throughputEstimate.record(totalBytes * 1000 / elapsed);
    }

    // Update the total data in flight
    this._idleAck = false;
    this._dataInFlight -= totalBytes;
  }

  /**
   * Records an inbound RTT estimate from the other side of the transport layer. RTT is always the same for both
   * inbound and outbound connections (hence "round trip" time), so we add it to our moving average.
   * @param rttEstimate RTT estimate from the other side, in milliseconds
   */
  public recordInboundRtt(rttEstimate: number): void {
    this._rttEstimate.record(rttEstimate);
  }

  private _config: TransportConfig;

  private _expectedAcks: number[];
  private _idleAck: boolean;
  private _lastAck: number;

  /**
   * Number of bytes of data that have been sent but unacknowledged
   */
  public getDataInFlight(): number {
    return this._dataInFlight;
  }
  private _dataInFlight: number;

  /**
   * Estimated round-trip time, in milliseconds
   */
  public getRttEstimate(): number {
    return this._rttEstimate.getValue();
  }
  private _rttEstimate: MovingAverage;

  /**
   * Estimated throughput, in bytes per second
   */
  public getThroughputEstimate(): number {
    return this._throughputEstimate.getValue();
  }
  private _throughputEstimate: MovingAverage;
}

/**
 * Calculates a moving average of a set of numbers
 */
class MovingAverage {
  public constructor(initialValue: number, maxValues: number) {
    this._maxValues = maxValues;
    this._values = new Queue<number>();
    this._sum = 0;
    this.record(initialValue);
  }

  public record(value: number): void {
    this._values.enqueue(value);
    this._sum += value;

    if (this._values.getCount() > this._maxValues) {
      let oldValue = this._values.dequeue();
      this._sum -= oldValue;
    }

    this._average = Math.floor(this._sum / this._values.getCount());
  }

  public getValue(): number {
    return this._average;
  }

  private _maxValues: number;
  private _values: Queue<number>;
  private _sum: number;
  private _average: number;
}
