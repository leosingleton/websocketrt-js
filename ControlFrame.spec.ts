import { ControlFrame, DataFrameControl } from "./ControlFrame";

describe("ControlFrame", () => {

  it("Ensures a control frame respresenting an ACK can be serialized and deserialized", () => {
    let frame1 = new ControlFrame();
    frame1.opCode = 0;
    frame1.ackCount = 5;
    frame1.rttEstimate = 42;
    frame1.throughputEstimate = 12345678;
    let bytes = frame1.write();

    let frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.ackCount).toEqual(frame2.ackCount);
    expect(frame1.dataFrames).toEqual(frame2.dataFrames);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
  });

  it("Ensures a control frame preceding data frames can be serialized", () => {
    let frame1 = new ControlFrame();
    frame1.opCode = 2;
    frame1.ackCount = 0;
    frame1.rttEstimate = 4096;
    frame1.throughputEstimate = 123456789;
    frame1.dataFrames = [new DataFrameControl(), new DataFrameControl()];
    frame1.dataFrames[0].messageNumber = 4;
    frame1.dataFrames[0].offset = 0;
    frame1.dataFrames[0].length = 15000;
    frame1.dataFrames[0].isFirst = true;
    frame1.dataFrames[0].isLast = false;
    frame1.dataFrames[0].header = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    frame1.dataFrames[1].messageNumber = 15;
    frame1.dataFrames[1].offset = 19000000;
    frame1.dataFrames[1].length = 20000000;
    frame1.dataFrames[1].isFirst = false;
    frame1.dataFrames[1].isLast = true;
    let bytes = frame1.write();

    let frame2 = new ControlFrame();
    frame2.read(bytes);
    expect(frame1.opCode).toEqual(frame2.opCode);
    expect(frame1.ackCount).toEqual(frame2.ackCount);
    expect(frame1.dataFrames).toEqual(frame2.dataFrames);
    expect(frame1.rttEstimate).toEqual(frame2.rttEstimate);
    expect(frame1.throughputEstimate).toEqual(frame2.throughputEstimate);
  });

});
