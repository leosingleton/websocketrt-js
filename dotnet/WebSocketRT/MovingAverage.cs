using System.Collections.Generic;

namespace LeoSingleton.WebSocketRT
{
    /// <summary>
    /// Calculates a moving average of a set of longs
    /// </summary>
    internal class MovingAverage
    {
        public MovingAverage(long initialValue, int maxValues)
        {
            _MaxValues = maxValues;
            _Values = new Queue<long>();
            Record(initialValue);
        }

        public void Record(long value)
        {
            lock (_Values)
            {
                _Values.Enqueue(value);
                _Sum += value;

                if (_Values.Count > _MaxValues)
                {
                    long oldValue = _Values.Dequeue();
                    _Sum -= oldValue;
                }

                _Average = _Sum / _Values.Count;
            }
        }

        public long Value
        {
            get { return _Average; }
        }

        private int _MaxValues;
        private Queue<long> _Values;
        private long _Sum;
        private long _Average;
    }
}
