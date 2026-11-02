import { describe, expect, it } from 'vitest';
import { align, joinResults, tokenize } from './recite';

const final = (transcript: string) => ({ transcript, isFinal: true });
const interim = (transcript: string) => ({ transcript, isFinal: false });

describe('joinResults', () => {
  it('appends results that each hold their own stretch of speech (desktop)', () => {
    expect(joinResults([final('قل هو الله'), final(' احد الله الصمد'), interim(' لم يلد')])).toEqual({
      final: 'قل هو الله احد الله الصمد',
      interim: 'لم يلد',
    });
  });

  it('keeps one copy when each result repeats the session so far (Chrome on Android)', () => {
    const results = [
      final('قل هو الله احد'),
      final('قل هو الله احد الله الصمد'),
      final('قل هو الله احد الله الصمد لم يلد ولم يولد'),
      interim('قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن'),
    ];
    expect(joinResults(results)).toEqual({
      final: 'قل هو الله احد الله الصمد لم يلد ولم يولد',
      interim: 'ولم يكن',
    });
  });

  it('accepts a repeat in which the recogniser revised an earlier word', () => {
    const results = [final('قل هو الله احد الله الصمد'), final('قل هو الله واحد الله الصمد لم يلد')];
    expect(joinResults(results).final).toBe('قل هو الله واحد الله الصمد لم يلد');
  });

  it('lets Android-style results align without mistakes', () => {
    const expected = tokenize('قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد');
    const results = [
      final('قل هو الله احد'),
      final('قل هو الله احد الله الصمد'),
      final('قل هو الله احد الله الصمد لم يلد ولم يولد'),
    ];
    const { cursor, statuses } = align(expected, 0, tokenize(joinResults(results).final));
    expect(cursor).toBe(10);
    expect([...statuses.values()].every((s) => s === 'ok')).toBe(true);
  });
});
