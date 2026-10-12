// Focus timing specs, using the exact data quran.com's API returns for the
// reported ayat: tajweed markup from the page, word segments per recording.
import { describe, expect, it } from 'vitest';
import type { Box } from './mushaf';
import { beats, opensWithHeldIdgham } from './tajweed';
import { type TimedWord, buildKeyframes, retimeHeldStarts, sample } from './timeline';

const MARKUP: Record<string, string> = {
  '83:3:3': 'أَو',
  '83:3:4': 'وَّزَنُوهُمۡ',
  '83:4:4': 'أَ<rule class=ghunnah>نّ</rule>َه<rule class=idgham_shafawi>ُم</rule>',
  '83:4:5': '<rule class=idgham_shafawi>م</rule>َّ<rule class=qalaqah>بۡ</rule>عُوث<rule class=madda_permissible>ُو</rule>نَ',
};
const spokenOf = (key: string) =>
  MARKUP[key] === undefined ? undefined : { beats: beats(MARKUP[key]), heldStart: opensWithHeldIdgham(MARKUP[key]) };

// Page 587: أَنَّهُم ends line 14, مَّبْعُوثُونَ (green mīm) opens line 15.
const LINE_14 = 14;
const LINE_15 = 15;
const BOXES: Record<string, Box> = {
  '83:4:4': { l: 40, r: 120, cy: LINE_14 },
  '83:4:5': { l: 700, r: 840, cy: LINE_15 },
};

const focusAt = (words: TimedWord[], t: number) =>
  sample(
    buildKeyframes({
      words: retimeHeldStarts(words, spokenOf),
      timings: [],
      boxOf: (key) => BOXES[key],
      markerOf: () => undefined,
      mode: 'glide',
    }),
    t,
  );

describe('83:4 أَنَّهُم مَّبْعُوثُونَ (“the green letter is held at the start of the bottom line but the focus is still on the top line”)', () => {
  it('Afasy (streaming, id 173), whose segments count the held mīm (≈26.0–27.4 s) in أَنَّهُم: the focus is on line 15 while it is held', () => {
    const words = [
      { key: '83:4:4', start: 24544, end: 27307 },
      { key: '83:4:5', start: 27307, end: 28648 },
    ];
    expect(focusAt(words, 26600)?.y).toBe(LINE_15);
  });

  it('Afasy (id 7), whose segments already start مَّبْعُوثُونَ at the held mīm (≈26.14 s): the focus stays on line 14 through ـهُم and moves with the hold', () => {
    const words = [
      { key: '83:4:4', start: 24305, end: 26165 },
      { key: '83:4:5', start: 26165, end: 30000 },
    ];
    expect(focusAt(words, 25900)?.y).toBe(LINE_14);
    expect(focusAt(words, 26600)?.y).toBe(LINE_15);
  });
});

it('83:3 أَو وَّزَنُوهُمْ: a word opening with a shadda that is not a held ghunnah keeps its segment times', () => {
  const words = [
    { key: '83:3:3', start: 14935, end: 15225 },
    { key: '83:3:4', start: 15225, end: 16475 },
  ];
  expect(retimeHeldStarts(words, spokenOf)).toEqual(words);
});
