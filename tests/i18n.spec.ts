import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createInstance } from 'i18next';
import { LANGUAGES_CONFIG } from '../src/i18n/detector';

function locale(language: string, namespace: string): Record<string, string> {
  return JSON.parse(readFileSync(`src/i18n/locales/${language}/${namespace}.json`, 'utf8'));
}

for (const namespace of ['common', 'exporter']) {
  test(`Korean ${namespace} has every source key and preserves interpolation`, () => {
    const en = locale('en', namespace);
    const ko = locale('ko', namespace);
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(ko[key]?.trim(), key).toBeTruthy();
      expect((ko[key]?.match(/\{\{[^}]+\}\}/g) ?? []).sort(), key).toEqual(
        (en[key]?.match(/\{\{[^}]+\}\}/g) ?? []).sort(),
      );
    }
  });
}

test('Korean language registration accepts regional tags without matching other languages', () => {
  expect(LANGUAGES_CONFIG.ko.name).toBe('한국어');
  for (const code of ['ko', 'ko-KR', 'ko-kr', 'KO-KR'])
    expect(LANGUAGES_CONFIG.ko.test(code)).toBe(true);
  for (const code of ['en-US', 'ja', 'kok-IN']) expect(LANGUAGES_CONFIG.ko.test(code)).toBe(false);
});
test('Korean regional locale resolves translated labels and interpolated counters', async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: 'ko-KR',
    fallbackLng: 'en',
    defaultNS: 'common',
    nsSeparator: '::',
    resources: {
      en: { common: locale('en', 'common'), exporter: locale('en', 'exporter') },
      ko: { common: locale('ko', 'common'), exporter: locale('ko', 'exporter') },
    },
  });
  expect(i18n.t('Settings')).toBe('설정');
  expect(i18n.t('A - B of N items', { from: 1, to: 10, total: 25 })).toBe('전체 25개 중 1–10개');
  expect(i18n.getFixedT(null, 'exporter')('Start Export')).toBe('내보내기 시작');
});
