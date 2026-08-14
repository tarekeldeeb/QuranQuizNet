import { buildMistakeRecord } from '../mistakes';
import { makeEmptyQO, Q_TYPE } from '../questionnaire';

describe('buildMistakeRecord', () => {
  it('computes correct words and errorWords ranges for round 0 with oLen 2', () => {
    const qo = makeEmptyQO();
    qo.qLen = 3;
    qo.oLen = 2;
    qo.qType = Q_TYPE.NOTSPECIAL;

    const mistake = buildMistakeRecord({
      id: '0-0',
      qo,
      round: 0,
      wordOffset: 1,
      aya: 1,
      suraNum: 1,
      hideTitle: true,
      pickedText: 'الرحمن',
      correctText: 'الرحيم',
    });

    expect(mistake.isQuranText).toBe(true);
    expect(mistake.words).toBe('1-5'); // errorStart = 1 + 3 + 0*2 = 4, errorEnd = 4 + 2 - 1 = 5
    expect(mistake.errorWords).toBe('4-5');
    expect(mistake.id).toBe('0-0');
    expect(mistake.suraNum).toBe(1);
    expect(mistake.aya).toBe(1);
    expect(mistake.hideTitle).toBe(true);
    expect(mistake.pickedText).toBe('الرحمن');
    expect(mistake.correctText).toBe('الرحيم');
  });

  it('computes correct words and errorWords ranges for a later round', () => {
    const qo = makeEmptyQO();
    qo.qLen = 3;
    qo.oLen = 2;
    qo.qType = Q_TYPE.NOTSPECIAL;

    const mistake = buildMistakeRecord({
      id: '2-3',
      qo,
      round: 3,
      wordOffset: 5,
      aya: 10,
      suraNum: 2,
      hideTitle: false,
      pickedText: 'خيار خطأ',
      correctText: 'خيار صواب',
    });

    // errorStart = 5 + 3 + 3*2 = 14
    // errorEnd = 14 + 2 - 1 = 15
    // words = "5-15"
    // errorWords = "14-15"
    expect(mistake.isQuranText).toBe(true);
    expect(mistake.words).toBe('5-15');
    expect(mistake.errorWords).toBe('14-15');
  });

  it('supports oLen 1 vs oLen 2', () => {
    const qo1 = makeEmptyQO();
    qo1.qLen = 4;
    qo1.oLen = 1;
    qo1.qType = Q_TYPE.NOTSPECIAL;

    const mistake1 = buildMistakeRecord({
      id: '1-0',
      qo: qo1,
      round: 0,
      wordOffset: 2,
      aya: 5,
      suraNum: 3,
      hideTitle: true,
      pickedText: '',
      correctText: 'كلمة',
    });

    // errorStart = 2 + 4 + 0*1 = 6
    // errorEnd = 6 + 1 - 1 = 6
    expect(mistake1.words).toBe('2-6');
    expect(mistake1.errorWords).toBe('6-6');

    const qo2 = makeEmptyQO();
    qo2.qLen = 4;
    qo2.oLen = 2;
    qo2.qType = Q_TYPE.NOTSPECIAL;

    const mistake2 = buildMistakeRecord({
      id: '1-0',
      qo: qo2,
      round: 0,
      wordOffset: 2,
      aya: 5,
      suraNum: 3,
      hideTitle: true,
      pickedText: '',
      correctText: 'كلمتان هنا',
    });

    // errorStart = 2 + 4 + 0*2 = 6
    // errorEnd = 6 + 2 - 1 = 7
    expect(mistake2.words).toBe('2-7');
    expect(mistake2.errorWords).toBe('6-7');
  });

  it('sets isQuranText true for Q_TYPE.NOTSPECIAL and false for special question types', () => {
    const qoNormal = makeEmptyQO();
    qoNormal.qType = Q_TYPE.NOTSPECIAL;
    const mistakeNormal = buildMistakeRecord({
      id: '0-0',
      qo: qoNormal,
      round: 0,
      wordOffset: 1,
      aya: 1,
      suraNum: 1,
      hideTitle: true,
      pickedText: '',
      correctText: '',
    });
    expect(mistakeNormal.isQuranText).toBe(true);

    const qoSpecial = makeEmptyQO();
    qoSpecial.qType = Q_TYPE.SURANAME;
    const mistakeSpecial = buildMistakeRecord({
      id: '0-0',
      qo: qoSpecial,
      round: 0,
      wordOffset: 1,
      aya: 1,
      suraNum: 1,
      hideTitle: true,
      pickedText: 'البقرة',
      correctText: 'آل عمران',
    });
    expect(mistakeSpecial.isQuranText).toBe(false);

    const qoAyahNumber = makeEmptyQO();
    qoAyahNumber.qType = Q_TYPE.AYANUMBER;
    const mistakeAyah = buildMistakeRecord({
      id: '0-0',
      qo: qoAyahNumber,
      round: 0,
      wordOffset: 1,
      aya: 1,
      suraNum: 1,
      hideTitle: true,
      pickedText: '5',
      correctText: '7',
    });
    expect(mistakeAyah.isQuranText).toBe(false);
  });

  it('ensures errorWords always falls inside words', () => {
    for (let round = 0; round < 10; round++) {
      for (const oLen of [1, 2, 3]) {
        for (const qLen of [1, 3, 5]) {
          const wordOffset = 4;
          const qo = makeEmptyQO();
          qo.qLen = qLen;
          qo.oLen = oLen;
          qo.qType = Q_TYPE.NOTSPECIAL;

          const mistake = buildMistakeRecord({
            id: `test-${round}`,
            qo,
            round,
            wordOffset,
            aya: 1,
            suraNum: 1,
            hideTitle: true,
            pickedText: '',
            correctText: '',
          });

          const [wStart, wEnd] = mistake.words.split('-').map(Number);
          const [eStart, eEnd] = mistake.errorWords.split('-').map(Number);

          expect(wStart).toBe(wordOffset);
          expect(eStart).toBeGreaterThanOrEqual(wStart);
          expect(eEnd).toBe(wEnd);
          expect(eStart).toBeLessThanOrEqual(eEnd);
        }
      }
    }
  });
});
