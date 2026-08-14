import { QuestionObject, Q_TYPE } from './questionnaire';

export interface MistakeRecord {
  id: string;
  isQuranText: boolean;
  suraNum: number;   // 1-based
  aya: number;
  words: string;     // "start-end", passed to QuranText's `words`
  errorWords: string; // "start-end", passed to QuranText's `error`
  hideTitle: boolean;
  pickedText: string; // may be ''
  correctText: string;
}

export function buildMistakeRecord(params: {
  id: string;
  qo: QuestionObject;
  round: number;
  wordOffset: number;
  aya: number;
  suraNum: number;
  hideTitle: boolean;
  pickedText: string;
  correctText: string;
}): MistakeRecord {
  const isQuranText = params.qo.qType.id === Q_TYPE.NOTSPECIAL.id;
  const errorStart = params.wordOffset + params.qo.qLen + params.round * params.qo.oLen;
  const errorEnd = errorStart + params.qo.oLen - 1;
  const words = `${params.wordOffset}-${errorEnd}`;
  const errorWords = `${errorStart}-${errorEnd}`;

  return {
    id: params.id,
    isQuranText,
    suraNum: params.suraNum,
    aya: params.aya,
    words,
    errorWords,
    hideTitle: params.hideTitle,
    pickedText: params.pickedText,
    correctText: params.correctText,
  };
}
