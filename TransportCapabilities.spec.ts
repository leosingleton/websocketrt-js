import { TransportCapabilities, TransportCapabilities1 } from './TransportCapabilities';

describe("TransportCapabilties", () => {

  it("Tests the TransportCapabilties.Negotiate function", () => {
    let caps1 = new TransportCapabilities();
    caps1.majorVersion = 2;
    caps1.minorVersion = 5;
    caps1.capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.Capabilities2;

    let caps2 = new TransportCapabilities();
    caps2.majorVersion = 3;
    caps2.minorVersion = 0;
    caps2.capabilities1 = TransportCapabilities1.Capabilities | TransportCapabilities1.CancelMessage;

    let caps3 = TransportCapabilities.negotiate(caps1, caps2);
    expect(caps3.majorVersion).toEqual(2);
    expect(caps3.minorVersion).toEqual(5);
    expect(caps3.capabilities1).toEqual(TransportCapabilities1.Capabilities);
  });

});
