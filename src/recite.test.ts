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

describe('align: skipped ayat', () => {
  // Al-Mulk 67:1–4, as a recogniser writes it.
  const ayat = [
    'تبارك الذي بيده الملك وهو على كل شيء قدير',
    'الذي خلق الموت والحياة ليبلوكم ايكم احسن عملا وهو العزيز الغفور',
    'الذي خلق سبع سماوات طباقا ما ترى في خلق الرحمن من تفاوت فارجع البصر هل ترى من فطور',
    'ثم ارجع البصر كرتين ينقلب اليك البصر خاسئا وهو حسير',
  ];
  const expected = tokenize(ayat.join(' '));
  const start = (ayah: number) => tokenize(ayat.slice(0, ayah).join(' ')).length;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);
  const judged = (statuses: Map<number, string>, status: string) =>
    [...statuses].filter(([, s]) => s === status).map(([i]) => i);

  it('marks a whole skipped ayah as missed and follows on from where the reciter picked up', () => {
    const { cursor, statuses } = align(expected, 0, tokenize(`${ayat[0]} ${ayat[1]} ${ayat[3]}`));
    expect(judged(statuses, 'missed')).toEqual(range(start(2), start(3)));
    expect(judged(statuses, 'wrong')).toEqual([]);
    expect(cursor).toBe(expected.length);
  });

  it('puts the skip on the ayah that was left out when the next one opens with the same words', () => {
    // 67:2 and 67:3 both open with الذي خلق; the reciter went from 67:1 to 67:3.
    const { cursor, statuses } = align(expected, 0, tokenize(`${ayat[0]} ${ayat[2]}`));
    expect(judged(statuses, 'missed')).toEqual(range(start(1), start(2)));
    expect(judged(statuses, 'wrong')).toEqual([]);
    expect(cursor).toBe(start(3));
  });

  it('waits for more words instead of calling the first word after a skip wrong', () => {
    const { cursor, statuses } = align(expected, 0, tokenize(`${ayat[0]} ثم ارجع`));
    expect(judged(statuses, 'wrong')).toEqual([]);
    expect(judged(statuses, 'missed')).toEqual([]);
    expect(cursor).toBe(start(1));
  });

  it('still judges a word said differently once the reciter moves on', () => {
    const { statuses } = align(expected, 0, tokenize('تبارك الذي بيده الحمد وهو على كل شيء قدير'));
    expect(judged(statuses, 'wrong')).toEqual([3]);
    expect(judged(statuses, 'missed')).toEqual([]);
  });
});
