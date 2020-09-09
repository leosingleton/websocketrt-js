using Xunit;

namespace LeoSingleton.WebSocketRT.UnitTests
{
    public class MovingAverageTest
    {
        /// <summary>
        /// Tests the MovingAverage helper class
        /// </summary>
        [Fact]
        public void MovingAverage()
        {
            var ma = new MovingAverage(100, 3);
            Assert.Equal(100, ma.Value);

            ma.Record(50);
            Assert.Equal(75, ma.Value);

            ma.Record(150);
            Assert.Equal(100, ma.Value);

            ma.Record(250);
            Assert.Equal(150, ma.Value);
        }
    }
}
