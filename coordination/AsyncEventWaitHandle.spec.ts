import { AsyncEventWaitHandle } from "./AsyncEventWaitHandle";
import { AsyncManualResetEvent } from "./AsyncManualResetEvent";
import { AsyncTimerEvent } from "./AsyncTimerEvent";
import { AsyncAutoResetEvent } from "./AsyncAutoResetEvent";

let _wokenCount = 0;

function createWaitTask(e: AsyncEventWaitHandle) {
  setTimeout(async () => {
    await e.waitAsync();
    _wokenCount++;
  });
}

describe("AsyncEventWaitHandle", () => {

  it("Ensures an AsyncManualResetEvent sets and resets", async () => {
    _wokenCount = 0;
    let e = new AsyncManualResetEvent(false);

    createWaitTask(e);
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(0);

    e.set();
    createWaitTask(e);
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(2);

    e.reset();
    createWaitTask(e);
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(2);
  });

  it("Ensures an AsyncAutoResetEvent sets and resets", async () => {
    _wokenCount = 0;
    let e = new AsyncAutoResetEvent(false);

    createWaitTask(e);
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(0);

    e.set();
    createWaitTask(e);
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(1);

    e.set();
    await AsyncTimerEvent.delay(10);
    expect(_wokenCount).toEqual(2);
  });
});
