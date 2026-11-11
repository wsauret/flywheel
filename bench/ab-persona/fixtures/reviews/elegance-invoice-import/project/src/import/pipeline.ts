/** A typed chain of transformation stages. Each stage receives the previous
 *  stage's output, and the compiler checks that adjacent stages fit. */
export class Pipeline<TIn, TOut> {
  private constructor(private readonly execute: (input: TIn) => TOut) {}

  static from<TIn, TOut>(first: (input: TIn) => TOut): Pipeline<TIn, TOut> {
    return new Pipeline(first);
  }

  then<TNext>(stage: (value: TOut) => TNext): Pipeline<TIn, TNext> {
    return new Pipeline((input: TIn) => stage(this.execute(input)));
  }

  run(input: TIn): TOut {
    return this.execute(input);
  }
}
