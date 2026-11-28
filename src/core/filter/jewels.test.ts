import { describe, expect, it } from 'vitest';
import { FAMILIES } from '../../meta/families.ts';
import { evaluateRules, type PreviewItem } from '../preview/match.ts';
import { compileFilter } from './generate.ts';
import { STRICTNESS_ORDER } from './presets.ts';

const ABYSS_EYE: Record<string, string> = {
  caster: 'Hypnotic Eye Jewel',
  minion: 'Ghastly Eye Jewel',
  melee: 'Murderous Eye Jewel',
  bow: 'Searching Eye Jewel',
  hybrid: 'Searching Eye Jewel',
};

const ABYSS_EYES = [...new Set(Object.values(ABYSS_EYE))].sort();

describe('jewel coverage', () => {
  for (const family of FAMILIES) {
    it(`shows cluster jewels and the ${family.id} abyss eye`, () => {
      for (const strictness of STRICTNESS_ORDER) {
        const rules = compileFilter({
          selection: { mode: 'family', familyId: family.id },
          phase: 'endgame',
          strictness,
        }).rules;

        const cluster = rules.find((rule) => rule.comment === 'Cluster jewels');
        expect(cluster?.action, family.id).toBe('Show');
        expect(cluster?.baseTypes, family.id).toEqual([
          'Large Cluster Jewel',
          'Medium Cluster Jewel',
          'Small Cluster Jewel',
        ]);
        expect(cluster?.rarity, family.id).toBeUndefined();

        const abyss = rules.find((rule) =>
          rule.comment?.startsWith('Abyss jewels'),
        );
        expect(abyss?.baseTypes, family.id).toEqual([ABYSS_EYE[family.id]]);
        expect(abyss?.rarity, family.id).toBeUndefined();

        const all = rules.find(
          (rule) => rule.comment === 'Abyss jewels - all families',
        );
        if (strictness === 'soft') {
          expect(all?.action, family.id).toBe('Show');
          expect(all?.baseTypes, family.id).toEqual(
            ABYSS_EYES.filter((base) => base !== ABYSS_EYE[family.id]),
          );
          expect(all?.rarity, family.id).toBeUndefined();
        } else {
          expect(all, family.id).toBeUndefined();
        }
      }
    });
  }

  it('shows the same jewels for an ascendancy', () => {
    const rules = compileFilter({
      selection: { mode: 'ascendancy', ascendancyId: 'necromancer' },
      phase: 'leveling',
      strictness: 'soft',
    }).rules;
    const abyss = rules.find((rule) => rule.comment?.startsWith('Abyss jewels'));
    expect(abyss?.baseTypes).toEqual(['Ghastly Eye Jewel']);
    const all = rules.find(
      (rule) => rule.comment === 'Abyss jewels - all families',
    );
    expect(all?.baseTypes).toEqual(
      ABYSS_EYES.filter((base) => base !== 'Ghastly Eye Jewel'),
    );
  });

  it('shows every abyss eye in soft and only the family eye in strict', () => {
    const selection = { mode: 'family', familyId: 'caster' } as const;
    const soft = compileFilter({
      selection,
      phase: 'endgame',
      strictness: 'soft',
    });
    const strict = compileFilter({
      selection,
      phase: 'endgame',
      strictness: 'strict',
    });
    const item = (baseType: string): PreviewItem => ({
      id: baseType,
      name: baseType,
      itemClass: 'Abyss Jewels',
      baseType,
      rarity: 'Rare',
      itemLevel: 83,
    });

    for (const base of ABYSS_EYES) {
      expect(evaluateRules(soft.rules, item(base)).shown, base).toBe(true);
      expect(evaluateRules(strict.rules, item(base)).shown, base).toBe(
        base === 'Hypnotic Eye Jewel',
      );
    }
  });
});
