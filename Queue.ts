export class Queue<T> {
  public enqueue(value: T) {
    this._values.push(value);
  }

  public dequeue(): T | undefined {
    return this._values.shift();
  }

  public tryPeek(): T | undefined {
    return this._values[0];
  }

  public getCount(): number {
    return this._values.length;
  }

  public toArray(): T[] {
    return this._values;
  }

  private _values: T[] = [];
}
