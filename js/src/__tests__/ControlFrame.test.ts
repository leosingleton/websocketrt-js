// WebSocketRT: Real-time websocket library
// Copyright (c) Leo C. Singleton IV <leo@leosingleton.com>
// See LICENSE in the project root for license information.

import { ControlFrame, DataFrameControl, MessageCancelControl } from '../ControlFrame';
import { TransportCapabilities, TransportCapabilities1 } from '../TransportCapabilities';

describe('ControlFrame', () => {

  it('Ensures a control frame respresenting capabilities (OpCode=0x00) can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x00;
    frame1.rttEstimate = 42;
    frame1.throughputEstimate = 12345678;
    frame1.frameData = new TransportCapabilities();
    frame1.frameData.majorVersion = 3;
    frame1.frameData.minorVersion = 5;
    frame1.frameData.capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.Capabilities2;
    const bytes = frame1.writeFrame();

    const frame2 = new ControlFrame();
    frame2.readFrame(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    const data1 = frame1.frameData;
    const data2 = frame2.frameData as TransportCapabilities;
    expect(data1.majorVersion).toEqual(data2.majorVersion);
    expect(data1.minorVersion).toEqual(data2.minorVersion);
    expect(data1.capabilities1).toEqual(data2.capabilities1);
  });

  it('Ensures a control frame respresenting a ping can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x10;
    frame1.rttEstimate = 42;
    frame1.throughputEstimate = 12345678;
    const bytes = frame1.writeFrame();

    const frame2 = new ControlFrame();
    frame2.readFrame(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.frameData).toEqual(frame2.frameData);
  });

  it('Ensures a control frame preceding data frames can be serialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x02;
    frame1.rttEstimate = 4096;
    frame1.throughputEstimate = 123456789;
    frame1.frameData = [new DataFrameControl(), new DataFrameControl()];
    frame1.frameData[0].messageNumber = 4;
    frame1.frameData[0].dataOffset = 0;
    frame1.frameData[0].messageLength = 15000;
    frame1.frameData[0].isFirst = true;
    frame1.frameData[0].isLast = false;
    frame1.frameData[0].header = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    frame1.frameData[1].messageNumber = 15;
    frame1.frameData[1].dataOffset = 19000000;
    frame1.frameData[1].messageLength = 20000000;
    frame1.frameData[1].isFirst = false;
    frame1.frameData[1].isLast = true;
    const bytes = frame1.writeFrame();

    const frame2 = new ControlFrame();
    frame2.readFrame(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.frameData).toEqual(frame2.frameData as DataFrameControl[]);
  });

  it('Ensures a control frame respresenting a cancel (OpCode=0x12) can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x12;
    frame1.rttEstimate = 4096;
    frame1.throughputEstimate = 123456789;
    frame1.frameData = new MessageCancelControl();
    frame1.frameData.messageNumbers = 42;
    const bytes = frame1.writeFrame();

    const frame2 = new ControlFrame();
    frame2.readFrame(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.frameData).toEqual(frame2.frameData as MessageCancelControl);
  });

});
