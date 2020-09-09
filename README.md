# WebSocketRT: Real-time WebSocket library

The WebSocketRT library was built as part of the WhiteboardCam app, as a way to send JPEG images between Xamarin-
based mobile apps, .NET-based web services, and HTML5 clients over websockets.

Sending large (1-5 MB) frames in real-time exposed numerous problems with using websockets directly. The WebSocketRT
transport layer sits on top of the native websockets to address:

#### Buffer Bloat

Multiple layers in the transport stack buffer data to maximize throughput. The WebSocket libraries in browsers and
.NET, TCP stacks, and networking hardware all accept outgoing data to send and may hold many megabytes of data in
buffers before throttling the sender. Although this is good for throughput, it is bad for latency, as the data in
buffers could take tens of seconds to actually send.

For a realtime protocol like WhiteboardCam, we never want more than one full frame buffered at any time. It is better
to drop frames at this point to improve responsiveness. To solve this problem, WebSocketRT performs bandwidth
estimation of both directions of all websockets, and breaks outgoing payload data into websocket frames that require no
more than 100ms to send.

#### Priority

A full-resolution JPEG can be up to 5 MB of data, which ties up the websocket for seconds. WebSocketRT supports a
priority system which allows higher-priority messages to preempt lower-priority at each 100 ms interval.

#### Faster Forwarding

Breaking large multi-megabyte frames into smaller, 100ms chunks has a third benefit: the cloud server can forward each
chunk of data to viewers as it is received, as opposed to waiting for an entire multi-megabyte frame. This effectively
halves the latency of large frames compared to sending a large, single websocket frame.

#### Timeouts

The transport layer implements its own ping mechanism to not rely on websockets built-in timeouts. These can be
unpredictable, and result in minutes to detect and initiate auto-reconnect on a dropped connection. Instead, the
transport layer sends and acknowledges its own ping messages to create accurate, configurable timeouts.


## Portability

The transport layer is implemented in C# for server and mobile devices and TypeScript for HTML5 support.
TypeScript consists of a line-for-line port of the C# code. To maximize code similarity, the
[commonlibs](https://github.com/leosingleton/commonlibs) NPM and NuGet packages implement numerous helper classes
in both C# and Typescript to provide similar event and async functionality.

#### Debugging

In general, the C# implementation is easier to debug and finds issues sooner. One limitation is that TypeScript does
not have asserts. So generally code is first developed against the C# implementation, then later ported to TypeScript.


## Limits

Due to field sizes in the transport headers, the following maximums are imposed:

- Maximum messages in flight: 16
- Maximum message size: 64 MB

There is also a maximum limit of 16 priority levels. However, this limit can be increased or decreased in the
TransportConfig class, as the priority value is only used within the sending transport layer and never actually sent
over the wire.

## Control frames

The transport layer leverages websockets to provide framing. Each websocket frame may either consist of payload data or
a control frame which is handled completely within the transport layer. A websocket frame should be assumed to be a
control frame unless it follows a Send Data control frame.

Each control frame begins with the same 8 bytes:
```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+---------------+---------------+-------------------------------+
|    Opcode     |    Unused     |         RTT Estimate          |
+---------------+---------------+-------------------------------+
|                       Throughput Estimate                     |
+---------------------------------------------------------------+
```

The opcode may be one of the following values:

- 0x00 = Capabilities Negotiation
- 0x01 - 0x0f = Send Data Frames (value = # of data frames)
- 0x10 = Ping
- 0x11 = Pong
- 0x12 = Cancel Messages

Values 0x13 through 0xff are unused and reserved for future use.

The Round-Trip Time (RTT) estimate is a 16-bit integer which sends the estimated RTT in milliseconds. The throughput
estimate is 32 bits and in bytes per second.

The remainder of the control frame depends on the opcode.

#### Capabilities Negotiation

Following the first 8 bytes, the capabilities control frame consists of 32-bit bitmasks. 31 of the bits correspond to
capability flags. If the highest bit is set, it indicates that another 32 bits of capability flags follow.

Capability negotiation was added in September 2018. The server is now guaranteed to support it, but older
clients that have not been updated may still not. Capability negotiation itself is a capability bit. Newer clients now
send a Capabilities Negotiation control frame as their first message following connection and the server responds with
a Capabilities Negotiation control frame. Capabilities are only enabled if both sides support them. If the client does
not send a Capabilities Negotiation control frame, the server assumes the client does not support it, nor any of the
other capability flags.

#### Send Data Frames

A Send Data control frame precedes one or more payload frames and provides metadata around the data that will follow.
The number of data frames to expect is captured in the opcode, with a maximum of 16 payload frames per Send Data
control frame.

For each payload frame, the control frame contains between 8 and 72 additional bytes of metadata:

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-------+-+-+---------------------------------------------------+
|  Msg  |I|I|                      Offset                       | 
|  Num  |F|L|                                                   | 
+-------+-+-+---------------------------------------------------+
| Optional  |                                                   |
|  Header   |                  Message Length                   |
|  Length   |                                                   |
+-----------+---------------------------------------------------+
|               Optional Header (0 to 64 bytes)                 |
+---------------------------------------------------------------+
```

Message Number is 4-bit integer allowing for up to 16 concurrent messages to be in-flight at any time. It allows the
transport layer on the other end to reassemble the payload frames into complete messages.

The IsFirst (IF) bit is set for the first payload frame for any given message. Likewise, IsLast (IL) is set for the
last payload frame for the message and marks message completion. IF and IL may both be set if the entire message is
delivered in a single payload frame.

The Message Length indicates the total length of the message and is sent to help the receiver allocate a buffer of the
proper size. The payload frame itself may contain only a subset of the message data, and the Offset field indicates
where within the overall message buffer the payload frame should be copied.

Technically, the offset field is redundant and can be ignored. When a message is broken into multiple payload frames,
the payload frames must be sent in order, starting at offset zero, as the receiver may make this assumption. And the
length of each payload frame is sent by the websocket framing, so the next offset can be assumed to be the previous
offset plus the payload frame length.

Each message may also include an optional message-specific header of up to 64 bytes. This makes it easier for the
higher-level WhiteboardCam protocol to send header information with each image, without having to reimplement another
message framing mechanism. The optional header should only be used on the first payload frame for a message, when the
IF bit is set. The optional header is ignored on subsequent payload frames for the same message.

#### Ping and Pong

Ping and Pong messages are used by the transport layer to detect dropped connections and to estimate RTT time. Pings
are sent every 15 seconds, but may be sent at a faster rate if needed to improve the RTT estimate.

#### Cancel Messages

Incomplete messages may be cancelled before they are fully sent. This releases the message number to be reused by
anoher message and allows the receiver to release any memory used for receiving the incomplete message.

A Cancel Messages control frame contains an additional 2 bytes after the first 8. These 16 bits are a bitmask
indicating which of the 16 message numbers are being cancelled.

In practice, message cancellation is rarely used. The only use case is to allow servers to forward messages before
fully receiving the message payload. If the sending client drops its websocket and reconnects, the server may simply
cancel all in-flight messages rather than disconnecting and reconnecting all of the clients to which messages are being
forwarded.

Message cancellation was added in September 2018 and is enabled via a capability bit.


## Threading

The transport layer uses three threads:

- Send - Wakes up every 100 ms to take data from the send queue and send it via the websocket.
- Receive - Receives data from the websocket. Control frames are processed on this thread. Data frames enqueue events
  on the dispatch queue to deliver them to the higher-level protocol.
- Dispatch - Removes events from the dispatch queue and delivers them to the higher-level protocol. For simplicity,
  events are delivered synchronously, so it is up to the higher-level code to handle them quickly and avoid blocking.


## Events

Consumers of the transport library can register for four different event types, defined in the `MessageCallbackEvents`
enum:

- `NewMessage` - Event sent on the first payload frame for a message. Only the message-specific header is guaranteed to
  be fully received when this event is fired. The consumer must pay close attention to the BytesReceived field of the
  message, as the message is likely only partially-received when this event is fired.
- `Payload` - Event fired every time an additional payload frame is received.
- `Complete` - Event fired when the entire message is received.
- `Cancel` - Event fired when a message in-flight is cancelled.

Event registration can either occur on the Connection object or on an individual Message object. If registering for
events on the Connection object, events will be raised for all messages on that connection. It is only possible to
register for NewMessage events on the Connection object.

`MessageCallbackEvents` is a bitmask. `Payload` events may be combined with `NewMessage` and/or `Complete` events for
the first and last payload frames.


## Throughput and RTT Estimation

Throughput and RTT are estimated by each side of the transport layer using moving averages. Then, the two sides share
their estimates using 6 bytes of every control frame.

The transport layer estimates RTT using Ping and Pong control frames. On each Ping, a timer is started, and the time
until a Pong is received is recorded for the moving average. Pongs are prioritized above all other control frames to
make the RTT estimate as accurate as possible, although currently, RTT tends to be pretty inaccurate due to delays in
sending Pongs, particularly in the JavaScript implementation, as JavaScript doesn't actually have threads and must
simulate them using `setTimeout(0)` events.

Since RTT is measured separately by each side of the transport layer, the two estimates are combined by taking the
minimum value of the two. By definition, "round-trip" is the same in both directions, so the higher estimate
is assumed to be in error due to measurement latencies.

Throughput is estimated by the receiving side. When a Send Data control frame is received, the control frame indicates
how many (1 to 16) data frames follow. The total data in the data frames is counted by the receiver and the time from
the control frame to the final data frame is measured with a timer. With simple division, this value is fed into the
moving average for throughput.

The transport layer doesn't actually use its own throughput estimate--it simply forwards it to the other transport
layer. Each transport layer uses the other's estimate to break outgoing messages into 100 ms payload frames and the
continuous mesaurement of throughput establishes a feedback loop.


## License
Copyright (c) 2016-2020 [Leo C. Singleton IV](https://www.leosingleton.com/).
This software is licensed under the MIT License.
