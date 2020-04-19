import { ControlFrame, DataFrameControl, MessageCancelControl } from './ControlFrame';
import { TransportCapabilities, TransportCapabilities1 } from './TransportCapabilities';

describe('ControlFrame', () => {

  it('Ensures a control frame respresenting capabilities (OpCode=0x00) can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x00;
    frame1.rttEstimate = 42;
    frame1.throughputEstimate = 12345678;
    frame1.data = new TransportCapabilities();
    frame1.data.majorVersion = 3;
    frame1.data.minorVersion = 5;
    frame1.data.capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.Capabilities2;
    const bytes = frame1.write();

    const frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    const data1 = frame1.data;
    const data2 = frame2.data as TransportCapabilities;
    expect(data1.majorVersion).toEqual(data2.majorVersion);
    expect(data1.minorVersion).toEqual(data2.minorVersion);
    expect(data1.capabilities1).toEqual(data2.capabilities1);
  });

  it('Ensures a control frame respresenting a ping can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x10;
    frame1.rttEstimate = 42;
    frame1.throughputEstimate = 12345678;
    const bytes = frame1.write();

    const frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.data).toEqual(frame2.data);
  });

  it('Ensures a control frame preceding data frames can be serialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x02;
    frame1.rttEstimate = 4096;
    frame1.throughputEstimate = 123456789;
    frame1.data = [new DataFrameControl(), new DataFrameControl()];
    frame1.data[0].messageNumber = 4;
    frame1.data[0].offset = 0;
    frame1.data[0].length = 15000;
    frame1.data[0].isFirst = true;
    frame1.data[0].isLast = false;
    frame1.data[0].header = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    frame1.data[1].messageNumber = 15;
    frame1.data[1].offset = 19000000;
    frame1.data[1].length = 20000000;
    frame1.data[1].isFirst = false;
    frame1.data[1].isLast = true;
    const bytes = frame1.write();

    const frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.data).toEqual(frame2.data as DataFrameControl[]);
  });

  it('Ensures a control frame respresenting a cancel (OpCode=0x12) can be serialized and deserialized', () => {
    const frame1 = new ControlFrame();
    frame1.opCode = 0x12;
    frame1.rttEstimate = 4096;
    frame1.throughputEstimate = 123456789;
    frame1.data = new MessageCancelControl();
    frame1.data.messageNumbers = 42;
    const bytes = frame1.write();

    const frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
    expect(frame1.data).toEqual(frame2.data as MessageCancelControl);
  });

});
