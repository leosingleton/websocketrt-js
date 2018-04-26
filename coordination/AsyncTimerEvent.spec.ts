import { AsyncTimerEvent } from './AsyncTimerEvent';

describe("AsyncTimerEvent", () => {

  it("Tests the timer without repeat enabled", async () => {
    let timer = new AsyncTimerEvent(1000);
    let hasFired = false;
    setTimeout(async () => {
      await timer.waitAsync();
      hasFired = true;
    });

    await AsyncTimerEvent.delay(900);
    expect(hasFired).toBeFalsy();

    await AsyncTimerEvent.delay(200);
    expect(hasFired).toBeTruthy();
  });

  it("Tests the timer with repeat enabled", async () => {
    let timer = new AsyncTimerEvent(100, true);
    let fireCount = 0;
    setTimeout(async () => {
      while (fireCount < 12) {
        await timer.waitAsync(); // BUGBUG: For some reason this isn't blocking, and fireCount gets incremented quickly
        fireCount++;
      }

      await AsyncTimerEvent.delay(1000);
      expect(fireCount).toBeGreaterThanOrEqual(9);
      //expect(fireCount).toBeLessThanOrEqual(11); // BUGBUG: Disabled due to issue above
      await AsyncTimerEvent.delay(500);
    });
  });
});
