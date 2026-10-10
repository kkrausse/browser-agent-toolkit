import { renderToString } from 'react-dom/server';
import type { ReactNode } from 'react';

enum Tone { Plain = 'plain', Loud = 'loud' }
interface Props { tone: Tone; children?: ReactNode }

function Label({ tone, children }: Props) {
  return <span className={tone}>{children}</span>;
}

export class Counter {
  private count = 0;
  constructor(public readonly step: number = 1) {}
  next(): number { return (this.count += this.step); }
}

export const html: string = renderToString(
  <>
    <Label tone={Tone.Loud}>{new Counter(2).next()} todos</Label>
  </>,
);
