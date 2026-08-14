import React from 'react';
import { render } from '@testing-library/react-native';
import MistakesReview from '../MistakesReview';
import { MistakeRecord } from '../../models/mistakes';

describe('MistakesReview', () => {
  it('renders null when mistakes array is empty', () => {
    const { toJSON } = render(<MistakesReview mistakes={[]} />);
    expect(toJSON()).toBeNull();
  });

  it('renders rows for non-empty mistakes (mix of Quran and special question mistakes)', () => {
    const mistakes: MistakeRecord[] = [
      {
        id: '0-0',
        isQuranText: true,
        suraNum: 1,
        aya: 2,
        words: '1-5',
        errorWords: '4-5',
        hideTitle: true,
        pickedText: 'العالمين',
        correctText: 'الرحمن الرحيم',
      },
      {
        id: '1-0',
        isQuranText: false,
        suraNum: 2,
        aya: 255,
        words: '1-3',
        errorWords: '2-3',
        hideTitle: true,
        pickedText: 'آل عمران',
        correctText: 'البقرة',
      },
    ];

    const { getByText, getAllByText } = render(<MistakesReview mistakes={mistakes} />);

    // Header title
    expect(getByText(/أخطاء للمراجعة/)).toBeTruthy();

    // Check Sura captions and correct text
    expect(getByText(/الفاتحة/)).toBeTruthy();
    expect(getAllByText(/البقرة/).length).toBe(2); // In sura caption and in correctText

    // Check Quran mistake texts
    expect(getByText(/الرحمن الرحيم/)).toBeTruthy();
    expect(getByText(/العالمين/)).toBeTruthy();

    // Check special question mistake texts
    expect(getByText(/آل عمران/)).toBeTruthy();
  });
});
