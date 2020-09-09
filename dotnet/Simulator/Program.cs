using Nito.AsyncEx;
using System;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace LeoSingleton.WebSocketRT.Simulator
{
    class Program
    {
        static void Main(string[] args)
        {
            if (args.Length >= 1)
            {
                var app = args[0];
                if (app.Equals("/LOCAL", StringComparison.InvariantCultureIgnoreCase))
                {
                    Local();
                    return;
                }
                if (app.Equals("/CLIENT", StringComparison.InvariantCultureIgnoreCase))
                {
                    if (args.Length >= 4 && (args.Length - 2) % 3 == 0)
                    {
                        var server = args[1];
                        var messageCount = (args.Length - 2) / 3;
                        var messages = new SimulatedMessage[messageCount];
                        for (int n = 0; n < messageCount; n++)
                        {
                            messages[n] = new SimulatedMessage()
                            {
                                Priority = int.Parse(args[(n * 3) + 2]),
                                MessageSize = int.Parse(args[(n * 3) + 3]),
                                SecondsDelay = int.Parse(args[(n * 3) + 4])
                            };
                        }

                        Task.Run(async () => { await Client(server, messages); }).Wait();
                    }
                }
            }

            Console.Error.WriteLine("Usage:");
            Console.Error.WriteLine("Simulator.exe /LOCAL");
            Console.Error.WriteLine("Simulator.exe /CLIENT wss://hostname/path <priority> <messageSize> <secondsDelay> " +
                "[<priority> <size> <seconds>...]");
        }

        private class SimulatedMessage
        {
            public int Priority;
            public int MessageSize;
            public int SecondsDelay;
        }

        static async Task Client(string server, SimulatedMessage[] messages)
        {
            var ws = new ClientWebSocket();
            await ws.ConnectAsync(new Uri(server), CancellationToken.None);
            var c = new Connection(new WSFramedSocket(ws));
            c.RegisterCallback(OnMessageReceived);
            c.BeginDispatch();
            var cLock = new AsyncLock();

            foreach (var msg in messages)
            {
                var unused = Task.Run(async () =>
                {
                    while (true)
                    {
                        var m = new Message(msg.MessageSize);
                        FramedSocketSimulator.FillBufferWithTestPattern(m.Payload);
                        using (await cLock.LockAsync())
                        {
                            await c.Send(m, msg.Priority);
                        }

                        await Task.Delay(msg.SecondsDelay * 1000);
                    }
                });
            }

            while (true)
            {
                Console.WriteLine("rtt={0} outThroughput={1} inThroughput={3}", c.RttEstimate,
                    c.OutboundThroughputEstimate, c.InboundThroughputEstimate);
                await Task.Delay(1000);
            }
        }

        static void Local()
        {
            var sim = new FramedSocketSimulator(250, 256 * 1024);
            var c1 = new Connection(sim.Socket1);
            c1.RegisterCallback(OnMessageReceived);
            c1.BeginDispatch();
            var c2 = new Connection(sim.Socket2);
            c2.RegisterCallback(OnMessageReceived);
            c2.BeginDispatch();

            while (true)
            {
                Task.Run(async () =>
                {
                    Console.WriteLine("Connection1: rtt={0} throughput={1}", c1.RttEstimate,
                        c1.OutboundThroughputEstimate);
                    Console.WriteLine("Connection2: rtt={0} throughput={1}", c2.RttEstimate,
                        c2.OutboundThroughputEstimate);

                    var message = new Message(128 * 1024);
                    FramedSocketSimulator.FillBufferWithTestPattern(message.Payload);
                    Console.WriteLine("Sending {0} bytes", message.Payload.Length);
                    await c1.Send(message, 0);
                }).Wait();

                Thread.Sleep(1000);
            }
        }

        static void OnMessageReceived(Message message, MessageCallbackEvents events)
        {
            Console.WriteLine("Received {0} bytes", message.Payload.Length);

            // Validate payload test pattern
            var validated = FramedSocketSimulator.ValidateBufferTestPattern(message.Payload);
            Console.WriteLine("Message validated: {0}", validated);
        }
    }
}
