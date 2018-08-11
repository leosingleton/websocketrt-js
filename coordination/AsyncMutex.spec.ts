import { AsyncManualResetEvent } from './AsyncManualResetEvent';
import { AsyncMutex } from './AsyncMutex';
import { AsyncTimerEvent } from './AsyncTimerEvent';

describe("AsyncMutex", () => {

  it("Performs mutual exclusion", async () => {
    let sharedValue = 0;
    let mutex = new AsyncMutex();
    let hundredEvent = new AsyncManualResetEvent();

    // Create 10 "threads" that increment a value 10 times each
    for (let n = 0; n < 10; n++) {
      setTimeout(async () => {
        await mutex.lock();

        let privateValue = sharedValue;
        for (let m = 0; m < 10; m++) {
          // If the mutex works, no other "thread" will increment sharedValue
          sharedValue++;
          privateValue++;
          expect(sharedValue).toEqual(privateValue);

          if (sharedValue === 100) {
            hundredEvent.set(); // The test case is complete
          }

          // Yield the CPU to give other "threads" a chance to run
          await AsyncTimerEvent.delay(0);
        }

        mutex.unlock();
      });
    }

    await hundredEvent.waitAsync();
    expect(sharedValue).toEqual(100);
  });

});
